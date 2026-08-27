// raw-http-client: allowed — значение заголовка вне ASCII через `fetch`
// не отправить (символ выше 255 он не пропускает вовсе), а сверка с контрактом
// требует именно таких проб: F7c обещает ключу любую письменность.
/**
 * A7 для заголовков — место, куда контрактная сверка не доставала.
 *
 * Обвязка проверяет тела запросов и все ответы. Заголовки не сверял никто:
 * схемы `IdempotencyKey`, `XMerchantId` и `PaymentId` — с границами длины
 * и набором символов — через валидатор не проходили ни разу. Цена измерена,
 * а не предположена: REPORT 4.13 — ветка с **прежним** контрактом дала
 * 232 из 232 зелёных, включая четыре теста, которые тот контракт запрещал.
 * Формулировка автора находки: «тесты защищают код от изменений кода,
 * но не от изменений контракта».
 *
 * Здесь у каждой пробы две линзы:
 *
 *   контракт — валидна ли она по схеме параметра (тот же ajv, что и везде);
 *   код      — отверг ли сервер запрос отказом по форме ЭТОГО параметра.
 *
 * Свойство жёсткое и двустороннее: **проба валидна по контракту тогда
 * и только тогда, когда сервер её не отверг**. Расхождение в любую сторону —
 * красный тест: и «код принял то, что контракт запрещает», и «код отверг то,
 * что контракт разрешает».
 *
 * Две тонкости, без которых сверка врёт (находки ревью плана):
 *
 * 1. Проба — **логическая строка**. На провод она уходит как
 *    `latin1(utf8(проба))`, потому что так её шлёт curl и любой честный клиент;
 *    сервер декодирует обратно. Линза контракта работает по логической строке —
 *    иначе «255 кириллических» превратились бы в 510 символов и дали ложный
 *    красный, а при обратной ошибке проба выродилась бы в однобайтную
 *    и молча перестала охранять починку #75.
 * 2. Пробы, которые **меняет сам транспорт**, из свойства выведены: HTTP
 *    срезает пробелы вокруг значения (OWS), и до сервера доезжает не то, что
 *    отправлено. Они проверяются отдельным тестом ниже, по имени.
 */
import assert from 'node:assert/strict';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { after, describe, it } from 'node:test';

import { createServer } from '../src/app.js';
import { matchesSchema, parameterSchemaPointer } from './support/contract.js';

interface RawResponse {
  status: number;
  body: { error?: { code?: string } } | undefined;
}

interface Probe {
  /** Логическое значение — то, что клиент считает своим значением. */
  value: string;
  /** Зачем проба здесь: попадает в сообщение об ошибке. */
  why: string;
}

/** Коды, которыми сервер отказывает по форме конкретного параметра. */
const REJECTION_CODES: Record<string, string[]> = {
  IdempotencyKey: ['invalid_idempotency_key', 'idempotency_key_required'],
  XMerchantId: ['invalid_merchant_id', 'merchant_id_required'],
  // Отказа по форме идентификатора пути в API нет вовсе: несуществующий
  // платёж — это 404, а не 400. Если контракт когда-нибудь сузит `PaymentId`,
  // проба это покажет: контракт запретит, код примет, линзы разойдутся.
  PaymentId: [],
};

const VALID_BODY = JSON.stringify({
  amount_minor: 125000,
  currency: 'RUB',
  order_id: 'contract-headers-probe',
  description: 'проба сверки заголовков',
});

/**
 * Тело без `Content-Length` приходит частями с шестнадцатеричными размерами:
 * ответы сервиса идут `Transfer-Encoding: chunked`. Без разбора кусков тело
 * не разбирается в JSON, код ошибки не виден — и сверка тихо считает, что
 * сервер ничего не отверг. Ровно так этот файл соврал на первом прогоне.
 */
