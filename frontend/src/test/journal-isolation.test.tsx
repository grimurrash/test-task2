// Решение проджекта, закреплённое тестом (#104): рендер-ошибки НЕ пишутся
// в журнал обмена. Журнал — доказательная лента сетевых обменов, единственное,
// чем песочница доказывает, что не врёт про сеть; внутренние отказы интерфейса
// живут в заглушке блока и консоли, но не в нём. Если завтра кто-то
// добросовестно «улучшит» журнал, дописав туда рендер-отказы, — узнает от
// этого теста, а не от пользователя.
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import App from '../App'

// Управляемая бомба в рендере карточки: formatAmount бросает на сумме-маркере.
vi.mock('../lib/money', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../lib/money')>()
  return {
    ...orig,
    formatAmount: (minor: number, currency: string) => {
      if (minor === 666) throw new Error('render-bomb')
      return orig.formatAmount(minor, currency)
    },
  }
})

const payment = (id: string, amount: number) => ({
  id,
  status: 'pending',
  status_reason: null,
  amount_minor: amount,
  currency: 'RUB',
  order_id: `ORD-${id}`,
  description: null,
  created_at: '2026-08-25T12:00:00.000Z',
})

describe('изоляция журнала обмена от рендер-ошибок', () => {
  it('бросок в карточке даёт заглушку, но не запись в журнале', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => {
      if (init?.method === 'POST') throw new Error('в этом тесте POST не ожидается')
      return Promise.resolve(
        new Response(
          JSON.stringify({ payments: [payment('pay_ok', 12002), payment('pay_bomb', 666)] }),
          { status: 200 },
        ),
      )
    })
    const { container } = render(<App />)

    // карточка-бомба заменена заглушкой, соседняя карточка жива
    expect(
      await screen.findByText(/Платёж pay_bomb не отобразился: render-bomb/),
    ).toBeInTheDocument()
    expect(screen.getByText('120,02 RUB')).toBeInTheDocument()

    // журнал обмена остался пустым: сетевых обменов не было, рендер-отказ — не обмен
    expect(screen.getByText('Журнал пуст — отправьте первый запрос.')).toBeInTheDocument()
    expect(container.querySelectorAll('.entry')).toHaveLength(0)
  })
})
