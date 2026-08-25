import type { components } from './schema'

export type Payment = components['schemas']['Payment']
export type ApiErrorBody = components['schemas']['Error']
export type PaymentListBody = components['schemas']['PaymentList']

// Адрес API — из окружения сборки; порт 8080 согласован по доске (#12).
export const API_BASE: string =
  (import.meta.env.VITE_API_BASE as string | undefined) || 'http://localhost:8080'

// Ответ клиента различает две судьбы запроса: HTTP-ответ пришёл (любой код)
// или ответа нет вовсе — сеть, CORS, обрыв. Журнал рисует их по-разному (C7).
export type HttpResult =
  | { kind: 'http'; status: number; body: unknown }
  | { kind: 'network'; message: string }

async function request(
  path: string,
  init: RequestInit,
): Promise<HttpResult> {
  try {
    const res = await fetch(API_BASE + path, init)
    let body: unknown = null
    const text = await res.text()
    if (text) {
      try {
        body = JSON.parse(text)
      } catch {
        body = text
      }
    }
    return { kind: 'http', status: res.status, body }
  } catch (e) {
    return { kind: 'network', message: e instanceof Error ? e.message : String(e) }
  }
}

// Тело передаётся уже сериализованной строкой: «Отправить ещё раз тот же
// запрос» (U2) обязан повторить его байт-в-байт, поэтому строка — единица
// хранения, а не объект.
export function createPayment(rawBody: string, key: string, merchant: string) {
  return request('/v1/payments', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': key,
      'X-Merchant-Id': merchant,
    },
    body: rawBody,
  })
}

export function listPayments(merchant: string) {
  return request('/v1/payments', {
    method: 'GET',
    headers: { 'X-Merchant-Id': merchant },
  })
}

export function cancelPayment(id: string, merchant: string) {
  return request(`/v1/payments/${encodeURIComponent(id)}/cancel`, {
    method: 'POST',
    headers: { 'X-Merchant-Id': merchant },
  })
}
