// #76: U+202E в description не должен утаскивать кавычки и запятые JSON
// в журнале. Значение изолировано (<bdi>), но не изменено — показ «как есть»
// (U6/F11) сохраняется, ломаться перестаёт только окружение.
import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { Journal } from '../components/Journal'
import type { JournalItem } from '../types'

const RLO = '‮'
const hostile = `Возврат ${RLO} 001 BUR`

const item: JournalItem = {
  kind: 'entry',
  entry: {
    uid: 'e1',
    time: '12:00:00',
    method: 'POST',
    path: '/v1/payments',
    status: 200,
    semantic: 'repeat',
    verdict: 'same', // тело раскрыто сразу
    key: 'k-1',
    body: {
      id: 'pay_1',
      description: hostile,
      created_at: '2026-08-25T12:00:00.000Z',
    },
  },
}

describe('#76: bidi-изоляция значений в теле ответа', () => {
  it('значение description лежит в <bdi> нетронутым, кавычка и запятая — снаружи', () => {
    const { container } = render(<Journal items={[item]} />)
    const bdis = Array.from(container.querySelectorAll('.payload bdi'))
    const target = bdis.find((b) => b.textContent === hostile)
    expect(target).toBeDefined()
    // U+202E внутри значения сохранён байт-в-байт — фильтрации нет
    expect(target!.textContent).toContain(RLO)
    // закрывающая кавычка и запятая — вне изолята, в соседнем текстовом узле
    const after = target!.nextSibling
    expect(after?.textContent?.startsWith('",')).toBe(true)
    // структура JSON в тексте панели цела: строка created_at начинается с кавычки
    const payloadText = container.querySelector('.payload')!.textContent!
    expect(payloadText).toContain('"created_at"')
  })
})
