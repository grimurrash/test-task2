import { Fragment, useState } from 'react'
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
// как повтор — те же значения, что были в ответе 201.
//
// Строковые значения обёрнуты в <bdi> (#76): управляющие bidi-символы
// в недоверенном тексте (U+202E и родня) переворачивают своё значение —
// это верное поведение показа «как есть», — но не утаскивают наши кавычки,
// запятые и соседние строки JSON. Изоляция, не фильтрация: текст остаётся
// ровно тем, что прислал сервер.
function Payload({ body, highlight }: { body: unknown; highlight: boolean }) {
  const text = typeof body === 'string' ? body : JSON.stringify(body, null, 2)
  const lines = text.split('\n')
  return (
    <div className="payload">
      {lines.map((line, i) => {
        const tail = i < lines.length - 1 ? '\n' : ''
        const hl = highlight && line.match(/^(\s*"(?:id|created_at)": )(.*?)(,?)$/)
        if (hl) {
          return (
            <Fragment key={i}>
              {hl[1]}
              <em>{hl[2]}</em>
              {hl[3] + tail}
            </Fragment>
          )
        }
        const str = line.match(/^(\s*"[^"]*": ")(.*)(",?)$/)
        if (str) {
          return (
            <Fragment key={i}>
              {str[1]}
              <bdi>{str[2]}</bdi>
              {str[3] + tail}
            </Fragment>
          )
        }
        return <Fragment key={i}>{line + tail}</Fragment>
      })}
    </div>
  )
}

function Entry({ entry }: { entry: JournalEntry }) {
  // Раскрытие тела — забота самой записи; «тот же платёж» раскрыт сразу,
  // чтобы совпадение id/created_at было видно без клика.
  const [open, setOpen] = useState(entry.verdict === 'same')
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
          <span className={`chip chip--errcode chip--errcode--${entry.semantic}`}>
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
            onClick={() => setOpen(!open)}
            aria-expanded={open}
          >
            {open ? 'скрыть тело ответа' : 'тело ответа'}
          </button>
          {open && <Payload body={entry.body} highlight={entry.verdict === 'same'} />}
        </>
      )}
    </article>
  )
}

export function Journal(props: { items: JournalItem[] }) {
  if (props.items.length === 0) {
    return <p className="empty">Журнал пуст — отправьте первый запрос.</p>
  }
  return (
    <div className="timeline">
      {props.items.map((item) =>
        item.kind === 'entry' ? (
          <Entry key={item.entry.uid} entry={item.entry} />
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
            {item.note && <p className="note">{item.note}</p>}
            {item.entries.map((e) => (
              <Entry key={e.uid} entry={e} />
            ))}
          </div>
        ),
      )}
    </div>
  )
}