function dechunk(body: Buffer): Buffer {
  const parts: Buffer[] = [];
  let rest = body;
  for (;;) {
    const eol = rest.indexOf('\r\n');
    if (eol < 0) break;
    const size = Number.parseInt(rest.subarray(0, eol).toString('latin1'), 16);
    if (!Number.isInteger(size) || size <= 0) break;
    parts.push(rest.subarray(eol + 2, eol + 2 + size));
    rest = rest.subarray(eol + 2 + size + 2);
  }
  return Buffer.concat(parts);
}

/**
 * Минимальный HTTP-клиент. Заголовки уходят байтами latin-1 — так их пишет
 * curl, и только так до сервера доезжает не-ASCII значение.
 */
function send(port: number, lines: string[], body: string): Promise<RawResponse> {
  return new Promise<RawResponse>((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    const received: Buffer[] = [];
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('сервер не ответил за 5 секунд'));
    }, 5000);

    socket.on('connect', () => {
      socket.write(
        Buffer.concat([
          Buffer.from(`${lines.join('\r\n')}\r\n\r\n`, 'latin1'),
          Buffer.from(body, 'utf8'),
        ]),
      );
    });
    socket.on('data', (chunk: Buffer) => received.push(chunk));
    socket.on('error', reject);
    socket.on('close', () => {
      clearTimeout(timer);
      const raw = Buffer.concat(received);
      const split = raw.indexOf('\r\n\r\n');
      const head = (split < 0 ? raw : raw.subarray(0, split)).toString('latin1');
      const rawBody = split < 0 ? Buffer.alloc(0) : raw.subarray(split + 4);
      const chunked = /transfer-encoding: *chunked/i.test(head);
      const text = (chunked ? dechunk(rawBody) : rawBody).toString('utf8');
      let parsed: RawResponse['body'];
      try {
        parsed = JSON.parse(text) as RawResponse['body'];
      } catch {
        parsed = undefined;
      }
      resolve({ status: Number(/HTTP\/1\.[01] (\d+)/.exec(head)?.[1] ?? 0), body: parsed });
    });
  });
}

/** Логическое значение → байты провода: `latin1(utf8(значение))`. */
function onWire(value: string): string {
  return Buffer.from(value, 'utf8').toString('latin1');
}

function startRawServer(): Promise<number> {
  const server = createServer({});
  after(() => {
    server.closeAllConnections();
    server.close();
  });
  return new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
  });
}

/** Отверг ли сервер запрос отказом по форме именно этого параметра. */
function rejectedByForm(parameter: string, res: RawResponse): boolean {
  if (res.status !== 400) return false;
  const code = res.body?.error?.code;
  return code !== undefined && REJECTION_CODES[parameter]?.includes(code) === true;
}

function report(parameter: string, probe: Probe, allowed: boolean, rejected: boolean): string {
  return (
    `Параметр ${parameter}, проба «${probe.why}» (${probe.value.length} симв.).\n` +
    (allowed
      ? '  Контракт РАЗРЕШАЕТ это значение, а код его ОТВЕРГ.\n' +
        '  Либо схема параметра шире поведения, либо поведение уже схемы.'
      : '  Контракт ЗАПРЕЩАЕТ это значение, а код его ПРИНЯЛ.\n' +
        '  Ровно так контракт молча расходится с кодом (REPORT 4.13).') +
    `\n  Схема: ${parameterSchemaPointer(parameter)}; отвергнут кодом: ${String(rejected)}.`
  );
}

const cyrillic = (n: number) => 'к'.repeat(n);

