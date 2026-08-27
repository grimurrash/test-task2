/**
 * D1 и D3 — требования к документации, проверенные по артефакту, а не по прозе.
 *
 * Оба требования до задачи #180 не охранял никто: сверка покрытия (A4)
 * потребовала на каждое требование раздела 5 тест, который покраснеет при
 * нарушении. Здесь проверяется ровно то, о чём требование говорит:
 * контракт описывает всё, что сервис отдаёт, и содержит раздел про
 * идемпотентность человеческим языком.
 *
 * Требования D2, D4 и R1–R6 сюда сознательно НЕ добавлены. Проверка вида
 * «в README есть слово» осталась бы зелёной при сломанном `docker compose up`,
 * то есть была бы проверкой, которая выглядит проверкой. Они стоят в
 * `docs/product/requirements-coverage.md` с написанной причиной, и сверка
 * покрытия читает этот файл: слабость названа, а не спрятана за пометкой.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { contract } from './support/contract.js';
import { MERCHANT, startApp, validBody, asPayment, cryptoKey } from './support/harness.js';

/** Исходник, а не собранный файл: перечень кодов читает человек. */
function errorsSource(): string {
  // dist/test/delivery.test.js → dist → backend → backend/src/domain/errors.ts
  const here = path.dirname(fileURLToPath(import.meta.url));
  return readFileSync(path.resolve(here, '..', '..', 'src', 'domain', 'errors.ts'), 'utf8');
}

/** Коды, объявленные в коде частью контракта. */
function codesInCode(): Set<string> {
  const source = errorsSource();
  const start = source.indexOf('export type ContractErrorCode');
  assert.ok(start >= 0, 'в errors.ts нет типа ContractErrorCode — перечень читать неоткуда');
  const end = source.indexOf(';', start);
  const block = source.slice(start, end);
  const found = block.match(/'([a-z_]+)'/g) ?? [];
  const codes = new Set(found.map((quoted) => quoted.slice(1, -1)));
  assert.ok(codes.size > 0, 'перечень кодов в errors.ts разобран пустым — проверять нечего');
  return codes;
}

/** Коды, перечисленные контрактом. */
function codesInContract(): Set<string> {
  const schemas = (contract['components'] as Record<string, unknown>)['schemas'] as Record<
    string,
    Record<string, unknown>
  >;
  const values = schemas['ErrorCode']?.['enum'];
  assert.ok(Array.isArray(values), 'в контракте нет перечня ErrorCode');
  return new Set(values as string[]);
}

interface Operation {
  parameters?: { $ref?: string }[];
}

function operations(): { route: string; method: string; operation: Operation }[] {
  const paths = contract['paths'] as Record<string, Record<string, unknown>>;
  const found: { route: string; method: string; operation: Operation }[] = [];
  for (const [route, methods] of Object.entries(paths)) {
    for (const [method, operation] of Object.entries(methods)) {
      found.push({ route, method, operation: operation as Operation });
    }
  }
  return found;
}

describe('@req D1 контракт описывает всё, что сервис отдаёт', () => {
  it('@req D1 перечень кодов ошибок в контракте совпадает с перечнем в коде', () => {
    const inCode = codesInCode();
    const inContract = codesInContract();

    const onlyInCode = [...inCode].filter((c) => !inContract.has(c));
    const onlyInContract = [...inContract].filter((c) => !inCode.has(c));

    assert.deepEqual(
      { onlyInCode, onlyInContract },
      { onlyInCode: [], onlyInContract: [] },
      'Код и контракт разошлись перечнем ошибок. Новый код ошибки обязан ' +
        'попасть в контракт: иначе интегратор встретит его первым в проде.',
    );
  });

  it('@req D1 контракт описывает хотя бы один маршрут — разбор не холостой', () => {
    assert.ok(operations().length >= 4, `операций в контракте: ${String(operations().length)}`);
  });

  for (const { route, method } of operations()) {
    it(`@req D1 ${method.toUpperCase()} ${route} действительно обслуживается сервисом`, async () => {
      const app = await startApp();
      const created = await app.create(validBody(), { key: cryptoKey() });
      const id = asPayment(created.body).id;
      const url = route.replace('{id}', encodeURIComponent(id));

      const res = await app.raw(method.toUpperCase(), url, {
        headers: { 'X-Merchant-Id': MERCHANT, 'Idempotency-Key': cryptoKey() },
      });

      // Описан контрактом, но не обслуживается — это «адреса нет» (404
      // `not_found`) или «метод не тот» (405). Оба означают, что документация
      // обещает то, чего нет.
      const code = (res.body as { error?: { code?: string } } | undefined)?.error?.code;
      assert.notEqual(code, 'not_found', `контракт описывает ${method} ${route}, сервис — нет`);
      assert.notEqual(res.status, 405, `контракт описывает ${method} ${route}, сервис — нет`);
    });
  }

  it('@req D1 обязательные заголовки описаны параметрами, а не только словами', () => {
    const create = operations().find((o) => o.route === '/v1/payments' && o.method === 'post');
    const refs = (create?.operation.parameters ?? []).map((p) => p.$ref ?? '');

    assert.ok(
      refs.some((r) => r.endsWith('/XMerchantId')),
      'создание платежа не ссылается на параметр X-Merchant-Id',
    );
    assert.ok(
      refs.some((r) => r.endsWith('/IdempotencyKey')),
      'создание платежа не ссылается на параметр Idempotency-Key',
    );
  });
});

describe('@req D3 раздел «Идемпотентность» человеческим языком', () => {
  const info = contract['info'] as { description?: string };
  const description = info.description ?? '';
  const section = description.slice(description.indexOf('## Идемпотентность'));

  it('@req D3 раздел есть в источнике страницы, а не только в голове автора', () => {
    assert.ok(
      description.includes('## Идемпотентность'),
      'страница документации собирается из контракта, и раздела в нём нет',
    );
    assert.ok(section.length > 200, 'раздел есть заголовком, но пуст по существу');
  });

  for (const [what, marker] of [
    ['что такое ключ', /ключ/i],
    ['сколько живёт', /24 часа|TTL/],
    ['что будет при конфликте', /409|конфликт/i],
    ['что при гонке', /гонк|одновременн|request_in_progress/i],
  ] as [string, RegExp][]) {
    it(`@req D3 раздел говорит: ${what}`, () => {
      assert.match(section, marker, `в разделе «Идемпотентность» нет ответа на «${what}»`);
    });
  }
});
