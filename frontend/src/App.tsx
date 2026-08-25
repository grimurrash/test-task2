import { useCallback, useEffect, useRef, useState } from 'react'
import { createPayment, cancelPayment, listPayments } from './api/client'
import type { HttpResult, Payment } from './api/client'
import type { JournalEntry, JournalItem } from './types'
import { nowTime, semanticFor, verdictFor } from './lib/semantics'
import { Topbar } from './components/Topbar'
import { RequestForm } from './components/RequestForm'
import type { FormState } from './components/RequestForm'
import { Scenarios } from './components/Scenarios'
import { Journal } from './components/Journal'
import { PaymentsList } from './components/PaymentsList'

export const MERCHANTS = ['demo-shop-a', 'demo-shop-b'] as const
export type Merchant = (typeof MERCHANTS)[number]

export type FieldErrors = Partial<
  Record<'amount_minor' | 'currency' | 'order_id' | 'description', string>
>

const uid = () => crypto.randomUUID()

// Сумма уходит на сервер тем, чем её ввели: целое — числом, дробное — числом,
// нечисловое — строкой. Клиент не валидирует форму: показать 422 сервера —
// работа песочницы, а не предотвратить его.
export function parseAmountInput(raw: string): number | string {
  const t = raw.trim()
  if (t === '') return raw
  const n = Number(t)
  return Number.isFinite(n) ? n : raw
}

// Тело строится строго из четырёх полей контракта (additionalProperties: false,
// решение #32); пустое описание не отправляется — это null на стороне сервера.
export function buildBody(form: {
  amount: string
  currency: string
  orderId: string
  description: string
}): string {
  const body: Record<string, unknown> = {
    amount_minor: parseAmountInput(form.amount),
    currency: form.currency,
    order_id: form.orderId,
  }
  if (form.description !== '') body.description = form.description
  return JSON.stringify(body)
}

function errorCodeOf(body: unknown): string | undefined {
  if (body && typeof body === 'object' && 'error' in body) {
    const err = (body as { error?: { code?: unknown } }).error
    if (err && typeof err.code === 'string') return err.code
  }
  return undefined
}

function errorMessageOf(body: unknown): string | undefined {
  if (body && typeof body === 'object' && 'error' in body) {
    const err = (body as { error?: { message?: unknown } }).error
    if (err && typeof err.message === 'string') return err.message
  }
  return undefined
}

function detailsErrorsOf(body: unknown): Record<string, string> | undefined {
  if (body && typeof body === 'object' && 'error' in body) {
    const err = (body as { error?: { details?: { errors?: unknown } } }).error
    const errors = err?.details?.errors
    if (errors && typeof errors === 'object') {
      const out: Record<string, string> = {}
      for (const [k, v] of Object.entries(errors as Record<string, unknown>)) {
        out[k] = typeof v === 'string' ? v : JSON.stringify(v)
      }
      return out
    }
  }
  return undefined
}

function paymentIdOf(body: unknown): string | undefined {
  if (body && typeof body === 'object' && 'id' in body) {
    const id = (body as { id?: unknown }).id
    if (typeof id === 'string') return id
  }
  return undefined
}

// Запись журнала из результата запроса. Текст записи для ошибок — message
// сервера плюс карта нарушений: журнал показывает то, что пришло, а не
// пересказ; текст недоверенный и рендерится только текстовым узлом.
export function entryFromResult(
  method: 'POST' | 'GET',
  path: string,
  result: HttpResult,
  key?: string,
): JournalEntry {
  if (result.kind === 'network') {
    return {
      uid: uid(),
      time: nowTime(),
      method,
      path,
      status: null,
      semantic: 'network',
      key,
      note:
        'Ответ не получен: сеть, CORS или сервер не запущен. Безопасно повторить ' +
        'с тем же ключом — если платёж успел создаться, придёт 200 и тот же id.',
    }
  }
  const { status, body } = result
  const semantic = semanticFor(status)
  const entry: JournalEntry = {
    uid: uid(),
    time: nowTime(),
    method,
    path,
    status,
    semantic,
    verdict: path === '/v1/payments' && method === 'POST' ? verdictFor(status) : undefined,
    paymentId: paymentIdOf(body),
    key,
    errorCode: errorCodeOf(body),
    body: body ?? undefined,
    bodyOpen: false,
  }
  if (semantic === 'error' || semantic === 'conflict') {
    const message = errorMessageOf(body)
    const details = detailsErrorsOf(body)
    const parts: string[] = []
    if (message) parts.push(message)
    if (details)
      parts.push(
        Object.entries(details)
          .map(([field, text]) => `${field} — ${text}`)
          .join('; '),
      )
    entry.note = parts.join('. ') || undefined
  }
  if (entry.verdict === 'same') {
    entry.bodyOpen = true // повтор виден как повтор: тот же id и created_at сразу на экране
    entry.note = 'Второй платёж не создан.'
  }
  return entry
}