/** Ключ идемпотентности: набор символов не ограничен, длина — 255 (F7c, F21). */
const KEY_PROBES: Probe[] = [
  { value: 'k', why: 'один символ — нижняя граница' },
  { value: 'ordinary-key-2026', why: 'обычный ключ' },
  { value: 'a'.repeat(255), why: '255 латинских — верхняя граница' },
  { value: 'a'.repeat(256), why: '256 латинских — на символ выше границы' },
  { value: cyrillic(255), why: '255 кириллических — починка #75, требование F7c' },
  { value: cyrillic(256), why: '256 кириллических — выше границы' },
  { value: '', why: 'пустое значение' },
  // Запятая стоит ровно на расхождении PRD с контрактом: PRD:70 относит
  // «значения через запятую» к отклоняемым формам повтора, контракт называет
  // запятую законным символом ключа. Вопрос открыт и ведётся в #182; пробу
  // держим — она покраснеет, если контракт запретит запятую.
  { value: 'order-42,retry-1', why: 'запятая внутри значения (см. #182)' },
  { value: 'ключ-🙂', why: 'эмодзи: одна кодовая точка, две единицы UTF-16 (F21)' },
  { value: 'key/with/slashes', why: 'косые черты' },
  { value: 'key%zz', why: 'битое процентное кодирование' },
];

/** Мерчант: набор символов и длина ограничены контрактом и кодом (F7a). */
const MERCHANT_PROBES: Probe[] = [
  { value: 'demo-shop', why: 'демо-значение из контракта' },
  { value: 'a', why: 'один символ — нижняя граница' },
  { value: 'a'.repeat(64), why: '64 символа — верхняя граница' },
  { value: 'a'.repeat(65), why: '65 символов — выше границы' },
  { value: '', why: 'пустое значение' },
  { value: 'shop.name_1-2', why: 'весь разрешённый набор точек, подчёркиваний, дефисов' },
  { value: 'shop,other', why: 'запятая — вне набора' },
  { value: 'shop other', why: 'пробел внутри значения — вне набора' },
  { value: 'магазин', why: 'кириллица — вне набора' },
  { value: 'shop/other', why: 'косая черта — вне набора' },
];

/** Идентификатор платежа в пути: контракт не ограничивает его ничем. */
const PAYMENT_ID_PROBES: Probe[] = [
  { value: 'pay_7Jf3K9qT2mVb', why: 'идентификатор нашей формы' },
  { value: 'a'.repeat(300), why: '300 символов — контракт длину не ограничивает' },
  { value: 'кириллический-идентификатор', why: 'не-ASCII' },
  { value: 'id with space', why: 'пробел внутри — кодируется в пути' },
  { value: 'id/other', why: 'косая черта — кодируется в пути' },
];

describe('@req F7c @req F21 A7 · Idempotency-Key: контракт и код об одном значении', () => {
  for (const probe of KEY_PROBES) {
    it(`ключ «${probe.why}»: вердикт схемы совпадает с вердиктом сервера`, async () => {
      const port = await startRawServer();
      const allowed = matchesSchema(parameterSchemaPointer('IdempotencyKey'), probe.value);
      const res = await send(
        port,
        [
          'POST /v1/payments HTTP/1.1',
          `Host: 127.0.0.1:${String(port)}`,
          'Connection: close',
          'Content-Type: application/json',
          `Content-Length: ${String(Buffer.byteLength(VALID_BODY))}`,
          'X-Merchant-Id: demo-shop',
          `Idempotency-Key: ${onWire(probe.value)}`,
        ],
        VALID_BODY,
      );
      const rejected = rejectedByForm('IdempotencyKey', res);

      assert.equal(allowed, !rejected, report('IdempotencyKey', probe, allowed, rejected));
    });
  }
});

describe('@req F7a A7 · X-Merchant-Id: контракт и код об одном значении', () => {
  for (const probe of MERCHANT_PROBES) {
    it(`мерчант «${probe.why}»: вердикт схемы совпадает с вердиктом сервера`, async () => {
      const port = await startRawServer();
      const allowed = matchesSchema(parameterSchemaPointer('XMerchantId'), probe.value);
      const res = await send(
        port,
        [
          'POST /v1/payments HTTP/1.1',
          `Host: 127.0.0.1:${String(port)}`,
          'Connection: close',
          'Content-Type: application/json',
          `Content-Length: ${String(Buffer.byteLength(VALID_BODY))}`,
          `X-Merchant-Id: ${onWire(probe.value)}`,
          'Idempotency-Key: merchant-probe-key',
        ],
        VALID_BODY,
      );
      const rejected = rejectedByForm('XMerchantId', res);

      assert.equal(allowed, !rejected, report('XMerchantId', probe, allowed, rejected));
    });
  }
});

