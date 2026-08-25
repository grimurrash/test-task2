/**
 * Обвязка тестов: поднимает сервер на свободном порту и разговаривает с ним
 * по HTTP — не в обход слоя, а через него. Каждый ответ по дороге проверяется
 * против контракта (A7), поэтому забыть эту проверку в отдельном тесте нельзя.
 */
import type { AddressInfo } from 'node:net';
import { after } from 'node:test';

import { createServer, type AppDeps } from '../../src/app.js';
import type { Payment } from '../../src/domain/payment.js';
import { assertMatchesContract, requestBodyErrors, requestBodyValid } from './contract.js';

export interface TestClock {
  now(): number;
  advance(ms: number): void;
}

export function testClock(startMs = Date.parse('2026-08-25T12:00:00.000Z')): TestClock {
  let current = startMs;
  return {
    now: () => current,
    advance: (ms) => {
      current += ms;
    },
  };
}

export interface Response<T = unknown> {
  status: number;
  body: T;
  /** Сырой текст ответа — для сравнения повтора байт-в-байт (F2). */
  text: string;
  headers: Headers;
}

export interface ErrorBody {
  error: {
    code: string;
    message: string;
    details?: { errors?: Record<string, string>; status?: string };
  };
}

export interface CreateOptions {
  merchant?: string | null;
  key?: string | null;
  /** Готовое тело строкой — для битого JSON и для проверки порядка ключей. */
  rawBody?: string;
  contentType?: string | null;
}

export interface TestApp {
  url: string;
  create(body: unknown, options?: CreateOptions): Promise<Response>;
  getPayment(id: string, merchant?: string | null): Promise<Response>;
  cancel(id: string, merchant?: string | null): Promise<Response>;
  list(merchant?: string | null): Promise<Response>;
  raw(method: string, path: string, init?: RequestInit): Promise<Response>;
  close(): Promise<void>;
}

/**
 * Сверка вердиктов: схема запроса из контракта против валидации сервера.
 *
 * Свойство простое и жёсткое — **тело валидно по схеме тогда и только тогда,
 * когда сервер не ответил 422**. Проверяется на каждом создании платежа
 * во всех тестах, поэтому расхождение вроде #64 больше не может отсидеться:
 * его поймает первый же тест, отправивший такое тело.
 *
 * Ответы 400 из сверки исключены: они относятся к форме запроса (заголовки,
 * неразобранное тело), а не к полям, и схема о них ничего не говорит.
 */
function assertServerAgreesWithSchema(payload: string, status: number): void {
  if (status === 400) return;

  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return; // неразобранное тело — не вопрос схемы
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return;

  const validBySchema = requestBodyValid(parsed);
  const acceptedByServer = status !== 422;

  if (validBySchema === acceptedByServer) return;

  throw new Error(
    validBySchema
      ? `Сервер ответил 422 на тело, которое схема контракта считает валидным.\n` +
        `Тело: ${payload.slice(0, 400)}`
      : `Сервер принял тело (${String(status)}), которое схема контракта отвергает: ` +
        `${requestBodyErrors(parsed)}\nТело: ${payload.slice(0, 400)}`,
  );
}

export const MERCHANT = 'demo-shop';
export const OTHER_MERCHANT = 'other-shop';

/** Тело, проходящее валидацию: у платежа обычная сумма, значит статус pending. */
export function validBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    amount_minor: 125000,
    currency: 'RUB',
    order_id: 'order-2026-0825-0001',
    description: 'Подписка на тариф «Про», август',
    ...overrides,
  };
}

export interface StartOptions extends AppDeps {
  clock?: TestClock;
}

