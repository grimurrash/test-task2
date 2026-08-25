import { useEffect, useRef, useState } from 'react'
import { createPayment, cancelPayment, listPayments } from './api/client'
import type { ApiErrorBody, HttpResult, Payment, PaymentListBody } from './api/client'
import type { JournalEntry, JournalItem, Semantic } from './types'
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

// Вид операции известен вызывающему — журнал не реконструирует его из строки
// пути: вердикт «новый/тот же платёж» и подсказки зависят от операции.
export type Op = 'create' | 'cancel'

const uid = () => crypto.randomUUID()

// Сумма уходит на сервер тем, чем её ввели: чистый десятичный литерал, который
// переживает round-trip через Number без искажений, — числом; всё остальное
// (нечисловое, hex, экспонента, потеря точности) — строкой, и сервер честно
// ответит 422. Клиент не валидирует форму: показать 422 — работа песочницы,
// а молча исказить ввод она не имеет права.
export function parseAmountInput(raw: string): number | string {
  const t = raw.trim()
  if (!/^-?\d+(\.\d+)?$/.test(t)) return raw
  const n = Number(t)
  return String(n) === t ? n : raw
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

// Единственное место, где описана форма конверта ошибки: тип — из
// сгенерированной схемы контракта, дальше все читают code/message/details
// отсюда.
export function errorOf(body: unknown): ApiErrorBody['error'] | undefined {
  if (body && typeof body === 'object' && 'error' in body) {
    const err = (body as Partial<ApiErrorBody>).error
    if (err && typeof err === 'object' && typeof err.code === 'string') {
      return err as ApiErrorBody['error']
    }
  }
  return undefined
}

export function validationErrors(body: unknown): Record<string, string> | undefined {
  const errors = (errorOf(body)?.details as { errors?: unknown } | undefined)?.errors
  if (!errors || typeof errors !== 'object') return undefined
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(errors as Record<string, unknown>)) {
    out[k] = typeof v === 'string' ? v : JSON.stringify(v)
  }
  return out
}

function paymentIdOf(body: unknown): string | undefined {
  if (body && typeof body === 'object' && 'id' in body) {
    const id = (body as { id?: unknown }).id
    if (typeof id === 'string') return id
  }
  return undefined
}

// Запись журнала из результата запроса. Текст для ошибок — message сервера
// плюс карта нарушений: журнал показывает то, что пришло, а не пересказ;
// текст недоверенный и рендерится только текстовым узлом.
export function entryFromResult(
  op: Op,
  path: string,
  result: HttpResult,
  key?: string,
): JournalEntry {
  if (result.kind === 'network') {
    const cause = `Ответ не получен (${result.message}). Сеть, CORS или сервер не запущен.`
    return {
      uid: uid(),
      time: nowTime(),
      method: 'POST',
      path,
      status: null,
      semantic: 'network',
      key,
      note:
        op === 'create'
          ? `${cause} Безопасно повторить с тем же ключом — если платёж успел создаться, придёт 200 и тот же id, второго списания не будет.`
          : cause,
    }
  }
  const { status, body } = result
  const semantic = semanticFor(status)
  const entry: JournalEntry = {
    uid: uid(),
    time: nowTime(),
    method: 'POST',
    path,
    status,
    semantic,
    verdict: op === 'create' ? verdictFor(status) : undefined,
    paymentId: paymentIdOf(body),
    key,
    errorCode: errorOf(body)?.code,
    body: body ?? undefined,
  }
  if (semantic === 'error' || semantic === 'conflict') {
    const err = errorOf(body)
    const details = validationErrors(body)
    const parts: string[] = []
    if (err?.message) parts.push(err.message)
    if (details)
      parts.push(
        Object.entries(details)
          .map(([field, text]) => `${field} — ${text}`)
          .join('; '),
      )
    entry.note = parts.join('. ') || undefined
  }
  if (entry.verdict === 'same') entry.note = 'Второй платёж не создан.'
  return entry
}

// Цвет точки группы выводится из фактических записей, а не из ожидания
// сценария: при недоступном сервере группа честно серая.
export function groupSemantic(entries: JournalEntry[]): Semantic {
  const present = entries.map((e) => e.semantic)
  for (const s of ['conflict', 'error', 'created', 'repeat'] as const) {
    if (present.includes(s)) return s
  }
  return 'network'
}

const demoOrder = () => `ORD-${String(Date.now()).slice(-6)}`

