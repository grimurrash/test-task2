import { API_BASE } from '../api/client'
import { MERCHANTS } from '../App'
import type { Merchant } from '../App'

export function Topbar(props: {
  merchant: Merchant
  onMerchant: (m: Merchant) => void
}) {
  return (
    <header className="topbar">
      <div className="brand">
        <div className="overline">Идемпотентный платёжный сервис</div>
        <h1>Песочница платежей</h1>
      </div>
      <span className="baseurl">{API_BASE}</span>
      <div className="merchant">
        <div className="label">Мерчант · X-Merchant-Id</div>
        <div className="segmented" role="group" aria-label="X-Merchant-Id">
          {MERCHANTS.map((m) => (
            <button
              key={m}
              type="button"
              className={m === props.merchant ? 'active' : undefined}
              aria-pressed={m === props.merchant}
              onClick={() => props.onMerchant(m)}
            >
              {m}
            </button>
          ))}
        </div>
        <p className="hint">
          Ключ идемпотентности живёт внутри мерчанта: переключите и отправьте с тем же
          ключом — создастся новый платёж (F6).
        </p>
      </div>
    </header>
  )
}
