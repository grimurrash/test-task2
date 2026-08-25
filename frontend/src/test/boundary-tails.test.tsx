// #120: хвосты по границам рендера.
// П. 1 — шапка группы журнала рисуется под границей: плохие данные группы
// дают заглушку группы, а не заменяют весь журнал (третье повторение формы
// «родитель вычисляет для потомка» — узел проверяется бомбой, не глазами).
// П. 2 — заглушка сбрасывается, когда данные пришли в порядке (resetKey).
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Journal } from '../components/Journal'
import { CardBoundary } from '../components/CardBoundary'
import type { JournalEntry, JournalItem } from '../types'

const entry = (uid: string): JournalEntry => ({
  uid,
  time: '12:00:00',
  method: 'POST',
  path: '/v1/payments',
  status: 201,
  semantic: 'created',
  verdict: 'new',
  paymentId: 'pay_ok',
})

describe('#120 п.1: плохие данные группы не сносят журнал', () => {
  it('группа с label-объектом — заглушка группы, соседняя запись жива', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const items: JournalItem[] = [
      {
        kind: 'group',
        uid: 'g1',
        label: { hostile: true } as unknown as string, // объект вместо строки — React бросает
        semantic: 'conflict',
        entries: [entry('e1')],
      },
      { kind: 'entry', entry: entry('e2') },
    ]
    const { container } = render(<Journal items={items} />)
    expect(screen.getByText(/Группа журнала не отобразился/)).toBeInTheDocument()
    // сосед уцелел, журнал жив
    expect(container.querySelectorAll('.entry')).toHaveLength(1)
    expect(screen.getByText('новый платёж')).toBeInTheDocument()
  })
})

describe('#120 п.2: заглушка сбрасывается при смене данных', () => {
  it('после исправления данных карточка рендерится заново', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const Maybe = ({ broken }: { broken: boolean }) => {
      if (broken) throw new Error('bad data')
      return <p>данные в порядке</p>
    }
    const { rerender } = render(
      <CardBoundary label="Блок" resetKey="v1">
        <Maybe broken={true} />
      </CardBoundary>,
    )
    expect(screen.getByText(/Блок не отобразился: bad data/)).toBeInTheDocument()

    rerender(
      <CardBoundary label="Блок" resetKey="v2">
        <Maybe broken={false} />
      </CardBoundary>,
    )
    expect(screen.getByText('данные в порядке')).toBeInTheDocument()

    // без смены ключа заглушка не сбрасывается — залипание осознанное
    rerender(
      <CardBoundary label="Блок" resetKey="v2">
        <Maybe broken={true} />
      </CardBoundary>,
    )
    expect(screen.getByText(/Блок не отобразился/)).toBeInTheDocument()
    rerender(
      <CardBoundary label="Блок" resetKey="v2">
        <Maybe broken={false} />
      </CardBoundary>,
    )
    expect(screen.getByText(/Блок не отобразился/)).toBeInTheDocument()
  })
})
