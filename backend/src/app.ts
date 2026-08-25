/**
 * HTTP-слой на голом `node:http`.
 *
 * Почему без фреймворка: рантайм-зависимостей у сервиса нет ни одной, поэтому
 * в рантайм-слое образа `node_modules` пуст, и R3 («в рантайме нет
 * devDependencies») выполняется не аккуратностью сборки, а тем, что там нечего
 * оставить. Цена — маршрутизация, CORS и разбор тела написаны руками.
 */
import { randomBytes } from 'node:crypto';
import http from 'node:http';

import { ApiError, malformedRequest } from './domain/errors.js';
import type { Payment } from './domain/payment.js';
import {
  parseBody,
  requireIdempotencyKey,
  requireMerchantId,
  validateCreateBody,
} from './domain/validation.js';
import { PaymentService } from './service.js';
import { MemoryStore } from './store/memory-store.js';

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
/** Тело крупнее этого не разбирается: песочнице столько не нужно, а отказ дешевле. */
const MAX_BODY_BYTES = 1024 * 1024;
/**
 * До этого предела тело **дочитывается и отбрасывается**, чтобы ответ 400 дошёл
 * до клиента целым. Отвечать, пока клиент ещё грузит, HTTP/1.1 позволяет,
 * но браузер и `fetch` в этот момент пишут в сокет и получают обрыв вместо
 * ответа — то есть «сервис отверг» становится неотличимо от «сервис упал».
 * Выше предела соединение рвётся: дочитывание перестаёт быть вежливостью
 * и становится расходом канала по требованию клиента.
 */
const MAX_DRAIN_BYTES = 8 * 1024 * 1024;

export interface AppDeps {
  now?: () => number;
  ttlMs?: number;
  newId?: () => string;
  commit?: (payment: Payment) => Promise<void> | void;
}

const ID_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

function defaultNewId(): string {
  const bytes = randomBytes(12);
  let suffix = '';
  for (const byte of bytes) suffix += ID_ALPHABET[byte % ID_ALPHABET.length];
  return `pay_${suffix}`;
}

interface Route {
  kind: 'create' | 'list' | 'get' | 'cancel';
  id?: string;
}

/**
 * Битое процентное кодирование (`%zz`) — не повод для отказа сервера: такой
 * идентификатор просто не может существовать, и маршрут обязан дойти
 * до обычного 404. Раньше `decodeURIComponent` бросал прямо из разбора пути,
 * до проверки заголовков, — ответ выпадал из контракта и ломал порядок
 * проверок из #32. Находка ревью #47.
 */
function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** Разбор пути. Строка запроса и завершающая косая черта маршрут не меняют. */
function matchRoute(pathname: string, method: string): Route | { allow: string[] } | null {
  const trimmed = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;

  if (trimmed === '/v1/payments') {
    if (method === 'POST') return { kind: 'create' };
    if (method === 'GET') return { kind: 'list' };
    return { allow: ['GET', 'POST'] };
  }

  const cancel = /^\/v1\/payments\/([^/]+)\/cancel$/.exec(trimmed);
  if (cancel?.[1] !== undefined) {
    if (method === 'POST') return { kind: 'cancel', id: safeDecode(cancel[1]) };
    return { allow: ['POST'] };
  }

  const single = /^\/v1\/payments\/([^/]+)$/.exec(trimmed);
  if (single?.[1] !== undefined) {
    if (method === 'GET') return { kind: 'get', id: safeDecode(single[1]) };
    return { allow: ['GET'] };
  }

  return null;
}

/**
 * Чтение тела с пределом.
 *
 * Решение по находке ревью #47: превышение предела — это **ответ API**, а не
 * обрыв соединения. Раньше сокет рвался раньше, чем уходил уже сформированный
 * 400, и для песочницы это выглядело сетевой ошибкой: клиент не мог отличить
 * «сервис отверг запрос» от «сервис упал». Тот же довод, по которому CORS
 * обязателен на ответах 4xx, — иначе браузер показывает не отказ, а обрыв.
 *
 * Поэтому чтение прекращается, но соединение живёт до конца ответа; сокет
 * закрывается уже после того, как ответ ушёл (см. `res.on('finish')`).
 */
