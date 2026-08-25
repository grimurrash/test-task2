export const BASE = process.env.BASE ?? 'http://localhost:8123';
let n = 0;
export const uniq = (p = 'kr') => `${p}-${Date.now().toString(36)}-${++n}`;

export async function call(path, opts = {}) {
  const res = await fetch(BASE + path, opts);
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = undefined; }
  return { status: res.status, headers: Object.fromEntries(res.headers.entries()), text, json,
           code: json?.error?.code, id: json?.id };
}

export const GOOD = { amount_minor: 125000, currency: 'RUB', order_id: 'kr-order-1' };

export function create(merchant, key, body = GOOD, extra = {}) {
  return call('/v1/payments', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Merchant-Id': merchant, 'Idempotency-Key': key, ...extra },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}
export const line = (...c) => console.log(c.join(' | '));