export async function startApp(options: StartOptions = {}): Promise<TestApp> {
  const { clock, ...deps } = options;
  const server = createServer({
    ...deps,
    ...(clock ? { now: () => clock.now() } : {}),
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}`;

  const close = () =>
    new Promise<void>((resolve, reject) => {
      // Без этого `close` ждёт keep-alive соединений, которые держит fetch,
      // и прогон повисает на каждом поднятом сервере.
      server.closeAllConnections();
      server.close((err) => (err ? reject(err) : resolve()));
    });

  after(() => close());

  async function send(
    route: string,
    method: string,
    path: string,
    init: RequestInit,
  ): Promise<Response> {
    const res = await fetch(`${url}${path}`, { ...init, method });
    const text = await res.text();
    let body: unknown = undefined;
    if (text.length > 0) {
      body = JSON.parse(text);
    }
    // A7: соответствие контракту проверяется на каждом ответе, который контракт
    // описывает. Ответы вне контракта (неизвестный маршрут, 5xx) проверяются
    // отдельными тестами по конверту 5.4.
    assertMatchesContract(route, method, res.status, body);
    return { status: res.status, body, text, headers: res.headers };
  }

  function headers(merchant: string | null | undefined, extra: Record<string, string> = {}) {
    const h: Record<string, string> = { ...extra };
    const value = merchant === undefined ? MERCHANT : merchant;
    if (value !== null) h['X-Merchant-Id'] = value;
    return h;
  }

  return {
    url,
    async create(body, options = {}) {
      const extra: Record<string, string> = {};
      const key = options.key === undefined ? cryptoKey() : options.key;
      if (key !== null) extra['Idempotency-Key'] = key;
      const contentType = options.contentType === undefined ? 'application/json' : options.contentType;
      if (contentType !== null) extra['Content-Type'] = contentType;

      const payload = options.rawBody ?? JSON.stringify(body);
      const response = await send('/v1/payments', 'POST', '/v1/payments', {
        headers: headers(options.merchant, extra),
        body: payload,
      });
      assertServerAgreesWithSchema(payload, response.status);
      return response;
    },
    getPayment(id, merchant) {
      return send('/v1/payments/{id}', 'GET', `/v1/payments/${encodeURIComponent(id)}`, {
        headers: headers(merchant),
      });
    },
    cancel(id, merchant) {
      return send(
        '/v1/payments/{id}/cancel',
        'POST',
        `/v1/payments/${encodeURIComponent(id)}/cancel`,
        { headers: headers(merchant) },
      );
    },
    list(merchant) {
      return send('/v1/payments', 'GET', '/v1/payments', { headers: headers(merchant) });
    },
    async raw(method, path, init = {}) {
      const res = await fetch(`${url}${path}`, { ...init, method });
      const text = await res.text();
      return {
        status: res.status,
        body: text.length > 0 ? JSON.parse(text) : undefined,
        text,
        headers: res.headers,
      };
    },
    close,
  };
}

let counter = 0;
export function cryptoKey(): string {
  counter += 1;
  return `key-${String(counter).padStart(6, '0')}-${Math.random().toString(36).slice(2, 10)}`;
}

export function asPayment(body: unknown): Payment {
  return body as Payment;
}

export function asError(body: unknown): ErrorBody {
  return body as ErrorBody;
}

/**
 * Фиксация, которая по-настоящему уступает цикл событий.
 *
 * В памяти сохранение мгновенно, и между проверкой ключа и записью платежа
 * не возникает ни одной уступки — а значит, не возникает и самой гонки:
 * наивная реализация «проверил — записал» проходит такой тест, ничего не
 * доказывая. Проверено мутацией. Настоящая фиксация (диск, сеть, транзакция)
 * уступает всегда, поэтому тест на гонку обязан моделировать именно её.
 */
export function yieldingCommit(): () => Promise<void> {
  return () => new Promise<void>((resolve) => setImmediate(resolve));
}

/**
 * Ожидание с потолком. Реализация, у которой бронь ключа не атомарна, не
 * отвечает на второй запрос отказом, а уходит в ту же фиксацию и повисает
 * на барьере. Без этого потолка такой дефект выглядел бы зависшим прогоном,
 * а не красным тестом с внятной причиной.
 */
export async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  try {
    return await Promise.race([promise, guard]);
  } finally {
    clearTimeout(timer!);
  }
}

/**
 * Барьер для проверки состояния «первый запрос ещё в полёте». Без него это
 * состояние ненаблюдаемо, и тест на `request_in_progress` был бы декорацией.
 */
export function barrier(): { wait: () => Promise<void>; release: () => void; entered: Promise<void> } {
  let release!: () => void;
  let enter!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const entered = new Promise<void>((resolve) => (enter = resolve));
  return {
    wait: async () => {
      enter();
      await gate;
    },
    release: () => release(),
    entered,
  };
}