export default function App() {
  const [merchant, setMerchant] = useState<Merchant>('demo-shop-a')
  const [form, setForm] = useState<FormState>({
    amount: '125000',
    currency: 'RUB',
    orderId: 'ORD-1001',
    description: '',
    key: uid(),
  })
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({})
  const [items, setItems] = useState<JournalItem[]>([])
  const [payments, setPayments] = useState<Payment[]>([])
  const [listNote, setListNote] = useState<string | null>(null)
  const [inFlight, setInFlight] = useState(false)
  const [lastRequest, setLastRequest] = useState<{ rawBody: string; key: string } | null>(null)
  const merchantRef = useRef<Merchant>(merchant)
  merchantRef.current = merchant

  const prepend = useCallback((item: JournalItem) => {
    setItems((prev) => [item, ...prev])
  }, [])

  const addEntry = useCallback(
    (entry: JournalEntry) => prepend({ kind: 'entry', entry }),
    [prepend],
  )

  const refreshPayments = useCallback(async (m: Merchant) => {
    const res = await listPayments(m)
    if (res.kind === 'http' && res.status === 200) {
      const body = res.body as { payments?: Payment[] }
      setPayments(Array.isArray(body?.payments) ? body.payments : [])
      setListNote(null)
    } else if (res.kind === 'http') {
      setListNote(`список недоступен: ответ ${res.status}`)
    } else {
      setListNote('список недоступен: нет ответа от API')
    }
  }, [])

  useEffect(() => {
    void refreshPayments(merchant)
  }, [merchant, refreshPayments])

  // Создание платежа: журнал, ошибки полей (если запрос из формы),
  // обновление списка — от повторов он не растёт, и это видно.
  const doCreate = useCallback(
    async (rawBody: string, key: string, applyFieldErrors: boolean): Promise<HttpResult> => {
      setLastRequest({ rawBody, key })
      const res = await createPayment(rawBody, key, merchantRef.current)
      addEntry(entryFromResult('POST', '/v1/payments', res, key))
      if (applyFieldErrors && res.kind === 'http' && res.status === 422) {
        setFieldErrors((detailsErrorsOf(res.body) as FieldErrors) ?? {})
      }
      void refreshPayments(merchantRef.current)
      return res
    },
    [addEntry, refreshPayments],
  )

  const run = useCallback(
    async (fn: () => Promise<void>) => {
      if (inFlight) return
      setInFlight(true)
      try {
        await fn()
      } finally {
        setInFlight(false)
      }
    },
    [inFlight],
  )

  const submit = useCallback(
    () =>
      run(async () => {
        setFieldErrors({})
        await doCreate(buildBody(form), form.key, true)
      }),
    [run, doCreate, form],
  )

  const repeat = useCallback(
    () =>
      run(async () => {
        if (!lastRequest) return
        await doCreate(lastRequest.rawBody, lastRequest.key, false)
      }),
    [run, doCreate, lastRequest],
  )

  const generateKey = useCallback(() => {
    setForm((f) => ({ ...f, key: uid() }))
  }, [])

  const toggleBody = useCallback((entryUid: string) => {
    setItems((prev) =>
      prev.map((item) => {
        if (item.kind === 'entry' && item.entry.uid === entryUid) {
          return { kind: 'entry', entry: { ...item.entry, bodyOpen: !item.entry.bodyOpen } }
        }
        if (item.kind === 'group') {
          return {
            ...item,
            entries: item.entries.map((e) =>
              e.uid === entryUid ? { ...e, bodyOpen: !e.bodyOpen } : e,
            ),
          }
        }
        return item
      }),
    )
  }, [])

  // --- Готовые сценарии (U4) — самодостаточные: свой ключ, своё тело ---------

  const demoOrder = () => `ORD-${String(Date.now()).slice(-6)}`

  const scenarioRepeat = () =>
    run(async () => {
      const key = uid()
      const raw = JSON.stringify({
        amount_minor: 125000,
        currency: 'RUB',
        order_id: demoOrder(),
        description: 'Сценарий «повтор с тем же телом»',
      })
      await doCreate(raw, key, false)
      await doCreate(raw, key, false)
    })

  const scenarioReuse = () =>
    run(async () => {
      const key = uid()
      const order = demoOrder()
      await doCreate(
        JSON.stringify({ amount_minor: 125000, currency: 'RUB', order_id: order }),
        key,
        false,
      )
      await doCreate(
        JSON.stringify({ amount_minor: 126000, currency: 'RUB', order_id: order }),
        key,
        false,
      )
    })

  const scenarioRace = () =>
    run(async () => {
      const key = uid()
      const raw = JSON.stringify({
        amount_minor: 25000,
        currency: 'USD',
        order_id: demoOrder(),
        description: 'Сценарий «две одновременные отправки»',
      })
      setLastRequest({ rawBody: raw, key })
      const results = await Promise.all(
        [0, 1].map(() =>
          createPayment(raw, key, merchantRef.current).then((r) => ({
            r,
            at: performance.now(),
          })),
        ),
      )
      const entries = results
        .sort((a, b) => b.at - a.at) // поздний ответ — выше, как в журнале
        .map(({ r }) => entryFromResult('POST', '/v1/payments', r, key))
      prepend({
        kind: 'group',
        uid: uid(),
        label: 'Сценарий «две одновременные отправки» · один ключ → ровно один платёж',
        groupKey: key,
        semantic: 'conflict',
        entries,
      })
      void refreshPayments(merchantRef.current)
    })

  const scenarioDoubleCancel = () =>
    run(async () => {
      const key = uid()
      const created = await doCreate(
        JSON.stringify({
          amount_minor: 25000,
          currency: 'USD',
          order_id: demoOrder(),
          description: 'Сценарий «двойная отмена»',
        }),
        key,
        false,
      )
      const id = created.kind === 'http' ? paymentIdOf(created.body) : undefined
      if (!id) return
      const path = `/v1/payments/${id}/cancel`
      const first = entryFromResult('POST', path, await cancelPayment(id, merchantRef.current))
      const second = entryFromResult('POST', path, await cancelPayment(id, merchantRef.current))
      prepend({
        kind: 'group',
        uid: uid(),
        label: `Сценарий «двойная отмена» · ${id}`,
        semantic: 'repeat',
        entries: [second, first],
      })
      void refreshPayments(merchantRef.current)
    })

  const scenarioCancelCompleted = () =>
    run(async () => {
      const key = uid()
      const created = await doCreate(
        JSON.stringify({
          amount_minor: 12002,
          currency: 'RUB',
          order_id: demoOrder(),
          description: 'Сценарий «отменить завершённый платёж»',
        }),
        key,
        false,
      )
      const id = created.kind === 'http' ? paymentIdOf(created.body) : undefined
      if (!id) return
      const path = `/v1/payments/${id}/cancel`
      addEntry(entryFromResult('POST', path, await cancelPayment(id, merchantRef.current)))
      void refreshPayments(merchantRef.current)
    })

  return (
    <div className="page">
      <Topbar merchant={merchant} onMerchant={setMerchant} />
      <div className="layout">
        <section className="card" aria-label="Форма запроса">
          <RequestForm
            form={form}
            onChange={(next) => {
              setForm(next)
              setFieldErrors({})
            }}
            fieldErrors={fieldErrors}
            inFlight={inFlight}
            canRepeat={lastRequest !== null}
            onSubmit={submit}
            onRepeat={repeat}
            onGenerateKey={generateKey}
          />
          <Scenarios
            inFlight={inFlight}
            onRepeat={scenarioRepeat}
            onReuse={scenarioReuse}
            onRace={scenarioRace}
            onDoubleCancel={scenarioDoubleCancel}
            onCancelCompleted={scenarioCancelCompleted}
          />
        </section>
        <section className="card" aria-label="Журнал обмена">
          <div className="card-title">Журнал обмена</div>
          <Journal items={items} onToggleBody={toggleBody} />
        </section>
        <aside className="card" aria-label="Платежи">
          <PaymentsList merchant={merchant} payments={payments} note={listNote} />
        </aside>
      </div>
    </div>
  )
}
