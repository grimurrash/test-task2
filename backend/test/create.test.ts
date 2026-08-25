/** F1, F7, F7a, F17, F18 — создание платежа, заголовки, правило тестовых сумм. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  MERCHANT,
  asError,
  asPayment,
  startApp,
  validBody,
} from './support/harness.js';

describe('F1 · создание платежа', () => {
  it('создаёт платёж и отвечает 201', async () => {
    const app = await startApp();
    const res = await app.create(validBody());

    assert.equal(res.status, 201);
    const payment = asPayment(res.body);
    assert.equal(payment.status, 'pending');
    assert.equal(payment.status_reason, null);
    assert.equal(payment.amount_minor, 125000);
    assert.equal(payment.currency, 'RUB');
    assert.equal(payment.order_id, 'order-2026-0825-0001');
    assert.equal(payment.description, 'Подписка на тариф «Про», август');
    assert.match(payment.id, /^pay_[A-Za-z0-9]+$/);
    assert.equal(new Date(payment.created_at).toISOString(), payment.created_at);
  });

  it('созданный платёж читается по своему id', async () => {
    const app = await startApp();
    const created = asPayment((await app.create(validBody())).body);
    const fetched = await app.getPayment(created.id);

    assert.equal(fetched.status, 200);
    assert.deepEqual(fetched.body, created);
  });

  it('описание необязательно — тогда в ответе null', async () => {
    const app = await startApp();
    const body = validBody();
    delete body['description'];

    const res = await app.create(body);
    assert.equal(res.status, 201);
    assert.equal(asPayment(res.body).description, null);
  });
});

describe('F7 · заголовок Idempotency-Key', () => {
  it('без заголовка → 400 idempotency_key_required', async () => {
    const app = await startApp();
    const res = await app.create(validBody(), { key: null });

    assert.equal(res.status, 400);
    assert.equal(asError(res.body).error.code, 'idempotency_key_required');
  });

  it('пустое значение приравнивается к отсутствию → 400', async () => {
    const app = await startApp();
    const res = await app.create(validBody(), { key: '' });

    assert.equal(res.status, 400);
    assert.equal(asError(res.body).error.code, 'idempotency_key_required');
  });

  it('ключ ровно на границе 255 символов принимается', async () => {
    const app = await startApp();
    const res = await app.create(validBody(), { key: 'k'.repeat(255) });

    assert.equal(res.status, 201);
  });

  // Пробел B закрыт правкой контракта (#32, PR #38): отдельный код,
  // симметрично invalid_merchant_id.
  it('ключ длиннее 255 символов → 400 invalid_idempotency_key', async () => {
    const app = await startApp();
    const res = await app.create(validBody(), { key: 'k'.repeat(256) });

    assert.equal(res.status, 400);
    assert.equal(asError(res.body).error.code, 'invalid_idempotency_key');
  });

  it('отсутствие и длина различаются кодом, а не одним ответом на оба случая', async () => {
    const app = await startApp();
    const missing = await app.create(validBody(), { key: null });
    const tooLong = await app.create(validBody(), { key: 'k'.repeat(300) });

    assert.notEqual(asError(missing.body).error.code, asError(tooLong.body).error.code);
  });
});

describe('F7a · заголовок X-Merchant-Id', () => {
  it('без заголовка → 400 merchant_id_required', async () => {
    const app = await startApp();
    const res = await app.create(validBody(), { merchant: null });

    assert.equal(res.status, 400);
    assert.equal(asError(res.body).error.code, 'merchant_id_required');
  });

  it('пустое значение → 400 invalid_merchant_id', async () => {
    const app = await startApp();
    const res = await app.create(validBody(), { merchant: '' });

    assert.equal(res.status, 400);
    assert.equal(asError(res.body).error.code, 'invalid_merchant_id');
  });

  it('длиннее 64 символов → 400 invalid_merchant_id', async () => {
    const app = await startApp();
    const res = await app.create(validBody(), { merchant: 'm'.repeat(65) });

    assert.equal(res.status, 400);
    assert.equal(asError(res.body).error.code, 'invalid_merchant_id');
  });

  it('ровно 64 символа принимаются', async () => {
    const app = await startApp();
    const res = await app.create(validBody(), { merchant: 'm'.repeat(64) });

    assert.equal(res.status, 201);
  });

  for (const bad of ['shop 1', 'shop/1', 'shop:1', 'shop,1', 'shop+1']) {
    it(`символы вне набора отклоняются: ${JSON.stringify(bad)}`, async () => {
      const app = await startApp();
      const res = await app.create(validBody(), { merchant: bad });

      assert.equal(res.status, 400);
      assert.equal(asError(res.body).error.code, 'invalid_merchant_id');
    });
  }

  it('набор A–Z a–z 0–9 . _ - принимается целиком', async () => {
    const app = await startApp();
    const res = await app.create(validBody(), { merchant: 'Shop.demo_1-A' });

    assert.equal(res.status, 201);
  });

  it('заголовок обязателен и на списке, и на статусе, и на отмене', async () => {
    const app = await startApp();
    const created = asPayment((await app.create(validBody())).body);

    for (const res of [
      await app.list(null),
      await app.getPayment(created.id, null),
      await app.cancel(created.id, null),
    ]) {
      assert.equal(res.status, 400);
      assert.equal(asError(res.body).error.code, 'merchant_id_required');
    }
  });
});

describe('Пробел D · порядок проверок: заголовки раньше тела', () => {
  it('нет мерчанта и нет ключа → отвечает про мерчанта', async () => {
    const app = await startApp();
    const res = await app.create(validBody(), { merchant: null, key: null });

    assert.equal(res.status, 400);
    assert.equal(asError(res.body).error.code, 'merchant_id_required');
  });

  it('нет ключа и невалидное тело → отвечает про ключ', async () => {
    const app = await startApp();
    const res = await app.create(validBody({ amount_minor: 0 }), { key: null });

    assert.equal(res.status, 400);
    assert.equal(asError(res.body).error.code, 'idempotency_key_required');
  });

  it('невалидный мерчант и невалидное тело → отвечает про мерчанта', async () => {
    const app = await startApp();
    const res = await app.create(validBody({ currency: 'GBP' }), { merchant: 'bad merchant' });

    assert.equal(res.status, 400);
    assert.equal(asError(res.body).error.code, 'invalid_merchant_id');
  });
});

describe('F17, F18 · правило тестовых сумм', () => {
  const cases: [number, string, string | null][] = [
    [125000, 'pending', null],
    [10001, 'failed', 'test_amount_rule'],
    [10002, 'succeeded', 'test_amount_rule'],
    // Правило считается остатком, поэтому суммы 1 и 2 — тоже триггеры.
    [1, 'failed', 'test_amount_rule'],
    [2, 'succeeded', 'test_amount_rule'],
    [101, 'failed', 'test_amount_rule'],
    [102, 'succeeded', 'test_amount_rule'],
    [100, 'pending', null],
    [103, 'pending', null],
    [99, 'pending', null],
  ];

  for (const [amount, status, reason] of cases) {
    it(`${amount} → ${status} (status_reason ${String(reason)})`, async () => {
      const app = await startApp();
      const res = await app.create(validBody({ amount_minor: amount }));

      assert.equal(res.status, 201);
      const payment = asPayment(res.body);
      assert.equal(payment.status, status);
      assert.equal(payment.status_reason, reason);
    });
  }

  it('правило применяется синхронно: статус виден сразу в ответе на создание', async () => {
    const app = await startApp();
    const created = asPayment((await app.create(validBody({ amount_minor: 502 }))).body);
    const fetched = asPayment((await app.getPayment(created.id)).body);

    assert.equal(created.status, 'succeeded');
    assert.equal(fetched.status, 'succeeded');
  });

  it('граница безопасного целого сама по себе триггером не является', async () => {
    const app = await startApp();
    // 9007199254740991 % 100 === 91 — обычная сумма.
    const res = await app.create(validBody({ amount_minor: Number.MAX_SAFE_INTEGER }));

    assert.equal(res.status, 201);
    assert.equal(asPayment(res.body).status, 'pending');
    assert.equal(asPayment(res.body).amount_minor, Number.MAX_SAFE_INTEGER);
  });
});

describe('Скоуп мерчанта на чтении', () => {
  it('список отдаёт только свои платежи', async () => {
    const app = await startApp();
    await app.create(validBody(), { merchant: MERCHANT });
    await app.create(validBody(), { merchant: 'another-shop' });

    const mine = (await app.list(MERCHANT)).body as { payments: unknown[] };
    assert.equal(mine.payments.length, 1);
  });
});
