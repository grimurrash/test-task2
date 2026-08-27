// U4, сценарий «две одновременные отправки» (#180).
//
// У сценария два законных исхода: 201/200 и 201/409 `request_in_progress`.
// Какой выпадет — разводит тайминг, и продуктовое решение (REPORT 4.7) прямо
// говорит: искусственную задержку не добавлять, показывать инвариант, а не код
// ответа. До этого файла инвариант не был закреплён поимённо, и набор не
// различал «выпал другой законный исход» и «появился второй платёж» — ровно ту
// разницу, ради которой сценарий существует.
//
// Поэтому здесь не мок ответов, а поддельный бэкенд: маленькое идемпотентное
// хранилище «ключ → платёж». Мок, отдающий заранее написанные `id`, закреплял
// бы собственную выдумку; инвариант «платёж один» проверяется на том, что
// УМЕЕТ создать второй, — иначе тест не может покраснеть.
import { describe, expect, it, vi, afterEach } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import App from '../App'

afterEach(() => vi.restoreAllMocks())

/** Исход второго запроса: оба законны по F4 и U4. */
type Outcome = '200' | '409'

interface FakeBackend {
  /** Сколько платежей создано на самом деле. Инвариант живёт здесь. */
  created: number
  /** Сколько раз повтор по известному ключу вернул существующий платёж. */
  replayed: number
}

/**
 * Поддельный бэкенд. Идемпотентен по построению: ключ, уже занятый платежом,
 * второго не создаёт. `idempotent: false` — управляемая поломка для обратной
 * проверки: тогда он ведёт себя как сервис, потерявший гарантию.
 */
function installBackend(outcome: Outcome, options: { idempotent?: boolean } = {}): FakeBackend {
  const idempotent = options.idempotent !== false
  const byKey = new Map<string, Record<string, unknown>>()
  const list: Record<string, unknown>[] = []
  const state: FakeBackend = { created: 0, replayed: 0 }

  const json = (body: unknown, status: number) =>
    Promise.resolve(new Response(JSON.stringify(body), { status }))

  vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => {
    const method = init?.method ?? 'GET'
    if (method !== 'POST') return json({ payments: list }, 200)

    const headers = (init?.headers ?? {}) as Record<string, string>
    const key = headers['Idempotency-Key'] ?? ''
    const sent = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>

    const known = byKey.get(key)
    if (known !== undefined && idempotent) {
      state.replayed += 1
      // Оба исхода законны: 200 — первый запрос уже зафиксирован,
      // 409 — он ещё в полёте. Инвариант от этого не зависит.
      return outcome === '200'
        ? json(known, 200)
        : json(
            {
              error: {
                code: 'request_in_progress',
                message: 'Запрос с этим ключом ещё выполняется',
              },
            },
            409,
          )
    }

    state.created += 1
    const payment = {
      id: `pay_${String(state.created).padStart(4, '0')}`,
      status: 'pending',
      status_reason: null,
      amount_minor: sent['amount_minor'],
      currency: sent['currency'],
      order_id: sent['order_id'],
      description: sent['description'] ?? null,
      created_at: '2026-08-25T12:00:00.000Z',
    }
    byKey.set(key, payment)
    list.push(payment)
    return json(payment, 201)
  })

  return state
}

/**
 * Все идентификаторы платежей, которые песочница показала на экране.
 *
 * Ищем по СОБСТВЕННОМУ тексту каждого элемента, а не по `textContent` всего
 * дерева: тот склеивает соседние узлы без разделителя, и `pay_0001` рядом
 * с `ORD-1041` читается как несуществующий `pay_0001ORD`. Первая версия этой
 * функции ровно так и соврала — показала два id там, где он один.
 */
function shownIds(container: HTMLElement): Set<string> {
  const ids = new Set<string>()
  for (const el of Array.from(container.querySelectorAll('*'))) {
    const own = Array.from(el.childNodes)
      .filter((n) => n.nodeType === Node.TEXT_NODE)
      .map((n) => n.textContent ?? '')
      .join('')
    for (const found of own.match(/pay_[A-Za-z0-9]+/g) ?? []) ids.add(found)
  }
  return ids
}

async function runRaceScenario(): Promise<HTMLElement> {
  const user = userEvent.setup()
  const { container } = render(<App />)
  await user.click(screen.getByRole('button', { name: /Две одновременные отправки/ }))
  // Сценарий заканчивается обновлением списка; ждём именно карточку платежа,
  // а не число вызовов fetch: инвариант утверждается о показанном.
  await waitFor(() => expect(container.querySelector('.payment')).not.toBeNull())
  return container
}

describe.each<Outcome>(['200', '409'])(
  '@req U4 @req U5 две одновременные отправки, исход второго запроса — %s',
  (outcome) => {
    it('платёж один, id один, список не вырос', async () => {
      const backend = installBackend(outcome)
      const container = await runRaceScenario()

      // 1. Платёж один — по данным того, кто их создаёт.
      expect(backend.created).toBe(1)
      expect(backend.replayed).toBe(1)

      // 2. Id один — по данным того, кто их показывает.
      expect(shownIds(container)).toEqual(new Set(['pay_0001']))

      // 3. Список не вырос: одна карточка и счётчик в заголовке.
      expect(container.querySelectorAll('.payment')).toHaveLength(1)
      // Именно счётчик списка платежей, а не первый попавшийся заголовок:
      // такой же `.card-title` есть у журнала обмена.
      expect(
        container.querySelector('[aria-label="Платежи"] .card-title strong')?.textContent,
      ).toContain('· 1')
    })

    it('оба запроса ушли одним ключом — иначе гонки не было', async () => {
      const keys: string[] = []
      installBackend(outcome)
      const spy = vi.spyOn(globalThis, 'fetch')
      const original = spy.getMockImplementation()!
      spy.mockImplementation((url, init) => {
        if ((init?.method ?? 'GET') === 'POST') {
          keys.push((init?.headers as Record<string, string>)['Idempotency-Key'] ?? '')
        }
        return original(url, init)
      })

      await runRaceScenario()

      expect(keys).toHaveLength(2)
      expect(new Set(keys).size).toBe(1)
    })
  },
)

/**
 * Разница, ради которой сценарий существует: смена законного исхода —
 * не событие, а второй платёж — событие. Тест обязан молчать на первом
 * и кричать на втором, иначе он закрепляет код ответа вместо инварианта.
 */
describe('@req U4 исход и инвариант — разные вещи', () => {
  it('оба законных исхода дают один и тот же показанный id', async () => {
    installBackend('200')
    const first = shownIds(await runRaceScenario())
    // Второй прогон — в чистом документе: иначе на экране два приложения сразу,
    // и запрос по роли находит две кнопки вместо одной.
    cleanup()
    vi.restoreAllMocks()

    installBackend('409')
    const second = shownIds(await runRaceScenario())

    expect(first).toEqual(second)
    expect(first.size).toBe(1)
  })
})
