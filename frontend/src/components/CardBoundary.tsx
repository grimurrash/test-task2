import { Component } from 'react'
import type { ReactNode } from 'react'

// Граница ошибки вокруг одной карточки/записи (#104): неожидаемое значение
// в данных портит один блок, а не размонтирует страницу целиком. Песочница —
// место, где смотрят поведение системы; страница, умирающая от ответа,
// который ей не понравился, не показывает ничего, включая журнал с диагнозом.
export class CardBoundary extends Component<
  { label: string; children: ReactNode },
  { error: string | null }
> {
  state = { error: null as string | null }

  static getDerivedStateFromError(e: unknown) {
    return { error: e instanceof Error ? e.message : String(e) }
  }

  render() {
    if (this.state.error !== null) {
      return (
        <div className="render-fallback" role="note">
          {this.props.label} не отобразился: {this.state.error}
        </div>
      )
    }
    return this.props.children
  }
}