function demoBody(
  amount: number,
  currency: string,
  description?: string,
  order: string = demoOrder(),
): string {
  const body: Record<string, unknown> = {
    amount_minor: amount,
    currency,
    order_id: order,
  }
  if (description !== undefined) body.description = description
  return JSON.stringify(body)
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
  // Порядковый номер запроса списка: применяется только самый свежий ответ,
  // устаревший (например, за прежнего мерчанта) отбрасывается.
  const listSeq = useRef(0)

  const prepend = (item: JournalItem) => setItems((prev) => [item, ...prev])
  const addEntry = (entry: JournalEntry) => prepend({ kind: 'entry', entry })

  async function refreshPayments(m: Merchant) {
    const seq = ++listSeq.current
    const res = await listPayments(m)
    if (seq !== listSeq.current) return
    if (res.kind === 'http' && res.status === 200) {
      setPayments((res.body as PaymentListBody).payments ?? [])
      setListNote(null)
    } else {
      setPayments([]) // не показывать возможно чужой список под текущим заголовком
      setListNote(
        res.kind === 'http'
          ? `список недоступен: ответ ${res.status}`
          : 'список недоступен: нет ответа от API',
      )
    }
  }

  useEffect(() => {
    void refreshPayments(merchant)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [merchant])

  // Создание платежа: запись в журнал и ошибки полей (если запрос из формы).
  // Список обновляет вызывающий по завершении своей операции — один раз.
  async function doCreate(
    m: Merchant,
    rawBody: string,
    key: string,
    applyFieldErrors: boolean,
  ): Promise<HttpResult> {
    setLastRequest({ rawBody, key })
    const res = await createPayment(rawBody, key, m)
    addEntry(entryFromResult('create', '/v1/payments', res, key))
    if (applyFieldErrors && res.kind === 'http' && res.status === 422) {
      setFieldErrors((validationErrors(res.body) as FieldErrors) ?? {})
    }
    return res
  }

  async function run(fn: () => Promise<void>) {
    if (inFlight) return
    setInFlight(true)
    try {
      await fn()
    } finally {
      setInFlight(false)
    }
  }

  // Мерчант фиксируется на старте операции, как ключ и тело: переключение
  // по ходу многошагового сценария не должно раздать шаги разным мерчантам.
  const submit = () =>
    run(async () => {
      const m = merchant
      setFieldErrors({})
      await doCreate(m, buildBody(form), form.key, true)
      await refreshPayments(m)
    })

  const repeat = () =>
    run(async () => {
      if (!lastRequest) return
      const m = merchant
      await doCreate(m, lastRequest.rawBody, lastRequest.key, false)
      await refreshPayments(m)
    })

  const generateKey = () => setForm((f) => ({ ...f, key: uid() }))

  // --- Готовые сценарии (U4) — самодостаточные: свой ключ, своё тело --------

  const scenarioRepeat = () =>
    run(async () => {
      const m = merchant
      const key = uid()
      const raw = demoBody(125000, 'RUB', 'Сценарий «повтор с тем же телом»')
      await doCreate(m, raw, key, false)
      await doCreate(m, raw, key, false)
      await refreshPayments(m)
    })

  const scenarioReuse = () =>
    run(async () => {
      const m = merchant
      const key = uid()
      const order = demoOrder()
      await doCreate(m, demoBody(125000, 'RUB', undefined, order), key, false)
      await doCreate(m, demoBody(126000, 'RUB', undefined, order), key, false)
      await refreshPayments(m)
    })

  const scenarioRace = () =>
    run(async () => {
      const m = merchant
      const key = uid()
      const raw = demoBody(25000, 'USD', 'Сценарий «две одновременные отправки»')
      setLastRequest({ rawBody: raw, key })
      // Оба fetch стартуют до первого await — запросы действительно параллельны.
      const results = await Promise.all(
        [0, 1].map(() =>
          createPayment(raw, key, m).then((r) => ({ r, at: performance.now() })),
        ),
      )
      const entries = results
        .sort((a, b) => b.at - a.at) // поздний ответ — выше, как в журнале
        .map(({ r }) => entryFromResult('create', '/v1/payments', r, key))
      // Решение проджекта по U4: показываем инвариант «платёж один», а не
      // конкретный код — исход второго запроса разводит тайминг, обе ветки
      // контрактны. Пояснение печатается, только если ответы вообще пришли.
      prepend({
        kind: 'group',
        uid: uid(),
        label: 'Сценарий «две одновременные отправки» · один ключ',
        note: entries.some((e) => e.status !== null)
          ? 'Платёж в любом исходе один. Проигравший получает 409 request_in_progress, пока первый запрос в полёте, или 200 с тем же платежом, если первый уже завершился, — исход разводит тайминг.'
          : undefined,
        groupKey: key,
        semantic: groupSemantic(entries),
        entries,
      })
      await refreshPayments(m)
    })

  const scenarioDoubleCancel = () =>
    run(async () => {
      const m = merchant
      const created = await doCreate(
        m,
        demoBody(25000, 'USD', 'Сценарий «двойная отмена»'),
        uid(),
        false,
      )
      const id = created.kind === 'http' ? paymentIdOf(created.body) : undefined
      if (id) {
        const path = `/v1/payments/${id}/cancel`
        const first = entryFromResult('cancel', path, await cancelPayment(id, m))
        const second = entryFromResult('cancel', path, await cancelPayment(id, m))
        // F14: две записи различимы — первая отмена меняет состояние,
        // повтор возвращает тот же результат (тексты обещаны макетом)
        if (first.status === 200) first.note = 'Платёж отменён: pending → canceled.'
        if (second.status === 200)
          second.note = 'Повтор отмены — тот же результат: canceled. Отмена идемпотентна.'
        const entries = [second, first]
        prepend({
          kind: 'group',
          uid: uid(),
          label: `Сценарий «двойная отмена» · ${id}`,
          semantic: groupSemantic(entries),
          entries,
        })
      }
      await refreshPayments(m)
    })

  const scenarioCancelCompleted = () =>
    run(async () => {
      const m = merchant
      const created = await doCreate(
        m,
        demoBody(12002, 'RUB', 'Сценарий «отменить завершённый платёж»'),
        uid(),
        false,
      )
      const id = created.kind === 'http' ? paymentIdOf(created.body) : undefined
      if (id) {
        const path = `/v1/payments/${id}/cancel`
        addEntry(entryFromResult('cancel', path, await cancelPayment(id, m)))
      }
      await refreshPayments(m)
    })

  return (
    <div className="page">
      <Topbar merchant={merchant} onMerchant={setMerchant} inFlight={inFlight} />
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
          <Journal items={items} />
        </section>
        <aside className="card" aria-label="Платежи">
          <PaymentsList merchant={merchant} payments={payments} note={listNote} />
        </aside>
      </div>
    </div>
  )
}
