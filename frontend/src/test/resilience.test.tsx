// #104, находка 2: неожидаемое значение портит одну карточку, а не страницу.
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { formatAmount } from '../lib/money'
import { CardBoundary } from '../components/CardBoundary'
import { PaymentsList } from '../components/PaymentsList'
import type { Payment } from '../api/client'
// Слабый детектор для находки 1 — границы названы ниже, у своего теста.
// Файл читается через fs: vitest подменяет любой импорт .css, включая ?raw,
// а import.meta.url в jsdom-среде не file-схема. cwd тестов — корень пакета.
import { readFileSync } from 'node:fs'

const appCss = readFileSync('src/app.css', 'utf8')

describe('formatAmount никогда не бросает', () => {
  it('вне безопасных целых — значение как есть, без исключения', () => {
    expect(() => formatAmount(1e21, 'RUB')).not.toThrow()
    expect(formatAmount(1e21, 'RUB')).toBe('1e+21 RUB')
    expect(formatAmount(9007199254740992, 'RUB')).toBe('9007199254740992 RUB')
    expect(formatAmount(NaN, 'RUB')).toBe('NaN RUB')
    expect(formatAmount(1.5, 'RUB')).toBe('1.5 RUB')
  })
})

describe('граница ошибки: падает блок, не страница', () => {
  it('карточка с бросающим рендером заменяется заглушкой, соседи живы, причина уходит в консоль', () => {
    const Bomb = () => {
      throw new Error('boom')
    }
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    render(
      <>
        <CardBoundary label="Блок A">
          <Bomb />
        </CardBoundary>
        <CardBoundary label="Блок B">
          <p>сосед жив</p>
        </CardBoundary>
      </>,
    )
    expect(screen.getByText(/Блок A не отобразился: boom/)).toBeInTheDocument()
    expect(screen.getByText('сосед жив')).toBeInTheDocument()
    // тихий отказ не совсем тихий: явная запись причины со стеком компонента
    expect(
      consoleSpy.mock.calls.some((args) => String(args[0]).includes('«Блок A» не отобразился')),
    ).toBe(true)
  })

  it('платёж с суммой 1e21 рендерится как есть и не роняет список', () => {
    const weird: Payment = {
      id: 'pay_weird',
      status: 'pending',
      status_reason: null,
      amount_minor: 1e21,
      currency: 'RUB',
      order_id: 'ORD-W',
      description: null,
      created_at: '2026-08-25T12:00:00.000Z',
    }
    render(<PaymentsList merchant="demo-shop-a" payments={[weird]} note={null} />)
    expect(screen.getByText('1e+21 RUB')).toBeInTheDocument()
  })
})

// #104, находка 1 — решение проджекта, границы названы явно:
// это утверждение на ТЕКСТ app.css. Оно ловит УДАЛЕНИЕ правила переноса
// у карточки и НЕ ловит обход — новый флекс-контейнер внутри карточки,
// перекрытие правила более специфичным селектором, перенос разметки в другой
// класс. Настоящего детектора (замера раскладки в браузере) в тестах нет;
// не считать класс охраняемым на основании этого теста.
describe('слабый детектор правила переноса карточки', () => {
  it('overflow-wrap: anywhere объявлен на .payment (ловит удаление, не обход)', () => {
    expect(appCss).toMatch(/\.payment\s*{[^}]*overflow-wrap:\s*anywhere/s)
    expect(appCss).toMatch(/\.payment-head\s*{[^}]*flex-wrap:\s*wrap/s)
  })
})
