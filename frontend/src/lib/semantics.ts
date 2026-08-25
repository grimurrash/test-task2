import type { Semantic } from '../types'

// Цвет записи журнала выводится из кода ответа, а не из белого списка кодов
// ошибок: новый код контракта (#32 добавляет 400 malformed_request и
// invalid_idempotency_key) отобразится честно, без «неизвестной ошибки».
export function semanticFor(status: number | null): Semantic {
  if (status === null) return 'network'
  if (status === 201) return 'created'
  if (status === 200) return 'repeat'
  if (status === 409) return 'conflict'
  return 'error'
}

// «Новый платёж» против «тот же платёж» — по паре 201/200 на создании (U3).
export function verdictFor(status: number | null): 'new' | 'same' | undefined {
  if (status === 201) return 'new'
  if (status === 200) return 'same'
  return undefined
}

export function nowTime(): string {
  return new Date().toLocaleTimeString('ru-RU', { hour12: false })
}

export function shortKey(key: string): string {
  if (key.length <= 14) return key
  return `${key.slice(0, 8)}…${key.slice(-4)}`
}
