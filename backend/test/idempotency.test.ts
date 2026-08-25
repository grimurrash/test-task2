/**
 * F2–F6 — сердце задачи.
 *
 * Тест на гонку написан до реализации: «проверил ключ — записал платёж»
 * выглядит как решение и разваливается ровно между двумя строками. Здесь два
 * разных теста: один проверяет свойство (ровно один платёж), второй —
 * наблюдаемое состояние «первый ещё в полёте», ради которого в контракте
 * заведён код `request_in_progress`.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  MERCHANT,
  OTHER_MERCHANT,
  asError,
  asPayment,
  barrier,
  cryptoKey,
  startApp,
  testClock,
  validBody,
  withTimeout,
  yieldingCommit,
} from './support/harness.js';

const DAY_MS = 24 * 60 * 60 * 1000;

describe('F2 · повтор с тем же ключом и тем же телом', () => {
  it('отвечает 200 и возвращает тот же ресурс байт-в-байт', async () => {
    const app = await startApp();
    const key = cryptoKey();
    const body = validBody();

    const first = await app.create(body, { key });
    const second = await app.create(body, { key });

    assert.equal(first.status, 201);
    assert.equal(second.status, 200);
    assert.equal(second.text, first.text);
    assert.equal(asPayment(second.body).id, asPayment(first.body).id);
    assert.equal(asPayment(second.body).created_at, asPayment(first.body).created_at);
  });

  it('второй платёж не создаётся — список не растёт', async () => {
    const app = await startApp();
    const key = cryptoKey();
    const body = validBody();

    await app.create(body, { key });
    await app.create(body, { key });
    await app.create(body, { key });

    const list = (await app.list()).body as { payments: { id: string }[] };
    assert.equal(list.payments.length, 1);
  });

  it('created_at не переписывается повтором, даже если время ушло вперёд', async () => {
    const clock = testClock();
    const app = await startApp({ clock });
    const key = cryptoKey();
    const body = validBody();

    const first = asPayment((await app.create(body, { key })).body);
    clock.advance(60 * 60 * 1000);
    const second = asPayment((await app.create(body, { key })).body);

    assert.equal(second.created_at, first.created_at);
  });

  // Пробел C ревью контракта: «то же тело» не определено. Временное чтение —
  // сравнение по разобранным полям, а не побайтово.
  it('порядок ключей в JSON на равенство тел не влияет (пробел C)', async () => {
    const app = await startApp();
    const key = cryptoKey();

    const first = await app.create(undefined, {
      key,
      rawBody: '{"amount_minor":125000,"currency":"RUB","order_id":"o-1","description":"d"}',
    });
    const second = await app.create(undefined, {
      key,
      rawBody: '{"description":"d","order_id":"o-1","currency":"RUB","amount_minor":125000}',
    });

    assert.equal(first.status, 201);
    assert.equal(second.status, 200);
    assert.equal(asPayment(second.body).id, asPayment(first.body).id);
  });

  it('пробелы в JSON на равенство тел не влияют (пробел C)', async () => {
    const app = await startApp();
    const key = cryptoKey();

    const first = await app.create(undefined, {
      key,
      rawBody: '{"amount_minor":125000,"currency":"RUB","order_id":"o-1"}',
    });
    const second = await app.create(undefined, {
      key,
      rawBody: '{\n  "amount_minor" : 125000,\n  "currency" : "RUB",\n  "order_id" : "o-1"\n}',
    });

    assert.equal(second.status, 200);
    assert.equal(asPayment(second.body).id, asPayment(first.body).id);
  });

  it('отсутствующее описание равно явному отсутствию поля (пробел C)', async () => {
    const app = await startApp();
    const key = cryptoKey();
    const body = validBody();
    delete body['description'];

    const first = await app.create(body, { key });
    const second = await app.create(body, { key });

    assert.equal(second.status, 200);
    assert.equal(asPayment(second.body).id, asPayment(first.body).id);
  });

});

// Решение по пересечению C×D (#32): сравнение повторов идёт **после** успешной
// валидации тела, поэтому невалидный запрос в историю ключа не попадает.
// Это ровно то место, где две роли расходятся молча: занятый ключ с битым телом
// легко принять за конфликт ключа.
describe('C×D · занятый ключ с невалидным телом — ошибка по телу, не 409', () => {
  it('нулевая сумма при занятом ключе → 422, а не idempotency_key_reuse', async () => {
    const app = await startApp();
    const key = cryptoKey();

    await app.create(validBody(), { key });
    const res = await app.create(validBody({ amount_minor: 0 }), { key });

    assert.equal(res.status, 422);
    assert.equal(asError(res.body).error.code, 'validation_failed');
  });

  it('неразбираемое тело при занятом ключе → ошибка по телу, не 409', async () => {
    const app = await startApp();
    const key = cryptoKey();

    await app.create(validBody(), { key });
    const res = await app.create(undefined, { rawBody: '{сломано', key });

    assert.notEqual(res.status, 409);
    assert.notEqual(asError(res.body).error.code, 'idempotency_key_reuse');
  });

  it('невалидное тело не занимает и не портит историю ключа', async () => {
    const app = await startApp();
    const key = cryptoKey();
    const body = validBody();

    const created = asPayment((await app.create(body, { key })).body);
    await app.create(validBody({ currency: 'GBP' }), { key });

    // История ключа не изменилась: повтор исходного тела по-прежнему повтор.
    const replay = await app.create(body, { key });
    assert.equal(replay.status, 200);
    assert.equal(asPayment(replay.body).id, created.id);
  });
});

describe('F3 · тот же ключ с другим телом', () => {
  it('отвечает 409 idempotency_key_reuse', async () => {
    const app = await startApp();
    const key = cryptoKey();

    await app.create(validBody(), { key });
    const conflict = await app.create(validBody({ amount_minor: 999 }), { key });

    assert.equal(conflict.status, 409);
    assert.equal(asError(conflict.body).error.code, 'idempotency_key_reuse');
  });

  it('существующий платёж не изменяется', async () => {
    const app = await startApp();
    const key = cryptoKey();

    const created = asPayment((await app.create(validBody(), { key })).body);
    await app.create(validBody({ amount_minor: 999, order_id: 'другой' }), { key });

    const after = await app.getPayment(created.id);
    assert.deepEqual(after.body, created);

    const list = (await app.list()).body as { payments: unknown[] };
    assert.equal(list.payments.length, 1);
  });

  for (const [field, value] of [
    ['amount_minor', 4200],
    ['currency', 'USD'],
    ['order_id', 'order-другой'],
    ['description', 'другое описание'],
  ] as [string, unknown][]) {
    it(`различие в поле ${field} считается другим телом`, async () => {
      const app = await startApp();
      const key = cryptoKey();

      await app.create(validBody(), { key });
      const conflict = await app.create(validBody({ [field]: value }), { key });

      assert.equal(conflict.status, 409);
      assert.equal(asError(conflict.body).error.code, 'idempotency_key_reuse');
    });
  }
});

describe('F4 · гонка — главный дефект темы', () => {
  // Детерминированный вариант. Без барьера исход зависит от фазы цикла
  // событий: наивная реализация проходила такой тест примерно через раз —
  // проверено мутацией. Барьер держит победителя внутри фиксации, пока
  // проигравший не получит ответ, и делает проверку однозначной.
  it('две одновременные отправки порождают ровно один платёж', async () => {
    const gate = barrier();
    const app = await startApp({ commit: () => gate.wait() });
    const key = cryptoKey();
    const body = validBody();

    const attempts = [app.create(body, { key }), app.create(body, { key })].map((promise, index) =>
      promise.then((response) => ({ index, response })),
    );

    await gate.entered;
    const loser = await withTimeout(
      Promise.any(attempts),
      2000,
      'ни один из двух запросов не ответил: оба ушли в фиксацию — значит ключ не забронирован',
    );

    assert.equal(loser.response.status, 409);
    assert.equal(asError(loser.response.body).error.code, 'request_in_progress');

    gate.release();
    const winner = await attempts[1 - loser.index]!;
    assert.equal(winner.response.status, 201);

    const list = (await app.list()).body as { payments: { id: string }[] };
    assert.equal(
      list.payments.length,
      1,
      'две одновременные отправки создали больше одного платежа',
    );
    assert.equal(list.payments[0]?.id, asPayment(winner.response.body).id);
  });

  /**
   * ПРОВЕРЯЕТ ПОВЕДЕНИЕ ПОД РЕАЛЬНЫМ ТАЙМИНГОМ, РЕАЛИЗАЦИЮ НЕ РАЗЛИЧАЕТ.
   *
   * Спор об этом тесте решён измерением в ревью #47: наивная схема
   * «проверил — записал» даёт здесь 0 красных из 25, тогда как барьерные
   * тесты рядом краснеют в каждом прогоне из двадцати пяти. Причина измерена,
   * а не предположена: пик одновременных фиксаций равен единице — десять
   * запросов не пересекаются вовсе, потому что уступка через `setImmediate`
   * слишком коротка. С `setTimeout(5)` та же схема даёт десять создателей
   * и десять `id`, то есть исход задаёт длительность уступки, а не бронь ключа.
   *
   * Тест оставлен намеренно: свойство на живом тайминге он проверяет. Но за
   * охрану его держать нельзя — охрана рядом, в тестах с барьером.
   */
  it('десять одновременных отправок порождают ровно один платёж', async () => {
    const app = await startApp({ commit: yieldingCommit() });
    const key = cryptoKey();
    const body = validBody();

    const results = await Promise.all(
      Array.from({ length: 10 }, () => app.create(body, { key })),
    );

    const created = results.filter((r) => r.status === 201);
    assert.equal(created.length, 1, 'создателей обязан быть ровно один');

    const list = (await app.list()).body as { payments: { id: string }[] };
    assert.equal(list.payments.length, 1);

    const ids = new Set(
      results.filter((r) => r.status < 300).map((r) => asPayment(r.body).id),
    );
    assert.equal(ids.size, 1, 'все успешные ответы обязаны нести один и тот же id');
  });

  it('повтор, пока первый в полёте → 409 request_in_progress', async () => {
    // Барьер делает окно «в полёте» наблюдаемым. Именно этот тест краснеет
    // на наивной реализации «проверил — записал».
    const gate = barrier();
    const app = await startApp({ commit: () => gate.wait() });
    const key = cryptoKey();
    const body = validBody();

    const first = app.create(body, { key });
    await gate.entered;

    const second = await withTimeout(
      app.create(body, { key }),
      2000,
      'второй запрос не получил отказа, а ушёл в ту же фиксацию: ключ не забронирован',
    );
    assert.equal(second.status, 409);
    assert.equal(asError(second.body).error.code, 'request_in_progress');

    gate.release();
    assert.equal((await first).status, 201);

    const list = (await app.list()).body as { payments: unknown[] };
    assert.equal(list.payments.length, 1);
  });

  it('после того как первый долетел, тот же ключ отвечает повтором', async () => {
    const gate = barrier();
    const app = await startApp({ commit: () => gate.wait() });
    const key = cryptoKey();
    const body = validBody();

    const first = app.create(body, { key });
    await gate.entered;
    gate.release();
    const created = asPayment((await first).body);

    const second = await app.create(body, { key });
    assert.equal(second.status, 200);
    assert.equal(asPayment(second.body).id, created.id);
  });
});

