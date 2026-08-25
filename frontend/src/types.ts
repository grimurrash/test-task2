// Семантика ответа — из tokens.css: created / repeat / conflict / error / network.
export type Semantic = 'created' | 'repeat' | 'conflict' | 'error' | 'network'

export interface JournalEntry {
  uid: string
  time: string // HH:MM:SS локального времени клиента
  method: 'POST' | 'GET'
  path: string
  status: number | null // null — ответ не получен (C7)
  semantic: Semantic
  verdict?: 'new' | 'same' // «новый платёж» / «тот же платёж» — только для создания
  paymentId?: string
  key?: string
  errorCode?: string
  note?: string
  body?: unknown // тело ответа, раскрывается по кнопке
  bodyOpen?: boolean
}

export type JournalItem =
  | { kind: 'entry'; entry: JournalEntry }
  | {
      kind: 'group'
      uid: string
      label: string
      groupKey?: string
      semantic: Semantic
      entries: JournalEntry[]
    }
