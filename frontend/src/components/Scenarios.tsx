export function Scenarios(props: {
  inFlight: boolean
  onRepeat: () => void
  onReuse: () => void
  onRace: () => void
  onDoubleCancel: () => void
  onCancelCompleted: () => void
}) {
  const { inFlight } = props
  const scenarios: Array<{
    name: string
    sub: string
    expects: Array<{ code: string; cls: '200' | '201' | '409' }>
    run: () => void
  }> = [
    {
      name: 'Повтор с тем же телом',
      sub: 'тот же платёж, тот же id',
      expects: [{ code: '200', cls: '200' }],
      run: props.onRepeat,
    },
    {
      name: 'Тот же ключ, другое тело',
      sub: 'idempotency_key_reuse',
      expects: [{ code: '409', cls: '409' }],
      run: props.onReuse,
    },
    {
      // Исход гонки зафиксирован контрактом на 409 request_in_progress (#32).
      name: 'Две одновременные отправки',
      sub: 'ровно один платёж',
      expects: [
        { code: '201', cls: '201' },
        { code: '409', cls: '409' },
      ],
      run: props.onRace,
    },
    {
      name: 'Двойная отмена',
      sub: 'отмена идемпотентна',
      expects: [{ code: '200', cls: '200' }],
      run: props.onDoubleCancel,
    },
    {
      name: 'Отменить завершённый платёж',
      sub: 'сумма …02, payment_not_cancelable',
      expects: [{ code: '409', cls: '409' }],
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
          disabled={inFlight}
        >
          <span className="name">
            {s.name}
            <small>{s.sub}</small>
          </span>
          {s.expects.map((e) => (
            <span key={e.code} className={`expect expect--${e.cls}`}>
              {e.code}
            </span>
          ))}
        </button>
      ))}
    </div>
  )
}
