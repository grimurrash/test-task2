import { Fragment } from 'react'
import type { JournalEntry, JournalItem } from '../types'
import { shortKey } from '../lib/semantics'
import { keyDotColor } from '../lib/keyhue'

function KeyChip({ value }: { value: string }) {
  return (
    <span className="chip chip--key" title={value}>
      <span className="key-dot" style={{ color: keyDotColor(value) }} aria-hidden>
        ●
      </span>
      {shortKey(value)}
    </span>
  )
}

// Тело ответа с подсветкой id/created_at для «того же платежа»: повтор виден
// как повтор — те же значения, что была в ответе 201.
function Payload({ body, highlight }: { body: unknown; highlight: boolean }) {
  const text = typeof body === 'string' ? body : JSON.stringify(body, null, 2)
  if (!highlight) return <div className="payload">{text}</div>
  const lines = text.split('\n')
  return (
    <div className="payload">
      {lines.map((line, i) => {
        const m = line.match(/^(\s*"(?:id|created_at)": )(.*?)(,?)$/)
        const tail = i < lines.length - 1 ? '\n' : ''
        if (!m) return <Fragment key={i}>{line + tail}</Fragment>
        return (
          <Fragment key={i}>
            {m[1]}
            <em>{m[2]}</em>
            {m[3] + tail}
          </Fragment>
        )
      })}
    </div>
  )
}

function Entry({
  entry,
  onToggleBody,
}: {
  entry: JournalEntry
  onToggleBody: (uid: string) => void
}) {
  const badgeText = entry.status === null ? 'нет ответа' : String(entry.status)
  return (
    <article className={`entry entry--${entry.semantic}`}>
      <div className="entry-head">
        <time>{entry.time}</time>
        <span className="method">{entry.method}</span>
        <span className="path">{entry.path}</span>
        <span className={`code-badge code-badge--${entry.semantic}`}>{badgeText}</span>
      </div>
      <div className="entry-body">
        {entry.verdict === 'new' && <span className="verdict verdict--new">новый платёж</span>}
        {entry.verdict === 'same' && <span className="verdict verdict--same">тот же платёж</span>}
        {entry.errorCode && (
          <span
            className={`chip chip--errcode${entry.semantic === 'error' ? ' chip--errcode-error' : ''}`}
          >
            {entry.errorCode}
          </span>
        )}
        {entry.paymentId && <span className="chip">{entry.paymentId}</span>}
        {entry.key && <KeyChip value={entry.key} />}
      </div>
      {entry.note && <p className="note">{entry.note}</p>}
      {entry.body !== undefined && (
        <>
          <button
            type="button"
            className="payload-toggle"
            onClick={() => onToggleBody(entry.uid)}
            aria-expanded={entry.bodyOpen}
          >
            {entry.bodyOpen ? 'скрыть тело ответа' : 'тело ответа'}
          </button>
          {entry.bodyOpen && <Payload body={entry.body} highlight={entry.verdict === 'same'} />}
        </>
      )}
    </article>
  )
}

export function Journal(props: {
  items: JournalItem[]
  onToggleBody: (uid: string) => void
}) {
  if (props.items.length === 0) {
    return <p className="empty">Журнал пуст — отправьте первый запрос.</p>
  }
  return (
    <div className="timeline">
      {props.items.map((item) =>
        item.kind === 'entry' ? (
          <Entry key={item.entry.uid} entry={item.entry} onToggleBody={props.onToggleBody} />
        ) : (
          <div key={item.uid} className={`group group--${item.semantic}`}>
            <div className="group-label">
              {item.label}
              {item.groupKey && (
                <>
                  {' '}
                  <KeyChip value={item.groupKey} />
                </>
              )}
            </div>
            {item.entries.map((e) => (
              <Entry key={e.uid} entry={e} onToggleBody={props.onToggleBody} />
            ))}
          </div>
        ),
      )}
    </div>
  )
}
