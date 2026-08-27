// U7 в списке платежей (#180). Изоляция направления письма стояла только
// в журнале обмена (#76, bidi.test.tsx) — а требование говорит «значения,
// пришедшие от сервера», без оговорки про журнал. Список — такое же
// свидетельство: по нему проверяющий видит, что от повторов он не растёт.
// Значение с U+202E, не изолированное, переворачивает соседний текст, и
// показанное расходится с хранимым.
//
// Проверяется структура, а не картинка: jsdom порядок символов не считает,
// поэтому тест утверждает то, что доступно честно, — каждое значение сервера
// лежит в собственном <bdi> и ничего чужого в этот изолят не попадает.
// Соседи в него не входят, а значит, перевернуть их нечем.
import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { PaymentsList } from '../components/PaymentsList'
import type { Payment } from '../api/client'

const RLO = '‮'
const hostileDescription = `Возврат ${RLO} 001 BUR`

const payment: Payment = {
  id: 'pay_c5b0d8',
  status: 'failed',
  status_reason: 'test_amount_rule',
  amount_minor: 9901,
  currency: 'EUR',
  order_id: 'ORD-1041',
  description: hostileDescription,
  created_at: '2026-08-25T12:00:00.000Z',
}

/**
 * Элемент, для которого этот текст — его СОБСТВЕННЫЙ, а не текст потомков.
 * Именно так решает `getNodeText` в testing-library, и именно это отличает
 * «значение в изоляте» от «значение где-то внутри поддерева».
 */
function ownerOf(container: HTMLElement, text: string): Element | undefined {
  return Array.from(container.querySelectorAll('*')).find((el) =>
    Array.from(el.childNodes)
      .filter((n) => n.nodeType === Node.TEXT_NODE)
      .map((n) => n.textContent ?? '')
      .join('') === text,
  )
}

describe('@req U7 список платежей: значения сервера изолированы от bidi-символов', () => {
  it('@req U7 description с U+202E лежит в <bdi> нетронутым', () => {
    const { container } = render(
      <PaymentsList merchant="demo-shop-a" payments={[payment]} note={null} />,
    )
    const owner = ownerOf(container, hostileDescription)

    expect(owner?.tagName).toBe('BDI')
    // Значение сохранено байт-в-байт: фильтрации нет, показ «как есть» (F11/U6).
    expect(owner?.textContent).toContain(RLO)
  })

  it('@req U7 соседние значения карточки в этот изолят не входят', () => {
    const { container } = render(
      <PaymentsList merchant="demo-shop-a" payments={[payment]} note={null} />,
    )
    const owner = ownerOf(container, hostileDescription)

    // Ни сумма, ни order_id, ни id внутрь изолята описания не попадают —
    // перевернуть их символу из description нечем.
    expect(owner?.tagName).toBe('BDI')
    expect(owner?.textContent).toBe(hostileDescription)
    expect(container.querySelector('.meta')?.contains(owner ?? null)).toBe(false)
    expect(container.querySelector('.payment-head')?.contains(owner ?? null)).toBe(false)
  })

  it.each([
    ['id платежа', 'pay_c5b0d8'],
    ['order_id', 'ORD-1041'],
    ['status_reason', 'test_amount_rule'],
  ])('@req U7 %s тоже изолирован, а не только description', (_name, value) => {
    const { container } = render(
      <PaymentsList merchant="demo-shop-a" payments={[payment]} note={null} />,
    )

    expect(ownerOf(container, value)?.tagName).toBe('BDI')
  })

  it('@req U7 метка status_reason остаётся снаружи изолята', () => {
    const { container } = render(
      <PaymentsList merchant="demo-shop-a" payments={[payment]} note={null} />,
    )
    const chip = Array.from(container.querySelectorAll('.chip')).find((c) =>
      c.textContent?.startsWith('status_reason:'),
    )

    // Изолируется значение, а не подпись к нему: подпись — наш текст,
    // и заворачивать её внутрь значило бы прятать в изолят лишнее.
    expect(chip?.textContent).toBe('status_reason: test_amount_rule')
    expect(ownerOf(container, 'test_amount_rule')?.parentElement).toBe(chip)
  })
})
