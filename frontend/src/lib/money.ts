// Сумма хранится в минорных единицах; у RUB/USD/EUR их две на единицу валюты.
// Деление на 100 через double врёт на границе безопасного целого
// (9007199254740991 / 100 → …409.90625 → «,90» при минорных …91), поэтому
// копейки отделяются строкой, а разряды группирует Intl по BigInt — точно
// на всём диапазоне контракта (#92).
const fmtInt = new Intl.NumberFormat('ru-RU')

export function formatAmount(minor: number, currency: string): string {
  if (!Number.isInteger(minor)) return `${minor} ${currency}`
  const sign = minor < 0 ? '−' : ''
  const digits = Math.abs(minor).toString().padStart(3, '0')
  const whole = digits.slice(0, -2)
  const cents = digits.slice(-2)
  return `${sign}${fmtInt.format(BigInt(whole))},${cents} ${currency}`
}
