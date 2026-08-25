import { useState } from 'react'
import type { Payment } from '../api/client'
import { formatAmount } from '../lib/money'

// description — недоверенный текст (U6/A10): только текстовые узлы React,
// никакого dangerouslySetInnerHTML. Длинный текст обрезан тремя строками,
// раскрытие снимает line-clamp (design/README.md, «Края поведения»).
function Description({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  const long = text.length > 120
  return (
    <>
      <p className={`desc${open ? ' desc--open' : ''}`}>{text}</p>
      {long && (
        <button type="button" className="desc-toggle" onClick={() => setOpen(!open)}>
          {open ? 'свернуть' : 'показать целиком'}
        </button>
      )}
    </>
  )
}

export function PaymentsList(props: {
  merchant: string
  payments: Payment[]
  note: string | null
}) {
  return (
    <>
      <div className="card-title">
        Платежи
        <strong>
          {props.merchant} · {props.payments.length}
        </strong>
      </div>
      <p className="payments-count">Повторы и конфликты список не увеличивают.</p>
      {props.note && <p className="payments-note">{props.note}</p>}
      {props.payments.length === 0 && !props.note && (
        <p className="empty">Платежей пока нет.</p>
      )}
      {props.payments.map((p) => (
        <article className="payment" key={p.id}>
          <div className="payment-head">
            <span className="amount">{formatAmount(p.amount_minor, p.currency)}</span>
            <span className="minor mono">{p.amount_minor}</span>
            <span className={`status status--${p.status}`}>{p.status}</span>
          </div>
          <div className="meta">
            <span className="chip">{p.id}</span>
            <span className="mono">{p.order_id}</span>
            {p.status_reason !== null && (
              <span className="chip">status_reason: {p.status_reason}</span>
            )}
          </div>
          {p.description !== null && p.description !== '' && (
            <Description text={p.description} />
          )}
        </article>
      ))}
    </>
  )
}
