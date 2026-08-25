import { describe, expect, it, vi, afterEach } from 'vitest'
import { formatAmount } from '../lib/money'
import { semanticFor, verdictFor, shortKey } from '../lib/semantics'
import { keyHue } from '../lib/keyhue'
import { buildBody, parseAmountInput } from '../App'
import { createPayment } from '../api/client'

afterEach(() => vi.restoreAllMocks())

describe('деньги: минорные единицы → строка', () => {
  it('12002 RUB → 120,02 RUB', () => {
    expect(formatAmount(12002, 'RUB')).toBe('120,02 RUB')
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
})

describe('U2: повтор шлёт тело байт-в-байт', () => {
  it('строка тела передаётся в fetch без пересериализации', async () => {
    const raw = '{"amount_minor":125000,"currency":"RUB","order_id":"ORD-1"}'
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{}', { status: 201 }),
    )
    await createPayment(raw, 'key-1', 'demo-shop-a')
    await createPayment(raw, 'key-1', 'demo-shop-a')
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

describe('чип ключа: hash → hue стабилен', () => {
  it('одинаковый ключ — одинаковый оттенок, разные — разные', () => {
    expect(keyHue('abc')).toBe(keyHue('abc'))
    expect(keyHue('abc')).not.toBe(keyHue('abd'))
  })
  it('длинный ключ обрезается как 8…4', () => {
    expect(shortKey('3f9c1b8e-5a02-4d67-9c11-8de402aa71f5')).toBe('3f9c1b8e…71f5')
  })
})