describe('A7 · id платежа в пути: контракт и код об одном значении', () => {
  for (const probe of PAYMENT_ID_PROBES) {
    it(`id «${probe.why}»: вердикт схемы совпадает с вердиктом сервера`, async () => {
      const port = await startRawServer();
      const allowed = matchesSchema(parameterSchemaPointer('PaymentId'), probe.value);
      const res = await send(
        port,
        [
          `GET /v1/payments/${encodeURIComponent(probe.value)} HTTP/1.1`,
          `Host: 127.0.0.1:${String(port)}`,
          'Connection: close',
          'X-Merchant-Id: demo-shop',
        ],
        '',
      );
      const rejected = rejectedByForm('PaymentId', res);

      assert.equal(allowed, !rejected, report('PaymentId', probe, allowed, rejected));
    });
  }
});

/**
 * Пробы, которые меняет транспорт. В свойство выше они не входят: сервер видит
 * не то, что отправлено, и разошедшиеся линзы говорили бы о HTTP, а не о коде.
 * Проверяются отдельно и по имени — чтобы исключение было названо, а не спрятано.
 */
describe('A7 · транспорт срезает пробелы раньше сервера', () => {
  for (const [name, wire] of [
    ['ведущий пробел', ' spaced-key'],
    ['хвостовой пробел', 'spaced-key '],
  ] as [string, string][]) {
    it(`${name} у ключа: до сервера доезжает значение без него`, async () => {
      const port = await startRawServer();
      const res = await send(
        port,
        [
          'POST /v1/payments HTTP/1.1',
          `Host: 127.0.0.1:${String(port)}`,
          'Connection: close',
          'Content-Type: application/json',
          `Content-Length: ${String(Buffer.byteLength(VALID_BODY))}`,
          'X-Merchant-Id: demo-shop',
          `Idempotency-Key: ${wire}`,
        ],
        VALID_BODY,
      );

      // Значение доезжает обрезанным, то есть непустым и валидным: платёж создан.
      assert.equal(res.status, 201, 'OWS срезается транспортом, значение остаётся валидным');
    });
  }

  it('пустой ключ, состоящий только из пробелов, доезжает пустым и отвергается', async () => {
    const port = await startRawServer();
    const res = await send(
      port,
      [
        'POST /v1/payments HTTP/1.1',
        `Host: 127.0.0.1:${String(port)}`,
        'Connection: close',
        'Content-Type: application/json',
        `Content-Length: ${String(Buffer.byteLength(VALID_BODY))}`,
        'X-Merchant-Id: demo-shop',
        'Idempotency-Key:    ',
      ],
      VALID_BODY,
    );

    assert.equal(res.status, 400);
    assert.equal(res.body?.error?.code, 'idempotency_key_required');
  });
});

/**
 * Пустой id — это другой маршрут, а не пустое значение параметра:
 * `/v1/payments/` после срезания хвостовой косой становится списком.
 * В общий набор проб он не входит именно поэтому.
 */
describe('A7 · пустой id в пути — другой маршрут, а не пустой параметр', () => {
  it('GET /v1/payments/ отвечает списком, а не отказом по форме id', async () => {
    const port = await startRawServer();
    const res = await send(
      port,
      [
        'GET /v1/payments/ HTTP/1.1',
        `Host: 127.0.0.1:${String(port)}`,
        'Connection: close',
        'X-Merchant-Id: demo-shop',
      ],
      '',
    );

    assert.equal(res.status, 200);
  });
});
