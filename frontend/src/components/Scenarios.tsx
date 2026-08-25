export function Scenarios(props: {
  inFlight: boolean
  onRepeat: () => void
  onReuse: () => void
  onRace: () => void
  onDoubleCancel: () => void
  onCancelCompleted: () => void
}) {
  // У чипа ожидания текст и класс различаются только у гонки: «200/409» —
  // недетерминированный исход (решение проджекта по U4), окрашенный янтарным
  // как предупреждение, ровно как в принятом макете.
  const scenarios: Array<{
    name: string
    sub: string
    expects: Array<{ text: string; cls: '200' | '201' | '409' }>
    run: () => void
  }> = [
    {
      name: 'Повтор с тем же телом',
      sub: 'тот же платёж, тот же id',
      expects: [{ text: '200', cls: '200' }],
      run: props.onRepeat,
    },
    {
      name: 'Тот же ключ, другое тело',
      sub: 'idempotency_key_reuse',
      expects: [{ text: '409', cls: '409' }],
      run: props.onReuse,
    },
    {
      name: 'Две одновременные отправки',
      sub: 'ровно один платёж',
      expects: [
        { text: '201', cls: '201' },
        { text: '200/409', cls: '409' },
      ],
      run: props.onRace,
    },
    {
      name: 'Двойная отмена',
      sub: 'отмена идемпотентна',
      expects: [{ text: '200', cls: '200' }],
      run: props.onDoubleCancel,
    },
    {
      name: 'Отменить завершённый платёж',
      sub: 'сумма …02, payment_not_cancelable',
      expects: [{ text: '409', cls: '409' }],
      run: props.onCancelCompleted,
    },
  ]

  return (
    <div className="scenarios">
      <div className="card-title">Готовые сценарии</div>
      {scenarios.map((s) => (
        <button
          key={s.name}
          type="button"
          className="scenario"
          onClick={s.run}
          disabled={props.inFlight}
        >
          <span className="name">
            {s.name}
            <small>{s.sub}</small>
          </span>
          {s.expects.map((e) => (
            <span key={e.text} className={`expect expect--${e.cls}`}>
              {e.text}
            </span>
          ))}
        </button>
      ))}
    </div>
  )
}