function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let overflow = false;
    const tooLarge = () =>
      malformedRequest(`тело запроса больше предела в ${String(MAX_BODY_BYTES)} байт`);

    req.on('data', (chunk: Buffer) => {
      size += chunk.length;

      if (!overflow && size > MAX_BODY_BYTES) {
        overflow = true;
        chunks.length = 0; // память освобождается сразу, копить незачем
      }

      if (overflow) {
        if (size > MAX_DRAIN_BYTES) {
          // За этой чертой дочитывание перестаёт быть вежливостью и становится
          // расходом канала по требованию клиента. Здесь — и только здесь —
          // соединение рвётся; граница названа в ответе проджекту и в README.
          req.destroy();
          reject(tooLarge());
        }
        return;
      }

      chunks.push(chunk);
    });

    req.on('end', () => {
      if (overflow) reject(tooLarge());
      else resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', reject);
  });
}

export function createServer(deps: AppDeps = {}): http.Server {
  const now = deps.now ?? (() => Date.now());
  const store = new MemoryStore({ now, ttlMs: deps.ttlMs ?? DEFAULT_TTL_MS });
  const service = new PaymentService(store, {
    now,
    newId: deps.newId ?? defaultNewId,
    commit: deps.commit ?? (() => undefined),
  });

  function send(res: http.ServerResponse, status: number, body: unknown, extra: http.OutgoingHttpHeaders = {}): void {
    const payload = body === undefined ? '' : JSON.stringify(body);
    res.writeHead(status, {
      // Песочница живёт на соседнем origin (8081), поэтому CORS открыт —
      // включая заголовки идемпотентности и мерчанта, без которых браузер
      // отсечёт запрос ещё до сервера.
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Idempotency-Key, X-Merchant-Id',
      'Access-Control-Max-Age': '86400',
      'Cache-Control': 'no-store',
      ...(payload.length > 0 ? { 'Content-Type': 'application/json; charset=utf-8' } : {}),
      ...extra,
    });
    res.end(payload);
  }

  const server = http.createServer((req, res) => {
    // Недочитанный запрос закрывается только после того, как ответ ушёл:
    // порядок обратный рвёт соединение раньше ответа, и клиент видит обрыв
    // вместо отказа API. Находка ревью #47 на теле сверх предела.
    res.on('finish', () => {
      if (!req.readableEnded) req.destroy();
    });

    void handle(req, res).catch((error: unknown) => {
      // Контракт объявляет 5xx своей границей: формат тела не гарантируется.
      // Конверт 5.4 держим всё равно — клиенту от «границы контракта» не легче.
      console.error('Необработанный отказ:', error);
      if (!res.headersSent) {
        send(res, 500, {
          error: { code: 'internal_error', message: 'Внутренняя ошибка сервиса' },
        });
      } else {
        res.end();
      }
    });
  });

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const method = req.method ?? 'GET';
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;

    if (method === 'OPTIONS') {
      send(res, 204, undefined);
      return;
    }

    const route = matchRoute(pathname, method);
    if (route === null) {
      send(res, 404, { error: { code: 'not_found', message: 'Маршрут не найден' } });
      return;
    }
    if ('allow' in route) {
      send(
        res,
        405,
        { error: { code: 'method_not_allowed', message: `Метод ${method} здесь не поддерживается` } },
        { Allow: route.allow.join(', ') },
      );
      return;
    }

    try {
      // Пробел D ревью контракта: порядок проверок контрактом не задан.
      // Заголовки проверяются раньше тела, мерчант — раньше ключа.
      const merchantId = requireMerchantId(req.headers['x-merchant-id']);

      switch (route.kind) {
        case 'create': {
          const key = requireIdempotencyKey(req.headers['idempotency-key']);
          const raw = await readBody(req);
          const command = validateCreateBody(parseBody(raw, req.headers['content-type']));
          const result = await service.create(merchantId, key, command);
          send(res, result.status, result.payment);
          return;
        }
        case 'get':
          send(res, 200, service.get(merchantId, route.id ?? ''));
          return;
        case 'cancel':
          send(res, 200, service.cancel(merchantId, route.id ?? ''));
          return;
        case 'list':
          send(res, 200, service.list(merchantId));
          return;
      }
    } catch (error) {
      if (error instanceof ApiError) {
        send(res, error.status, error.body());
        return;
      }
      throw error;
    }
  }

  return server;
}
