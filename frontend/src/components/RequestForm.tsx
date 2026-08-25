import type { FieldErrors } from '../App'

export interface FormState {
  amount: string
  currency: 'RUB' | 'USD' | 'EUR'
  orderId: string
  description: string
  key: string
}

const DESCRIPTION_LIMIT = 512

export function RequestForm(props: {
  form: FormState
  onChange: (next: FormState) => void
  fieldErrors: FieldErrors
  inFlight: boolean
  canRepeat: boolean
  lastSummary: string | null
  onSubmit: () => void
  onRepeat: () => void
  onGenerateKey: () => void
}) {
  const { form, onChange, fieldErrors, inFlight } = props
  const set = (patch: Partial<FormState>) => onChange({ ...form, ...patch })

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        props.onSubmit()
      }}
    >
      <div className="card-title">
        Запрос<strong className="mono">POST /v1/payments</strong>
      </div>

      <div className="field">
        <label htmlFor="amount">Сумма, минорные единицы (amount_minor)</label>
        <input
          id="amount"
          className={`control mono${fieldErrors.amount_minor ? ' control--error' : ''}`}
          value={form.amount}
          onChange={(e) => set({ amount: e.target.value })}
          aria-invalid={Boolean(fieldErrors.amount_minor)}
        />
        {fieldErrors.amount_minor && <p className="error-text">{fieldErrors.amount_minor}</p>}
        <p className="sub">
          Тестовые суммы: копейки <span className="mono">01</span> → failed,{' '}
          <span className="mono">02</span> → succeeded, прочее → pending.
        </p>
      </div>

      <div className="field">
        <label htmlFor="currency">Валюта</label>
        <select
          id="currency"
          className={`control${fieldErrors.currency ? ' control--error' : ''}`}
          value={form.currency}
          onChange={(e) => set({ currency: e.target.value as FormState['currency'] })}
        >
          <option>RUB</option>
          <option>USD</option>
          <option>EUR</option>
        </select>
        {fieldErrors.currency && <p className="error-text">{fieldErrors.currency}</p>}
      </div>

      <div className="field">
        <label htmlFor="order">order_id</label>
        <input
          id="order"
          className={`control mono${fieldErrors.order_id ? ' control--error' : ''}`}
          value={form.orderId}
          maxLength={64}
          onChange={(e) => set({ orderId: e.target.value })}
          aria-invalid={Boolean(fieldErrors.order_id)}
        />
        {fieldErrors.order_id && <p className="error-text">{fieldErrors.order_id}</p>}
      </div>

      <div className="field">
        <label htmlFor="desc">Описание (description)</label>
        <textarea
          id="desc"
          className={`control${fieldErrors.description ? ' control--error' : ''}`}
          rows={2}
          value={form.description}
          onChange={(e) => set({ description: e.target.value })}
          aria-invalid={Boolean(fieldErrors.description)}
        />
        {fieldErrors.description && <p className="error-text">{fieldErrors.description}</p>}
        <div className="counter">
          {form.description.length} / {DESCRIPTION_LIMIT}
        </div>
      </div>

      <div className="field">
        <label htmlFor="key">Idempotency-Key</label>
        <div className="keyrow">
          <input
            id="key"
            className="control mono"
            value={form.key}
            onChange={(e) => set({ key: e.target.value })}
          />
          <button
            type="button"
            className="btn btn--secondary"
            onClick={props.onGenerateKey}
            disabled={inFlight}
          >
            Сгенерировать
          </button>
        </div>
        <p className="sub">
          Ключ живёт 24 часа (TTL). Повтор с тем же ключом и тем же телом вернёт тот же
          платёж, а не создаст новый.
        </p>
      </div>

      <div className="actions">
        <button type="submit" className="btn btn--primary btn--block" disabled={inFlight}>
          Отправить
        </button>
        <button
          type="button"
          className="btn btn--secondary btn--block"
          onClick={props.onRepeat}
          disabled={inFlight || !props.canRepeat}
        >
          Отправить ещё раз тот же запрос
        </button>
        {/* #81: подпись называет поведение буквально, а строка под ней
            показывает хранимый запрос — тот самый, что уйдёт по кнопке.
            Форма может быть уже другой, и это видно, а не скрыто. */}
        <p className="sub">
          Повторяет последний запрос создания дословно — тело и ключ без изменений (U2).
        </p>
        {props.lastSummary && (
          <p className="sub repeat-summary mono">Сейчас это: {props.lastSummary}</p>
        )}
      </div>
    </form>
  )
}
