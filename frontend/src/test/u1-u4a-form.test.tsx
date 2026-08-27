// U1 и U4a (#180): два требования песочницы, которые до сверки покрытия
// не охранял ни один тест. Оба про то, чем проверяющий пользуется руками:
// состав формы и переключатель мерчанта. Без второго требование F6 нечем
// показать глазами — так и записано в PRD.
import { describe, expect, it, vi, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import App from '../App'
import { MERCHANTS } from '../App'

afterEach(() => vi.restoreAllMocks())

function mockApi(): RequestInit[] {
  const posts: RequestInit[] = []
  vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => {
    if (init?.method === 'POST') {
      posts.push(init)
      return Promise.resolve(
        new Response(
          JSON.stringify({
            id: 'pay_form',
            status: 'pending',
            status_reason: null,
            amount_minor: 125000,
            currency: 'RUB',
            order_id: 'ORD-1001',
            description: null,
            created_at: '2026-08-25T12:00:00.000Z',
          }),
          { status: 201 },
        ),
      )
    }
    return Promise.resolve(new Response(JSON.stringify({ payments: [] }), { status: 200 }))
  })
  return posts
}

describe('@req U1 форма запроса: пять полей и кнопка генерации ключа', () => {
  it.each([
    ['сумма', /amount_minor/],
    ['валюта', /^Валюта$/],
    ['order_id', /order_id/],
    ['описание', /description/],
    ['ключ идемпотентности', /Idempotency-Key/],
  ])('поле «%s» есть на экране', (_name, label) => {
    mockApi()
    render(<App />)

    expect(screen.getByLabelText(label)).toBeInTheDocument()
  })

  it('@req U1 кнопка генерации подставляет новый ключ, а не оставляет поле пустым', async () => {
    mockApi()
    const user = userEvent.setup()
    render(<App />)

    const key = screen.getByLabelText(/Idempotency-Key/) as HTMLInputElement
    const before = key.value
    await user.click(screen.getByRole('button', { name: 'Сгенерировать' }))

    expect(key.value).not.toBe('')
    expect(key.value).not.toBe(before)
  })
})

describe('@req U4a переключатель мерчанта: два демо-значения X-Merchant-Id', () => {
  it('@req U4a оба значения показаны кнопками, выбранное отмечено', () => {
    mockApi()
    render(<App />)
    const group = screen.getByRole('group', { name: 'X-Merchant-Id' })

    for (const merchant of MERCHANTS) {
      expect(screen.getByRole('button', { name: merchant })).toBeInTheDocument()
    }
    expect(group.querySelectorAll('button[aria-pressed="true"]')).toHaveLength(1)
  })

  it('@req U4a переключение меняет заголовок следующего запроса', async () => {
    const posts = mockApi()
    const user = userEvent.setup()
    render(<App />)

    await user.click(screen.getByRole('button', { name: MERCHANTS[1] }))
    await user.click(screen.getByRole('button', { name: 'Отправить' }))
    await waitFor(() => expect(posts).toHaveLength(1))

    // Проверяется отправленный заголовок, а не подсветка кнопки: подсветка —
    // это про экран, а требование — про то, что уходит в API.
    const headers = posts[0].headers as Record<string, string>
    expect(headers['X-Merchant-Id']).toBe(MERCHANTS[1])
  })
})
