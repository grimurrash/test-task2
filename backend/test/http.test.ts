/**
 * HTTP-слой: CORS для песочницы на соседнем origin и поведение за границами
 * контракта. Контракт описывает четыре маршрута и молчит о том, чего в нём нет,
 * — конверт ошибок 5.4 держится и там, но коды таких ответов вне перечня восьми
 * осознанно: восемь кодов описывают контракт, а эти случаи им не описаны.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { MERCHANT, startApp, validBody } from './support/harness.js';

interface ErrorEnvelope {
  error: { code: string; message: string };
}

describe('CORS · песочница живёт на другом origin', () => {
  it('успешный ответ несёт разрешение на любой origin', async () => {
    const app = await startApp();
    const res = await app.create(validBody());

    assert.equal(res.headers.get('access-control-allow-origin'), '*');
  });

  it('преflight пропускает заголовки идемпотентности и мерчанта', async () => {
    const app = await startApp();
    const res = await app.raw('OPTIONS', '/v1/payments', {
      headers: {
        Origin: 'http://localhost:8081',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'idempotency-key,x-merchant-id,content-type',
      },
    });

    assert.equal(res.status, 204);
    const allowed = (res.headers.get('access-control-allow-headers') ?? '').toLowerCase();
    for (const header of ['idempotency-key', 'x-merchant-id', 'content-type']) {
      assert.ok(allowed.includes(header), `преflight обязан разрешить ${header}`);
    }
    const methods = (res.headers.get('access-control-allow-methods') ?? '').toUpperCase();
    assert.ok(methods.includes('POST'));
    assert.ok(methods.includes('GET'));
  });

  it('ответ с ошибкой тоже доступен песочнице', async () => {
    const app = await startApp();
    const res = await app.create(validBody(), { merchant: null });

    assert.equal(res.status, 400);
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
  });
});

/**
 * Маршрутизация после #94: коды `not_found` и `method_not_allowed` внесены
 * в перечень контракта, 405 описан правилом на всё API. Перебор идёт через
 * `app.raw`, где встроена сверка конверта, — то есть каждый ответ здесь
 * проверяется против `schemas/Error` ещё до утверждений теста.
 */
describe('#74 · маршрутизация описана контрактом', () => {
  const foreignMethods: [string, string][] = [
    ['DELETE', '/v1/payments'],
    ['PUT', '/v1/payments'],
    ['PATCH', '/v1/payments/pay_x'],
    ['DELETE', '/v1/payments/pay_x'],
    ['PUT', '/v1/payments/pay_x'],
    ['GET', '/v1/payments/pay_x/cancel'],
    ['DELETE', '/v1/payments/pay_x/cancel'],
  ];

  for (const [method, path] of foreignMethods) {
    it(`${method} ${path} → 405 method_not_allowed с заголовком Allow`, async () => {
      const app = await startApp();
      const res = await app.raw(method, path, { headers: { 'X-Merchant-Id': MERCHANT } });

      assert.equal(res.status, 405);
      assert.equal((res.body as ErrorEnvelope).error.code, 'method_not_allowed');
      assert.ok(res.headers.get('allow'), 'ответ 405 обязан называть разрешённые методы');
    });
  }

  const unknownPaths = ['/v1/nope', '/v1', '/', '/v1/payments/pay_x/refund', '/v2/payments'];

  for (const path of unknownPaths) {
    it(`неизвестный путь ${path} → 404 not_found, а не про ресурс`, async () => {
      const app = await startApp();
      const res = await app.raw('GET', path, { headers: { 'X-Merchant-Id': MERCHANT } });

      assert.equal(res.status, 404);
      assert.equal(
        (res.body as ErrorEnvelope).error.code,
        'not_found',
        'путь и ресурс — разные ошибки: payment_not_found здесь был бы неправдой',
      );
    });
  }

  it('маршрут разбирается раньше заголовков: чужой путь без мерчанта — про путь', async () => {
    const app = await startApp();
    const res = await app.raw('GET', '/v1/nope');

    assert.equal(res.status, 404);
    assert.equal((res.body as ErrorEnvelope).error.code, 'not_found');
  });

  it('OPTIONS под правило 405 не попадает — preflight отвечает 204', async () => {
    const app = await startApp();

    for (const path of ['/v1/payments', '/v1/payments/pay_x', '/v1/nope', '/']) {
      const res = await app.raw('OPTIONS', path, {
        headers: { Origin: 'http://localhost:8081', 'Access-Control-Request-Method': 'POST' },
      });

      assert.equal(res.status, 204, `preflight на ${path} обязан отвечать 204, а не 404 или 405`);
      assert.equal(res.headers.get('access-control-allow-origin'), '*');
    }
  });
});