/**
 * Инварианты, которые до ревью #47 держались на дисциплине автора, а не
 * на устройстве кода: мутации по ним давали 175 зелёных. Каждый из трёх
 * проверен мутацией отдельно — без него краснеет ровно этот набор.
 */
describe('Инварианты брони ключа', () => {
  it('сорвавшаяся фиксация освобождает ключ, а не держит его вечно', async () => {
    let failing = true;
    const app = await startApp({
      commit: () => {
        if (failing) throw new Error('фиксация сорвалась');
      },
    });
    const key = cryptoKey();
    const body = validBody();

    // Ответ 500 контрактом не описан, поэтому мимо проверки соответствия.
    const failed = await app.raw('POST', '/v1/payments', {
      headers: {
        'Content-Type': 'application/json',
        'X-Merchant-Id': MERCHANT,
        'Idempotency-Key': key,
      },
      body: JSON.stringify(body),
    });
    assert.equal(failed.status, 500);

    failing = false;
    const retry = await app.create(body, { key });
    assert.equal(
      retry.status,
      201,
      'сорвавшееся создание не имеет права держать ключ занятым: повторять клиенту нечего',
    );

    const list = (await app.list()).body as { payments: unknown[] };
    assert.equal(list.payments.length, 1);
  });

  it('освобождение не снимает чужую бронь, поставленную после истечения TTL', async () => {
    const clock = testClock();
    const gate = barrier();
    let calls = 0;
    const app = await startApp({
      clock,
      commit: async () => {
        calls += 1;
        if (calls === 1) {
          await gate.wait();
          throw new Error('первая фиксация сорвалась');
        }
      },
    });
    const key = cryptoKey();
    const body = validBody();

    // A уходит в фиксацию и застревает там.
    const first = app.raw('POST', '/v1/payments', {
      headers: {
        'Content-Type': 'application/json',
        'X-Merchant-Id': MERCHANT,
        'Idempotency-Key': key,
      },
      body: JSON.stringify(body),
    });
    await gate.entered;

    // Ключ истекает, пока A ещё в полёте, и B занимает его заново.
    clock.advance(DAY_MS + 1);
    const second = await app.create(body, { key });
    assert.equal(second.status, 201);

    // A срывается и снимает СВОЮ бронь. Чужую трогать не имеет права.
    gate.release();
    assert.equal((await first).status, 500);

    const replay = await app.create(body, { key });
    assert.equal(replay.status, 200, 'бронь B пережила освобождение брони A');
    assert.equal(asPayment(replay.body).id, asPayment(second.body).id);
  });

  it('другое тело при первом в полёте → конфликт ключа, а не гонка', async () => {
    // Порядок внутри reserve: конфликт тела разбирается раньше состояния
    // «в полёте». Он окончателен, повтор позже его не исправит, тогда как
    // request_in_progress — приглашение повторить. Перепутать их значит
    // позвать клиента повторять запрос, который никогда не пройдёт.
    const gate = barrier();
    const app = await startApp({ commit: () => gate.wait() });
    const key = cryptoKey();

    const first = app.create(validBody(), { key });
    await gate.entered;

    const conflict = await withTimeout(
      app.create(validBody({ amount_minor: 999 }), { key }),
      2000,
      'запрос с другим телом ушёл в фиксацию вместо отказа',
    );
    assert.equal(conflict.status, 409);
    assert.equal(asError(conflict.body).error.code, 'idempotency_key_reuse');

    gate.release();
    assert.equal((await first).status, 201);
  });
});

