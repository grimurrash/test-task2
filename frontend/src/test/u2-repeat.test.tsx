// U2: гарантия живёт в repeat() — тест ломается, если сломать именно его,
// а не только транспорт (находка ревью #49: прежний тест охранял createPayment).
import { describe, expect, it, vi, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import App from '../App'

afterEach(() => vi.restoreAllMocks())

const payment = {
  id: 'pay_test',
  status: 'pending',
  status_reason: null,
  amount_minor: 125000,
  currency: 'RUB',
  order_id: 'ORD-1001',
  description: null,
  created_at: '2026-08-25T12:00:00.000Z',
}

describe('U2: «Отправить ещё раз тот же запрос» повторяет предыдущий запрос дословно', () => {
  it('второй POST уходит с тем же телом и ключом байт-в-байт, журнал показывает «тот же платёж»', async () => {
    const posts: RequestInit[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => {
      if (init?.method === 'POST') {
        posts.push(init)
        return Promise.resolve(
          new Response(JSON.stringify(payment), { status: posts.length > 1 ? 200 : 201 }),
        )
      }
      return Promise.resolve(new Response(JSON.stringify({ payments: [] }), { status: 200 }))
    })
    const user = userEvent.setup()
    render(<App />)

    const repeatBtn = screen.getByRole('button', { name: 'Отправить ещё раз тот же запрос' })
    expect(repeatBtn).toBeDisabled() // до первого запроса повторять нечего

    await user.click(screen.getByRole('button', { name: 'Отправить' }))
    await waitFor(() => expect(repeatBtn).toBeEnabled())
    await user.click(repeatBtn)
    await waitFor(() => expect(posts).toHaveLength(2))

    expect(posts[1].body).toBe(posts[0].body)
    const key = (i: number) => (posts[i].headers as Record<string, string>)['Idempotency-Key']
    expect(key(1)).toBe(key(0))

    expect(await screen.findByText('тот же платёж')).toBeInTheDocument()
    expect(screen.getByText('новый платёж')).toBeInTheDocument()
  })

  it('#81: после сценария кнопка шлёт тело сценария, и строка под кнопкой это показывает', async () => {
    const posts: RequestInit[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => {
      if (init?.method === 'POST') {
        posts.push(init)
        return Promise.resolve(new Response(JSON.stringify(payment), { status: 201 }))
      }
      return Promise.resolve(new Response(JSON.stringify({ payments: [] }), { status: 200 }))
    })
    const user = userEvent.setup()
    render(<App />)

    // сценарий «две одновременные отправки» — 25000 USD, два POST
    await user.click(screen.getByRole('button', { name: /Две одновременные отправки/ }))
    await waitFor(() => expect(posts).toHaveLength(2))
    const scenarioBody = posts[0].body
    expect(posts[1].body).toBe(scenarioBody)

    // строка честности: показывает тело сценария (USD), а не форму (125000 RUB)
    const summary = await screen.findByText(/Сейчас это:/)
    expect(summary.textContent).toContain('USD')
    expect(summary.textContent).not.toContain('125 000')

    // повтор шлёт именно его
    await user.click(screen.getByRole('button', { name: 'Отправить ещё раз тот же запрос' }))
    await waitFor(() => expect(posts).toHaveLength(3))
    expect(posts[2].body).toBe(scenarioBody)
    const key = (i: number) => (posts[i].headers as Record<string, string>)['Idempotency-Key']
    expect(key(2)).toBe(key(0))
  })
})

describe('#79: сценарии с отменой оставляют след при обрыве на создании', () => {
  it.each([
    ['Двойная отмена', 'двойная отмена'],
    ['Отменить завершённый платёж', 'отменить завершённый платёж'],
  ])('«%s»: группа с подписью и пояснением появляется без id', async (button, label) => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => {
      if (init?.method === 'POST') return Promise.reject(new TypeError('Failed to fetch'))
      return Promise.resolve(new Response(JSON.stringify({ payments: [] }), { status: 200 }))
    })
    const user = userEvent.setup()
    const { container } = render(<App />)
    await user.click(screen.getByRole('button', { name: new RegExp(button) }))
    await waitFor(() => expect(container.querySelector('.group')).not.toBeNull())
    const group = container.querySelector('.group')!
    expect(group.querySelector('.group-label')?.textContent).toContain(label)
    expect(group.textContent).toContain('шаги отмены не выполнялись')
    expect(group.querySelector('.entry--network')).not.toBeNull()
  })
})
