// Сумма хранится в минорных единицах; у RUB/USD/EUR их две на единицу валюты.
const fmt = new Intl.NumberFormat('ru-RU', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})

export function formatAmount(minor: number, currency: string): string {
  if (!Number.isFinite(minor)) return `${minor} ${currency}`
  return `${fmt.format(minor / 100)} ${currency}`
}