describe('F5 · TTL ключа', () => {
  it('внутри окна повтор возвращает тот же платёж', async () => {
    const clock = testClock();
    const app = await startApp({ clock });
    const key = cryptoKey();
    const body = validBody();

    const first = asPayment((await app.create(body, { key })).body);
    clock.advance(DAY_MS - 1);
    const second = await app.create(body, { key });

    assert.equal(second.status, 200);
    assert.equal(asPayment(second.body).id, first.id);
  });

  it('после истечения тот же ключ создаёт новый платёж', async () => {
    const clock = testClock();
    const app = await startApp({ clock });
    const key = cryptoKey();
    const body = validBody();

    const first = asPayment((await app.create(body, { key })).body);
    clock.advance(DAY_MS + 1);
    const second = await app.create(body, { key });

    assert.equal(second.status, 201);
    assert.notEqual(asPayment(second.body).id, first.id);

    const list = (await app.list()).body as { payments: unknown[] };
    assert.equal(list.payments.length, 2, 'после TTL платежей обязано стать два');
  });

  it('после истечения тот же ключ с другим телом больше не конфликтует', async () => {
    const clock = testClock();
    const app = await startApp({ clock });
    const key = cryptoKey();

    await app.create(validBody(), { key });
    clock.advance(DAY_MS + 1);
    const second = await app.create(validBody({ amount_minor: 777 }), { key });

    assert.equal(second.status, 201);
  });

  it('TTL по умолчанию — ровно 24 часа', async () => {
    const clock = testClock();
    const app = await startApp({ clock });
    const key = cryptoKey();
    const body = validBody();

    await app.create(body, { key });
    clock.advance(DAY_MS);
    // Ровно на границе ключ ещё жив: истечение наступает после окна, не в нём.
    assert.equal((await app.create(body, { key })).status, 200);
  });
});

