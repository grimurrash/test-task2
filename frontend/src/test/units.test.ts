import { describe, expect, it, vi, afterEach } from 'vitest'
import { formatAmount } from '../lib/money'
import { semanticFor, verdictFor, shortKey } from '../lib/semantics'
import { keyHue } from '../lib/keyhue'
import { buildBody, entryFromResult, groupSemantic, parseAmountInput } from '../App'
import { createPayment } from '../api/client'

afterEach(() => vi.restoreAllMocks())

describe('деньги: минорные единицы → строка', () => {
  it('12002 RUB → 120,02 RUB', () => {
    expect(formatAmount(12002, 'RUB')).toBe('120,02 RUB')
  })
  it('граница безопасного целого — без потери копейки (#92)', () => {
    expect(formatAmount(9007199254740991, 'RUB').replace(/ /g, ' ')).toBe(
      '90 071 992 547 409,91 RUB',
    )
    expect(formatAmount(1, 'RUB')).toBe('0,01 RUB')
    expect(formatAmount(99, 'USD')).toBe('0,99 USD')
  })
  it('149000 RUB → 1 490,00 RUB (неразрывный пробел Intl)', () => {
    expect(formatAmount(149000, 'RUB').replace(/ /g, ' ')).toBe('1 490,00 RUB')
  })
})

describe('семантика ответа (U3)', () => {
  it('201 — created/новый, 200 — repeat/тот же', () => {
    expect(semanticFor(201)).toBe('created')
    expect(verdictFor(201)).toBe('new')
    expect(semanticFor(200)).toBe('repeat')
    expect(verdictFor(200)).toBe('same')
  })
  it('409 — conflict; 400, 422 и прочее — error; null — network', () => {
    expect(semanticFor(409)).toBe('conflict')
    expect(semanticFor(400)).toBe('error')
    expect(semanticFor(422)).toBe('error')
    expect(semanticFor(500)).toBe('error')
    expect(semanticFor(null)).toBe('network')
  })
})

describe('тело запроса: строго четыре поля контракта', () => {
  it('целая сумма уходит числом, пустое описание не отправляется', () => {
    const raw = buildBody({ amount: '125000', currency: 'RUB', orderId: 'ORD-1', description: '' })
    expect(JSON.parse(raw)).toEqual({ amount_minor: 125000, currency: 'RUB', order_id: 'ORD-1' })
  })
  it('нечисловая сумма уходит строкой — сервер ответит 422', () => {
    expect(parseAmountInput('сто')).toBe('сто')
    expect(parseAmountInput('1.5')).toBe(1.5)
    expect(parseAmountInput('0')).toBe(0)
  })
  it('искажаемый Number() ввод не подменяется: hex, экспонента и потеря точности уходят строкой', () => {
    expect(parseAmountInput('0x10')).toBe('0x10')
    expect(parseAmountInput('1e3')).toBe('1e3')
    expect(parseAmountInput('1.0000000000000000001')).toBe('1.0000000000000000001')
    expect(parseAmountInput('9007199254740993')).toBe('9007199254740993')
  })
})

describe('клиент: транспорт не пересериализует тело', () => {
  it('строка тела передаётся в fetch как есть, оба ответа разобраны', async () => {
    const raw = '{"amount_minor":125000,"currency":"RUB","order_id":"ORD-1"}'
    // Свежий Response на каждый вызов: тело Response читается один раз
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(() =>
        Promise.resolve(new Response('{"id":"pay_1"}', { status: 201 })),
      )
    const first = await createPayment(raw, 'key-1', 'demo-shop-a')
    const second = await createPayment(raw, 'key-1', 'demo-shop-a')
    expect(first).toEqual({ kind: 'http', status: 201, body: { id: 'pay_1' } })
    expect(second).toEqual({ kind: 'http', status: 201, body: { id: 'pay_1' } })
    expect(spy).toHaveBeenCalledTimes(2)
    const bodies = spy.mock.calls.map((c) => (c[1] as RequestInit).body)
    expect(bodies[0]).toBe(raw)
    expect(bodies[1]).toBe(raw)
    const headers = spy.mock.calls.map(
      (c) => ((c[1] as RequestInit).headers as Record<string, string>)['Idempotency-Key'],
    )
    expect(headers[0]).toBe('key-1')
    expect(headers[1]).toBe('key-1')
  })
})

describe('журнал: запись из результата', () => {
  it('сетевой сбой на создании советует повтор с ключом, на отмене — нет', () => {
    const net = { kind: 'network' as const, message: 'Failed to fetch' }
    const create = entryFromResult('create', '/v1/payments', net, 'k')
    const cancel = entryFromResult('cancel', '/v1/payments/pay_1/cancel', net)
    expect(create.note).toContain('Failed to fetch')
    expect(create.note).toContain('повторить с тем же ключом')
    expect(cancel.note).toContain('Failed to fetch')
    expect(cancel.note).not.toContain('ключ')
  })
  it('422 собирает message и карту нарушений в текст записи', () => {
    const res = {
      kind: 'http' as const,
      status: 422,
      body: {
        error: {
          code: 'validation_failed',
          message: 'Тело запроса не прошло валидацию',
          details: { errors: { amount_minor: 'целое строго больше нуля' } },
        },
      },
    }
    const entry = entryFromResult('create', '/v1/payments', res, 'k')
    expect(entry.semantic).toBe('error')
    expect(entry.errorCode).toBe('validation_failed')
    expect(entry.note).toContain('amount_minor — целое строго больше нуля')
  })
  it('семантика группы выводится из фактических записей', () => {
    const net = { kind: 'network' as const, message: 'x' }
    const both = [
      entryFromResult('create', '/v1/payments', net),
      entryFromResult('create', '/v1/payments', net),
    ]
    expect(groupSemantic(both)).toBe('network')
    const mixed = [
      entryFromResult('create', '/v1/payments', { kind: 'http', status: 201, body: { id: 'p' } }),
      entryFromResult('create', '/v1/payments', {
        kind: 'http',
        status: 409,
        body: { error: { code: 'request_in_progress', message: 'в полёте' } },
      }),
    ]
    expect(groupSemantic(mixed)).toBe('conflict')
  })
})

describe('чип ключа: hash → hue стабилен', () => {
  it('одинаковый ключ — одинаковый оттенок, разные — разные', () => {
    expect(keyHue('abc')).toBe(keyHue('abc'))
    expect(keyHue('abc')).not.toBe(keyHue('abd'))
  })
  it('длинный ключ обрезается как 8…4', () => {
    expect(shortKey('3f9c1b8e-5a02-4d67-9c11-8de402aa71f5')).toBe('3f9c1b8e…71f5')
  })
})
