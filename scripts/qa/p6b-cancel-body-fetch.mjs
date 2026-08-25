// N19, уточнение: как выглядит тот же случай для клиента браузерного класса
// (undici/fetch — тот же стек, что у песочницы), а не только для curl.
import { call, create, uniq, GOOD } from './lib.mjs';

const m = uniq('cancelbody');

for (const size of [1024, 262144, 1048576, 4194304]) {
  const r = await create(m, uniq('k'), { ...GOOD, order_id: `cb-${size}` });
  const body = 'x'.repeat(size);
  let outcome;
  try {
    const res = await call(`/v1/payments/${r.id}/cancel`, {
      method: 'POST',
      headers: { 'X-Merchant-Id': m, 'Content-Type': 'application/json' },
      body,
    });
    outcome = `ответ получен: ${res.status} ${res.json?.status ?? res.code}`;
  } catch (e) {
    outcome = `ОШИБКА КЛИЕНТА: ${e.constructor.name}: ${e.message}${e.cause ? ` (${e.cause.code ?? e.cause.message})` : ''}`;
  }
  const after = await call(`/v1/payments/${r.id}`, { headers: { 'X-Merchant-Id': m } });
  console.log(`тело ${String(size).padStart(8)} б -> ${outcome.padEnd(64)} | платёж на сервере: ${after.json?.status}`);
}
