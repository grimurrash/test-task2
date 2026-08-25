/** F12–F16 — статус, отмена, список. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  MERCHANT,
  OTHER_MERCHANT,
  asError,
  asPayment,
  startApp,
  testClock,
  validBody,
} from './support/harness.js';

/** Сумма с остатком 02 — платёж рождается сразу succeeded (F17). */
const SUCCEEDED_AMOUNT = 10002;
/** Сумма с остатком 01 — платёж рождается сразу failed (F17). */
const FAILED_AMOUNT = 10001;

describe('F12 · получение платежа по id', () => {
  it('отдаёт платёж своему мерчанту', async () => {
    const app = await startApp();
    const created = asPayment((await app.create(validBody())).body);

    const res = await app.getPayment(created.id);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, created);
  });

  it('несуществующий id → 404 payment_not_found', async () => {
    const app = await startApp();
    const res = await app.getPayment('pay_несуществующий');

    assert.equal(res.status, 404);
    assert.equal(asError(res.body).error.code, 'payment_not_found');
  });

  it('чужой платёж по верному id → 404, существование не раскрывается', async () => {
    const app = await startApp();
    const created = asPayment((await app.create(validBody(), { merchant: MERCHANT })).body);

    const res = await app.getPayment(created.id, OTHER_MERCHANT);
    assert.equal(res.status, 404);
    assert.equal(asError(res.body).error.code, 'payment_not_found');
    assert.deepEqual(
      res.body,
      (await app.getPayment('pay_заведомо-нет', OTHER_MERCHANT)).body,
      'чужой и несуществующий обязаны отвечать неотличимо',
    );
  });
});

describe('F13, F14 · отмена', () => {
  it('переводит pending в canceled и отвечает 200', async () => {
    const app = await startApp();
    const created = asPayment((await app.create(validBody())).body);

    const res = await app.cancel(created.id);
    assert.equal(res.status, 200);

    const canceled = asPayment(res.body);
    assert.equal(canceled.status, 'canceled');
    assert.equal(canceled.id, created.id);
    assert.equal(canceled.created_at, created.created_at);
    assert.equal(canceled.amount_minor, created.amount_minor);
  });

  it('отмена видна при последующем чтении', async () => {
    const app = await startApp();
    const created = asPayment((await app.create(validBody())).body);
    await app.cancel(created.id);

    assert.equal(asPayment((await app.getPayment(created.id)).body).status, 'canceled');
  });

  it('повторная отмена → снова 200 и тот же результат', async () => {
    const app = await startApp();
    const created = asPayment((await app.create(validBody())).body);

    const first = await app.cancel(created.id);
    const second = await app.cancel(created.id);

    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.deepEqual(second.body, first.body);
  });

  it('отмена не меняет status_reason у обычного платежа', async () => {
    const app = await startApp();
    const created = asPayment((await app.create(validBody())).body);

    assert.equal(asPayment((await app.cancel(created.id)).body).status_reason, null);
  });

  it('несуществующий платёж → 404', async () => {
    const app = await startApp();
    const res = await app.cancel('pay_нет-такого');

    assert.equal(res.status, 404);
    assert.equal(asError(res.body).error.code, 'payment_not_found');
  });

  it('чужой платёж → 404, а не 409 и не 200', async () => {
    const app = await startApp();
    const created = asPayment((await app.create(validBody(), { merchant: MERCHANT })).body);

    const res = await app.cancel(created.id, OTHER_MERCHANT);
    assert.equal(res.status, 404);
    assert.equal(asError(res.body).error.code, 'payment_not_found');

    // И платёж владельца при этом не тронут.
    assert.equal(asPayment((await app.getPayment(created.id, MERCHANT)).body).status, 'pending');
  });
});

describe('F15 · отмена платежа в терминальном статусе', () => {
  it('succeeded → 409 payment_not_cancelable', async () => {
    const app = await startApp();
    const created = asPayment(
      (await app.create(validBody({ amount_minor: SUCCEEDED_AMOUNT }))).body,
    );
    assert.equal(created.status, 'succeeded');

    const res = await app.cancel(created.id);
    assert.equal(res.status, 409);
    assert.equal(asError(res.body).error.code, 'payment_not_cancelable');
    assert.equal(asError(res.body).error.details?.status, 'succeeded');
  });

  it('failed → 409 payment_not_cancelable', async () => {
    const app = await startApp();
    const created = asPayment((await app.create(validBody({ amount_minor: FAILED_AMOUNT }))).body);
    assert.equal(created.status, 'failed');

    const res = await app.cancel(created.id);
    assert.equal(res.status, 409);
    assert.equal(asError(res.body).error.code, 'payment_not_cancelable');
    assert.equal(asError(res.body).error.details?.status, 'failed');
  });

  it('отказ не меняет платёж', async () => {
    const app = await startApp();
    const created = asPayment(
      (await app.create(validBody({ amount_minor: SUCCEEDED_AMOUNT }))).body,
    );

    await app.cancel(created.id);
    assert.deepEqual((await app.getPayment(created.id)).body, created);
  });
});

describe('F16 · список платежей мерчанта', () => {
  it('у нового мерчанта список пуст', async () => {
    const app = await startApp();
    const res = await app.list('fresh-merchant');

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { payments: [] });
  });

  it('сортирует по created_at по убыванию — новые сверху', async () => {
    const clock = testClock();
    const app = await startApp({ clock });

    const first = asPayment((await app.create(validBody({ order_id: 'o-1' }))).body);
    clock.advance(1000);
    const second = asPayment((await app.create(validBody({ order_id: 'o-2' }))).body);
    clock.advance(1000);
    const third = asPayment((await app.create(validBody({ order_id: 'o-3' }))).body);

    const list = (await app.list()).body as { payments: { id: string }[] };
    assert.deepEqual(
      list.payments.map((p) => p.id),
      [third.id, second.id, first.id],
    );
  });

  it('при совпадении created_at порядок устойчив — позже созданный выше', async () => {
    // Часы стоят: три платежа получают одинаковый created_at. Сортировка
    // обязана оставаться детерминированной, иначе тест будет мигать.
    const clock = testClock();
    const app = await startApp({ clock });

    const ids: string[] = [];
    for (const order of ['o-1', 'o-2', 'o-3']) {
      ids.push(asPayment((await app.create(validBody({ order_id: order }))).body).id);
    }

    const list = (await app.list()).body as { payments: { id: string }[] };
    assert.deepEqual(
      list.payments.map((p) => p.id),
      [...ids].reverse(),
    );
  });

  it('отдаёт платежи целиком, теми же полями, что и одиночное чтение', async () => {
    const app = await startApp();
    const created = asPayment((await app.create(validBody())).body);

    const list = (await app.list()).body as { payments: unknown[] };
    assert.deepEqual(list.payments[0], created);
  });

  it('показывает отменённый платёж в новом статусе', async () => {
    const app = await startApp();
    const created = asPayment((await app.create(validBody())).body);
    await app.cancel(created.id);

    const list = (await app.list()).body as { payments: { status: string }[] };
    assert.equal(list.payments[0]?.status, 'canceled');
  });
});
