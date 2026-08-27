// A10/U6: description — недоверенный текст. Разметка и скрипты из него
// выводятся буквально и не попадают в DOM исполняемыми узлами.
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { PaymentsList } from '../components/PaymentsList'
import type { Payment } from '../api/client'

const hostile: Payment = {
  id: 'pay_c5b0d8',
  status: 'failed',
  status_reason: 'test_amount_rule',
  amount_minor: 9901,
  currency: 'EUR',
  order_id: 'ORD-1041',
  description: 'Срочно! <b>ускорить</b><script>alert("xss")</script>',
  created_at: '2026-08-25T12:00:00.000Z',
}

describe('A10: description выводится как текст', () => {
  it('разметка видна буквально, узлы script/b в DOM не создаются', () => {
    const { container } = render(
      <PaymentsList merchant="demo-shop-a" payments={[hostile]} note={null} />,
    )
    expect(
      screen.getByText((t) => t.includes('<script>alert("xss")</script>')),
    ).toBeInTheDocument()
    expect(container.querySelector('script')).toBeNull()
    expect(container.querySelector('b')).toBeNull()
  })

  // Запрос по точному тексту здесь больше не работает — и не должен: значение
  // уехало в <bdi> (U7, #180), а `getNodeText` в testing-library склеивает
  // только ПРЯМЫЕ текстовые узлы элемента. Метка и значение проверяются
  // раздельно, потому что раздельны и в разметке: изолируется значение,
  // а не подпись к нему.
  it('status_reason показан, когда не null', () => {
    const { container } = render(
      <PaymentsList merchant="demo-shop-a" payments={[hostile]} note={null} />,
    )
    const chip = Array.from(container.querySelectorAll('.chip')).find((c) =>
      c.textContent?.startsWith('status_reason:'),
    )
    expect(chip?.textContent).toBe('status_reason: test_amount_rule')
    expect(screen.getByText('test_amount_rule').tagName).toBe('BDI')
  })
})
