/**
 * A7, проверка самой проверки.
 *
 * Прежде чем ловить расхождения сервера с контрактом, обвязка обязана доказать,
 * что умеет их ловить. Здесь через тот же валидатор прогоняются **примеры
 * из самого контракта**: не пройдут они — дефект в обвязке, а не в API.
 * Отдельно проверено место, где реализации OpenAPI 3.1 расходятся чаще всего:
 * `status_reason` с типом `[string, 'null']` и `null` внутри `enum`.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  assertValidAgainst,
  contract,
  responseSchemaPointer,
} from './support/contract.js';

interface ExampleEntry {
  summary?: string;
  value: unknown;
}

function responseExamples(): {
  route: string;
  method: string;
  status: number;
  name: string;
  value: unknown;
}[] {
  const found: { route: string; method: string; status: number; name: string; value: unknown }[] =
    [];
  const paths = contract['paths'] as Record<string, Record<string, unknown>>;

  for (const [route, operations] of Object.entries(paths)) {
    for (const [method, operation] of Object.entries(operations)) {
      const responses = (operation as Record<string, unknown>)['responses'] as Record<
        string,
        Record<string, unknown>
      >;
      for (const [status, response] of Object.entries(responses)) {
        // Ответы-ссылки (`$ref` на components/responses) разбираются помощником;
        // здесь берутся только те примеры, что лежат прямо в операции.
        const content = response['content'] as
          | Record<string, Record<string, unknown>>
          | undefined;
        const examples = content?.['application/json']?.['examples'] as
          | Record<string, ExampleEntry>
          | undefined;
        if (!examples) continue;
        for (const [name, entry] of Object.entries(examples)) {
          found.push({ route, method, status: Number(status), name, value: entry.value });
        }
      }
    }
  }
  return found;
}

describe('Контракт проверяет сам себя', () => {
  const examples = responseExamples();

  it('в контракте есть примеры ответов, которые можно проверить', () => {
    assert.ok(examples.length >= 10, `примеров ответов найдено ${examples.length}, ожидалось больше`);
  });

  for (const { route, method, status, name, value } of examples) {
    it(`пример «${name}» для ${status} ${method.toUpperCase()} ${route} проходит свою же схему`, () => {
      assertValidAgainst(
        responseSchemaPointer(route, method, status),
        value,
        `Пример контракта «${name}»`,
      );
    });
  }
});

describe('Валидатор действительно валидирует', () => {
  const paymentSchema = '/components/schemas/Payment';

  it('принимает status_reason: null (место расхождения реализаций 3.1)', () => {
    assertValidAgainst(
      paymentSchema,
      {
        id: 'pay_1',
        status: 'pending',
        status_reason: null,
        amount_minor: 1000,
        currency: 'RUB',
        order_id: 'o-1',
        description: null,
        created_at: '2026-08-25T12:00:00.000Z',
      },
      'Платёж с null-причиной',
    );
  });

  it('отвергает статус вне перечня', () => {
    assert.throws(() =>
      assertValidAgainst(
        paymentSchema,
        {
          id: 'pay_1',
          status: 'refunded',
          status_reason: null,
          amount_minor: 1000,
          currency: 'RUB',
          order_id: 'o-1',
          description: null,
          created_at: '2026-08-25T12:00:00.000Z',
        },
        'Платёж с чужим статусом',
      ),
    );
  });

  it('отвергает status_reason вне перечня', () => {
    assert.throws(() =>
      assertValidAgainst(
        paymentSchema,
        {
          id: 'pay_1',
          status: 'failed',
          status_reason: 'insufficient_funds',
          amount_minor: 1000,
          currency: 'RUB',
          order_id: 'o-1',
          description: null,
          created_at: '2026-08-25T12:00:00.000Z',
        },
        'Платёж с чужой причиной',
      ),
    );
  });

  it('отвергает платёж без обязательного поля', () => {
    assert.throws(() =>
      assertValidAgainst(
        paymentSchema,
        {
          id: 'pay_1',
          status: 'pending',
          amount_minor: 1000,
          currency: 'RUB',
          order_id: 'o-1',
          description: null,
          created_at: '2026-08-25T12:00:00.000Z',
        },
        'Платёж без status_reason',
      ),
    );
  });

  it('отвергает created_at не по RFC 3339', () => {
    assert.throws(() =>
      assertValidAgainst(
        paymentSchema,
        {
          id: 'pay_1',
          status: 'pending',
          status_reason: null,
          amount_minor: 1000,
          currency: 'RUB',
          order_id: 'o-1',
          description: null,
          created_at: '25.08.2026 12:00',
        },
        'Платёж с самодельной датой',
      ),
    );
  });

  it('отвергает код ошибки вне перечня восьми', () => {
    assert.throws(() =>
      assertValidAgainst(
        '/components/schemas/Error',
        { error: { code: 'invalid_amount', message: 'снятый код из PRD' } },
        'Ошибка со снятым кодом',
      ),
    );
  });
});
