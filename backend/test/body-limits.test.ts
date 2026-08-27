/**
 * F20 — три полосы тела, а не одна.
 *
 * Требование состоит из двух половин, и до этого файла проверялась только
 * первая: тело больше 1 МБ не разбирается → 400 `malformed_request`. Вторая —
 * «до 8 МБ тело дочитывается и отбрасывается, чтобы ответ дошёл до клиента
 * целым; выше — соединение рвётся» — держалась на коде и ничьей памяти:
 * `MAX_DRAIN_BYTES` не упоминал ни один тест (задача #180).
 *
 * Полосы прижаты к самим константам, а не взяты «с запасом»: сдвиг предела
 * разбора или предела дочитывания обязан красить набор, иначе константа
 * снова остаётся неохраняемой.
 *
 * Обе границы объявлены здесь заново намеренно. Импортировать их из `src`
 * означало бы проверять код им же самим: правка константы поехала бы вместе
 * с тестом и осталась незамеченной.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { asError, cryptoKey, startApp, withTimeout } from './support/harness.js';

/** Предел разбора: выше него тело не разбирается (`app.ts`, MAX_BODY_BYTES). */
const PARSE_LIMIT = 1024 * 1024;
/** Предел дочитывания: выше него рвётся соединение (`app.ts`, MAX_DRAIN_BYTES). */
const DRAIN_LIMIT = 8 * 1024 * 1024;

/**
 * Тело ровно заданной длины в байтах.
 *
 * Все поля ASCII, поэтому длина строки равна длине в байтах, и границу можно
 * прижать точно, а не «примерно». Добивка идёт в `description`: поле
 * необязательное, ограничено 512 символами, и превышение видно ответом 422 —
 * то есть по ответу понятно, что тело **разобрано**.
 */
function bodyOfExactly(bytes: number): string {
  const shell = JSON.stringify({
    amount_minor: 125000,
    currency: 'RUB',
    order_id: 'body-limit-probe',
    description: '',
  });
  const padding = bytes - shell.length;
  assert.ok(padding >= 0, `тело короче собственной оболочки: ${String(bytes)} байт`);
  return JSON.stringify({
    amount_minor: 125000,
    currency: 'RUB',
    order_id: 'body-limit-probe',
    description: 'x'.repeat(padding),
  });
}

describe('@req F20 · полоса до предела разбора: тело разбирается', () => {
  it('@req F20 тело заметно ниже предела разобрано: 422 про поле, а не 400 про форму', async () => {
    const app = await startApp();
    const res = await app.create(undefined, {
      key: cryptoKey(),
      rawBody: bodyOfExactly(900_000),
    });

    // 422 доказывает разбор сильнее, чем 201: нарушение названо по полю,
    // а назвать его, не прочитав поле, нельзя. 201 дал бы и сервер,
    // не читающий тело вовсе.
    assert.equal(res.status, 422);
    assert.equal(asError(res.body).error.code, 'validation_failed');
    assert.ok(asError(res.body).error.details?.errors?.['description']);
  });

  it('@req F20 тело ровно в предел разбора ещё разбирается', async () => {
    const app = await startApp();
    const res = await app.create(undefined, {
      key: cryptoKey(),
      rawBody: bodyOfExactly(PARSE_LIMIT),
    });

    assert.equal(res.status, 422, 'предел включительный: ровно 1 МБ — ещё разбираем');
    assert.equal(asError(res.body).error.code, 'validation_failed');
  });
});

describe('@req F20 · полоса между пределами: ответ доходит целым', () => {
  it('@req F20 на байт выше предела разбора — 400 malformed_request', async () => {
    const app = await startApp();
    const res = await app.create(undefined, {
      key: cryptoKey(),
      rawBody: bodyOfExactly(PARSE_LIMIT + 1),
    });

    assert.equal(res.status, 400);
    assert.equal(asError(res.body).error.code, 'malformed_request');
  });

  it('@req F20 тело ровно в предел дочитывания: ответ пришёл целиком, соединение не оборвано', async () => {
    const app = await startApp();
    const res = await app.create(undefined, {
      key: cryptoKey(),
      rawBody: bodyOfExactly(DRAIN_LIMIT),
    });

    assert.equal(res.status, 400);
    assert.equal(asError(res.body).error.code, 'malformed_request');
    // Целость ответа — не код, а то, что тело дошло разбираемым до конца:
    // конверт ошибки полон, а не оборван на середине.
    assert.deepEqual(JSON.parse(res.text), res.body);
    assert.ok(asError(res.body).error.message.length > 0);
  });
});

describe('@req F20 · выше предела дочитывания: соединение рвётся', () => {
  it('@req F20 на байт выше предела дочитывания ответа нет — обрыв, а не 400', async () => {
    const app = await startApp();

    // Заголовки обязаны быть валидными: без мерчанта или ключа сервер ответил бы
    // раньше чтения тела, Node всё равно порвал бы недочитанное соединение,
    // и тест был бы зелёным по чужой причине — в том числе со снятым пределом.
    // Поэтому проба идёт через `create`, который проставляет их все.
    const attempt = app.create(undefined, {
      key: cryptoKey(),
      rawBody: bodyOfExactly(DRAIN_LIMIT + 1),
    });

    // Потолок по времени: если сброса не будет, прогон обязан покраснеть
    // с внятной причиной, а не повиснуть.
    await assert.rejects(
      withTimeout(attempt, 20_000, 'сервер не оборвал соединение за 20 секунд'),
      (error: unknown) => {
        assert.ok(
          error instanceof TypeError,
          `ожидался сетевой отказ, получено: ${String(error)}`,
        );
        return true;
      },
    );
  });
});
