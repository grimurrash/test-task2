/**
 * Заголовки, которых не умеет отправить `fetch`: присланные дважды и с байтами
 * выше ASCII. Находки QA #73 и #75 воспроизводятся только сырым сокетом —
 * `fetch` склеивает повтор заголовка сам, а символ выше 255 не пропускает
 * вовсе. Поэтому здесь свой минимальный HTTP-клиент вместо общей обвязки.
 */
import assert from 'node:assert/strict';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { after, describe, it } from 'node:test';

import { createServer } from '../src/app.js';

interface RawResponse {
  status: number;
  headers: string;
  body: string;
}

type RawSender = (lines: string[], body?: string) => Promise<RawResponse>;

/** Тело без `Content-Length` приходит частями с шестнадцатеричными размерами. */
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

function makeSender(port: number): RawSender {
  return (lines, body = '') =>
    new Promise<RawResponse>((resolve, reject) => {
      const socket = net.connect(port, '127.0.0.1');
      const received: Buffer[] = [];
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error('сервер не ответил за 3 секунды'));
      }, 3000);

      socket.on('connect', () => {
        // Заголовки — байтами latin-1: так их шлёт curl и любой честный клиент,
        // и только так до сервера доезжает не-ASCII значение.
        socket.write(
          Buffer.concat([
            Buffer.from(`${lines.join('\r\n')}\r\n\r\n`, 'latin1'),
            Buffer.from(body, 'utf8'),
          ]),
        );
      });
      socket.on('data', (chunk: Buffer) => received.push(chunk));
      socket.on('close', () => {
        clearTimeout(timer);
        const raw = Buffer.concat(received);
        const split = raw.indexOf('\r\n\r\n');
        const headers = (split < 0 ? raw : raw.subarray(0, split)).toString('latin1');
        const rawBody = split < 0 ? Buffer.alloc(0) : raw.subarray(split + 4);
        const chunked = /transfer-encoding: *chunked/i.test(headers);

        resolve({
          status: Number(/HTTP\/1\.[01] (\d+)/.exec(headers)?.[1] ?? 0),
          headers,
          body: (chunked ? dechunk(rawBody) : rawBody).toString('utf8'),
        });
      });
      socket.on('error', reject);
    });
}

async function withServer<T>(run: (send: RawSender) => Promise<T>): Promise<T> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  after(() => {
    server.closeAllConnections();
    server.close();
  });
  return run(makeSender(port));
}

const BODY = JSON.stringify({ amount_minor: 125000, currency: 'RUB', order_id: 'o-1' });

/** HTTP/1.0 — сервер закрывает соединение сам, ответ читается однозначно. */
function postLines(extra: string[], merchant = 'raw-shop'): string[] {
  return [
    'POST /v1/payments HTTP/1.0',
    'Host: localhost',
    'Content-Type: application/json',
    `X-Merchant-Id: ${merchant}`,
    ...extra,
    `Content-Length: ${String(Buffer.byteLength(BODY))}`,
  ];
}

const post = (send: RawSender, extra: string[], merchant?: string): Promise<RawResponse> =>
  send(postLines(extra, merchant), BODY);

const get = (send: RawSender, merchant: string): Promise<RawResponse> =>
  send(['GET /v1/payments HTTP/1.0', 'Host: localhost', `X-Merchant-Id: ${merchant}`]);

const errorCode = (res: RawResponse): string =>
  (JSON.parse(res.body) as { error: { code: string } }).error.code;

describe('#73 · заголовок, присланный дважды', () => {
  /**
   * Главный тест задачи, и он сформулирован **на исход, а не на механику**:
   * два одинаковых заголовка дают один платёж или отказ, но никогда два `id`
   * с двумя 201. Такая формулировка запрещает исход, поэтому переживёт любую
   * будущую перестановку проверок внутри.
   */
  it('дубль ключа никогда не даёт двух платежей на один ключ', async () => {
    await withServer(async (send) => {
      const merchant = 'dup-outcome';
      const key = 'Idempotency-Key: outcome-key';

      const withDuplicate = await post(send, [key, key], merchant);
      const honest = await post(send, [key], merchant);

      const created = [withDuplicate, honest].filter((r) => r.status === 201);
      assert.ok(
        created.length <= 1,
        `на один ключ создано платежей: ${String(created.length)} — двух быть не может`,
      );

      const list = await get(send, merchant);
      const payments = (JSON.parse(list.body) as { payments: { id: string }[] }).payments;
      assert.ok(
        payments.length <= 1,
        `у мерчанта платежей: ${String(payments.length)} — дубль заголовка не создаёт второй`,
      );
    });
  });

  it('дубль Idempotency-Key отвергается 400 invalid_idempotency_key', async () => {
    await withServer(async (send) => {
      const res = await post(send, ['Idempotency-Key: dup-key', 'Idempotency-Key: dup-key']);

      assert.equal(res.status, 400);
      assert.equal(errorCode(res), 'invalid_idempotency_key');
    });
  });

  it('дубль X-Merchant-Id отвергается по устройству, а не по совпадению', async () => {
    // Прежде склейка «shop, shop» выпадала из набора и давала 400 случайно.
    await withServer(async (send) => {
      const res = await send([
        'GET /v1/payments HTTP/1.0',
        'Host: localhost',
        'X-Merchant-Id: shop',
        'X-Merchant-Id: shop',
      ]);

      assert.equal(res.status, 400);
      assert.equal(errorCode(res), 'invalid_merchant_id');
    });
  });

  it('дубль отвергается и при разном регистре имени заголовка', async () => {
    await withServer(async (send) => {
      const res = await post(send, ['Idempotency-Key: mixed', 'idempotency-key: mixed']);

      assert.equal(res.status, 400);
      assert.equal(errorCode(res), 'invalid_idempotency_key');
    });
  });

  it('отказ не занимает ключ: честный запрос после него проходит', async () => {
    await withServer(async (send) => {
      const merchant = 'dup-free';
      const key = 'Idempotency-Key: free-key';

      await post(send, [key, key], merchant);
      const created = await post(send, [key], merchant);
      const repeated = await post(send, [key], merchant);

      assert.equal(created.status, 201);
      assert.equal(repeated.status, 200, 'честный повтор обязан вернуть тот же ресурс');
    });
  });

  it('одиночный заголовок по-прежнему принимается', async () => {
    await withServer(async (send) => {
      assert.equal((await post(send, ['Idempotency-Key: single-key'])).status, 201);
    });
  });
});