describe('За границами контракта конверт 5.4 сохраняется', () => {
  it('неизвестный маршрут → 404 в том же конверте', async () => {
    const app = await startApp();
    const res = await app.raw('GET', '/v1/unknown', {
      headers: { 'X-Merchant-Id': MERCHANT },
    });

    assert.equal(res.status, 404);
    const body = res.body as ErrorEnvelope;
    assert.equal(typeof body.error.code, 'string');
    assert.equal(typeof body.error.message, 'string');
  });

  it('неверный метод на известном маршруте → 405 в том же конверте', async () => {
    const app = await startApp();
    const res = await app.raw('DELETE', '/v1/payments', {
      headers: { 'X-Merchant-Id': MERCHANT },
    });

    assert.equal(res.status, 405);
    const body = res.body as ErrorEnvelope;
    assert.equal(body.error.code, 'method_not_allowed');
    assert.ok(res.headers.get('allow'));
  });

  it('ответы отдаются как JSON', async () => {
    const app = await startApp();
    const res = await app.create(validBody());

    assert.match(res.headers.get('content-type') ?? '', /application\/json/);
  });
});

describe('Разбор пути', () => {
  it('косая черта в конце не создаёт другой маршрут', async () => {
    const app = await startApp();
    const res = await app.raw('GET', '/v1/payments/', {
      headers: { 'X-Merchant-Id': MERCHANT },
    });

    assert.equal(res.status, 200, 'GET /v1/payments/ обязан вести себя как список');
  });

  it('строка запроса не мешает разбору маршрута', async () => {
    const app = await startApp();
    const res = await app.raw('GET', '/v1/payments?limit=10', {
      headers: { 'X-Merchant-Id': MERCHANT },
    });

    assert.equal(res.status, 200);
  });

  // Находка ревью #47: decodeURIComponent бросал прямо из разбора пути,
  // до проверки заголовков. Ответ выпадал из контракта (A7) и рушил порядок
  // проверок из #32 — 500 приходил и вместо 404, и вместо 400.
  it('битое процентное кодирование в id → 404, а не отказ сервера', async () => {
    const app = await startApp();
    const res = await app.raw('GET', '/v1/payments/%zz', {
      headers: { 'X-Merchant-Id': MERCHANT },
    });

    assert.equal(res.status, 404);
    assert.equal((res.body as ErrorEnvelope).error.code, 'payment_not_found');
  });

  it('битое кодирование не ломает порядок проверок: без мерчанта → 400', async () => {
    const app = await startApp();
    const res = await app.raw('GET', '/v1/payments/%zz');

    assert.equal(res.status, 400);
    assert.equal((res.body as ErrorEnvelope).error.code, 'merchant_id_required');
  });

  it('битое кодирование на отмене → 404, а не отказ сервера', async () => {
    const app = await startApp();
    const res = await app.raw('POST', '/v1/payments/%e0%a4%a/cancel', {
      headers: { 'X-Merchant-Id': MERCHANT },
    });

    assert.equal(res.status, 404);
    assert.equal((res.body as ErrorEnvelope).error.code, 'payment_not_found');
  });

  it('id с процентным кодированием разбирается', async () => {
    const app = await startApp();
    const res = await app.raw('GET', '/v1/payments/pay%20с%20пробелом', {
      headers: { 'X-Merchant-Id': MERCHANT },
    });

    assert.equal(res.status, 404);
    assert.equal((res.body as ErrorEnvelope).error.code, 'payment_not_found');
  });
});
