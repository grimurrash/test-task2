// N4 — порядок списка при совпадающем created_at (чёрным ящиком, не мутацией).
// N5 — 409 idempotency_key_reuse обязан НЕ трогать существующий платёж.
// N6 — один ключ у разных мерчантов, одновременно.
import { call, create, uniq, GOOD } from './lib.mjs';

console.log('=== N4. Порядок списка при совпадающем created_at ===');
{
  const m = uniq('order');
  const made = [];
  for (let i = 0; i < 25; i++) {
    const r = await create(m, uniq('k'), { ...GOOD, order_id: `seq-${String(i).padStart(2, '0')}` });
    made.push({ i, id: r.id, at: r.json.created_at });
  }
  const byAt = new Map();
  for (const p of made) byAt.set(p.at, (byAt.get(p.at) ?? 0) + 1);
  const ties = [...byAt.values()].filter((c) => c > 1).reduce((a, b) => a + b, 0);
  console.log(`создано ${made.length}, различных created_at ${byAt.size}, участвуют в совпадениях ${ties}`);

  const list = await call('/v1/payments', { headers: { 'X-Merchant-Id': m } });
  const got = list.json.payments.map((p) => p.order_id);
  const want = made.map((p) => p.order_id ?? `seq-${String(p.i).padStart(2, '0')}`).reverse();
  const sortedDesc = list.json.payments.every((p, i, a) => i === 0 || a[i - 1].created_at >= p.created_at);
  console.log('created_at по убыванию:', sortedDesc ? 'да' : 'НЕТ');
  console.log('порядок = обратный порядку создания:', JSON.stringify(got) === JSON.stringify(want) ? 'да' : `НЕТ\n  получено: ${got.join(',')}\n  ожидалось: ${want.join(',')}`);
  console.log('доехало:', ties > 0 ? `да — ${ties} платежей делят created_at с соседом` : 'НЕТ — совпадений created_at не возникло, свойство не проверено');
}

console.log('\n=== N5. 409 idempotency_key_reuse не изменяет существующий платёж ===');
{
  const m = uniq('reuse');
  const k = uniq('k');
  const first = await create(m, k, { ...GOOD, amount_minor: 125000, order_id: 'orig', description: 'исходное' });
  const before = JSON.stringify(first.json);
  const conflict = await create(m, k, { ...GOOD, amount_minor: 777701, order_id: 'подменённый', description: 'подмена' });
  const after = await call(`/v1/payments/${first.id}`, { headers: { 'X-Merchant-Id': m } });
  const list = await call('/v1/payments', { headers: { 'X-Merchant-Id': m } });
  const replay = await create(m, k, { ...GOOD, amount_minor: 125000, order_id: 'orig', description: 'исходное' });
  console.log(`первый: ${first.status} ${first.id}`);
  console.log(`подмена тела: ${conflict.status} ${conflict.code}`);
  console.log(`платёж после подмены идентичен: ${before === JSON.stringify(after.json) ? 'да' : 'НЕТ'}`);
  console.log(`платежей у мерчанта: ${list.json.payments.length} (ожидание 1)`);
  console.log(`повтор исходным телом после конфликта: ${replay.status} ${replay.id === first.id ? 'тот же id' : 'ДРУГОЙ id'}`);
  console.log('доехало: да — сервер ответил 409 именно на подменённое тело');
}

console.log('\n=== N6. Один ключ у разных мерчантов, одновременно ===');
{
  const k = uniq('shared-key');
  const a = uniq('merch-a');
  const b = uniq('merch-b');
  const [ra, rb] = await Promise.all([create(a, k, GOOD), create(b, k, GOOD)]);
  const la = await call('/v1/payments', { headers: { 'X-Merchant-Id': a } });
  const lb = await call('/v1/payments', { headers: { 'X-Merchant-Id': b } });
  const crossA = await call(`/v1/payments/${rb.id}`, { headers: { 'X-Merchant-Id': a } });
  console.log(`A: ${ra.status} ${ra.id} | B: ${rb.status} ${rb.id} | id различны: ${ra.id !== rb.id ? 'да' : 'НЕТ'}`);
  console.log(`список A: ${la.json.payments.length}, список B: ${lb.json.payments.length} (ожидание 1 и 1)`);
  console.log(`A видит платёж B: ${crossA.status} ${crossA.code} (ожидание 404 payment_not_found)`);
  console.log('доехало: да — оба запроса приняты и создали по платежу');
}