describe('#75 · длина ключа в символах, а не в байтах', () => {
  // Значение заголовка приходит побайтно: кириллическая буква — два байта.
  const cyrillic = (count: number) => Buffer.from('к'.repeat(count), 'utf8').toString('latin1');

  it('ключ из 128 кириллических букв валиден, хотя это 256 байт', async () => {
    await withServer(async (send) => {
      const res = await post(send, [`Idempotency-Key: ${cyrillic(128)}`], 'krb-128');
      assert.equal(res.status, 201, 'порог обязан считаться в символах');
    });
  });

  it('ключ из 255 кириллических букв принимается (510 байт)', async () => {
    await withServer(async (send) => {
      const res = await post(send, [`Idempotency-Key: ${cyrillic(255)}`], 'krb-255');
      assert.equal(res.status, 201);
    });
  });

  it('ключ из 256 кириллических букв отвергается', async () => {
    await withServer(async (send) => {
      const res = await post(send, [`Idempotency-Key: ${cyrillic(256)}`], 'krb-256');

      assert.equal(res.status, 400);
      assert.equal(errorCode(res), 'invalid_idempotency_key');
    });
  });

  it('порог не зависит от письменности: 255 латинских тоже принимается', async () => {
    await withServer(async (send) => {
      const res = await post(send, [`Idempotency-Key: ${'k'.repeat(255)}`], 'lat-255');
      assert.equal(res.status, 201);
    });
  });
});

describe('#74 · HEAD зеркалит GET', () => {
  it('HEAD на список отвечает как GET, но без тела', async () => {
    await withServer(async (send) => {
      const head = await send([
        'HEAD /v1/payments HTTP/1.0',
        'Host: localhost',
        'X-Merchant-Id: head-shop',
      ]);

      assert.equal(head.status, 200);
      assert.match(head.headers, /content-type: application\/json/i);
      assert.equal(head.body, '', 'у ответа на HEAD не бывает тела');
    });
  });

  it('HEAD на несуществующий платёж отвечает 404, как GET', async () => {
    await withServer(async (send) => {
      const res = await send([
        'HEAD /v1/payments/pay_нет HTTP/1.0',
        'Host: localhost',
        'X-Merchant-Id: head-shop',
      ]);

      assert.equal(res.status, 404);
    });
  });

  it('HEAD без X-Merchant-Id отвечает 400, как GET', async () => {
    await withServer(async (send) => {
      const res = await send(['HEAD /v1/payments HTTP/1.0', 'Host: localhost']);
      assert.equal(res.status, 400);
    });
  });
});

describe('Соединение переживает ответ', () => {
  /**
   * Регресс, внесённый моей же правкой #56: остаток `res.on('finish')` рвал
   * соединение после каждого ответа, потому что запрос **без тела** никто
   * не читает и `readableEnded` у него ложь. Прогон этого не видел — клиент
   * молча переподключается, и все 194 теста оставались зелёными.
   */
  it('два запроса проходят по одному keep-alive соединению', async () => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    after(() => {
      server.closeAllConnections();
      server.close();
    });

    const request = [
      'GET /v1/payments HTTP/1.1',
      'Host: localhost',
      'X-Merchant-Id: keepalive',
      '',
      '',
    ].join('\r\n');

    const answers = await new Promise<number>((resolve, reject) => {
      const socket = net.connect(port, '127.0.0.1');
      let raw = '';
      let sentSecond = false;
      const count = () => (raw.match(/HTTP\/1\.[01] \d+/g) ?? []).length;
      const timer = setTimeout(() => {
        socket.destroy();
        resolve(count());
      }, 3000);

      socket.on('connect', () => socket.write(request));
      socket.on('data', (chunk: Buffer) => {
        raw += chunk.toString('utf8');
        if (count() === 1 && !sentSecond) {
          sentSecond = true;
          socket.write(request);
        }
        if (count() === 2) {
          clearTimeout(timer);
          socket.destroy();
          resolve(2);
        }
      });
      socket.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    assert.equal(answers, 2, 'соединение обязано пережить первый ответ');
  });
});