describe('F6 · ключ уникален в пределах мерчанта', () => {
  it('один ключ у двух мерчантов — два независимых платежа', async () => {
    const app = await startApp();
    const key = cryptoKey();
    const body = validBody();

    const mine = await app.create(body, { key, merchant: MERCHANT });
    const theirs = await app.create(body, { key, merchant: OTHER_MERCHANT });

    assert.equal(mine.status, 201);
    assert.equal(theirs.status, 201);
    assert.notEqual(asPayment(theirs.body).id, asPayment(mine.body).id);
  });

  it('чужой ключ с другим телом не порождает конфликт у соседа', async () => {
    const app = await startApp();
    const key = cryptoKey();

    await app.create(validBody(), { key, merchant: MERCHANT });
    const theirs = await app.create(validBody({ amount_minor: 4321 }), {
      key,
      merchant: OTHER_MERCHANT,
    });

    assert.equal(theirs.status, 201);
  });

  it('каждый мерчант видит в списке только свой платёж', async () => {
    const app = await startApp();
    const key = cryptoKey();
    const body = validBody();

    const mine = asPayment((await app.create(body, { key, merchant: MERCHANT })).body);
    const theirs = asPayment((await app.create(body, { key, merchant: OTHER_MERCHANT })).body);

    const mineList = (await app.list(MERCHANT)).body as { payments: { id: string }[] };
    const theirsList = (await app.list(OTHER_MERCHANT)).body as { payments: { id: string }[] };

    assert.deepEqual(
      mineList.payments.map((p) => p.id),
      [mine.id],
    );
    assert.deepEqual(
      theirsList.payments.map((p) => p.id),
      [theirs.id],
    );
  });
});
