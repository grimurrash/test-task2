import { Component } from 'react'
import type { ErrorInfo, ReactNode } from 'react'

// Граница ошибки вокруг одной карточки/записи (#104): неожидаемое значение
// в данных портит один блок, а не размонтирует страницу целиком. Песочница —
// место, где смотрят поведение системы; страница, умирающая от ответа,
// который ей не понравился, не показывает ничего, включая журнал с диагнозом.
//
// Граница этой защиты, названная явно: отказ из громкого становится тихим —
// заглушка среди нормальных блоков. Поэтому причина уходит не только в текст
// заглушки: componentDidCatch пишет её в консоль браузера явно (не полагаясь
// на дефолт React), со стеком компонента — это переживает взгляд на экран
// и попадает в консольный захват ломателя. Дальше консоли причина не живёт:
// в журнал обмена песочницы не пишется (он про сеть, не про рендер) и
// закрытие вкладки не переживает.
export class CardBoundary extends Component<
  { label: string; children: ReactNode },
  { error: string | null }
> {
  state = { error: null as string | null }

  static getDerivedStateFromError(e: unknown) {
    return { error: e instanceof Error ? e.message : String(e) }
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error(
      `[песочница] «${this.props.label}» не отобразился:`,
      error,
      info.componentStack,
    )
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
