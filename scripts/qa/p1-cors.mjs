// N2. CORS — контракт обещает заголовки Access-Control-* НА ВСЕХ ответах,
// включая 4xx, и 204 без тела на preflight по ЛЮБОМУ пути.
import { call, create, uniq, line, GOOD } from './lib.mjs';

const WANT = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'Content-Type, Idempotency-Key, X-Merchant-Id',
};

function check(name, r) {
  const missing = [];
  const wrong = [];
  for (const [h, want] of Object.entries(WANT)) {
    const got = r.headers[h];
    if (got === undefined) missing.push(h);
    else if (got !== want) wrong.push(`${h}=${got}`);
  }
  const verdict = missing.length === 0 && wrong.length === 0 ? 'CORS OK' : `CORS НЕТ: ${[...missing, ...wrong].join(' ')}`;
  line(String(r.status).padEnd(3), (r.code ?? (r.json ? 'ok' : 'без тела')).padEnd(24), name.padEnd(42), verdict);
}

const m = uniq('cors');
const good = await create(m, uniq('k'), GOOD);

console.log('--- ответы всех классов ---');
check('201 создание', good);
check('200 повтор', await create(m, uniq('k2'), GOOD).then(() => create(m, 'k-replay', GOOD)).then(() => create(m, 'k-replay', GOOD)));
check('200 список', await call('/v1/payments', { headers: { 'X-Merchant-Id': m } }));
check('200 get', await call(`/v1/payments/${good.id}`, { headers: { 'X-Merchant-Id': m } }));
check('400 merchant_id_required', await call('/v1/payments', { headers: {} }));
check('400 invalid_merchant_id', await call('/v1/payments', { headers: { 'X-Merchant-Id': 'bad merchant' } }));
check('400 idempotency_key_required', await call('/v1/payments', { method: 'POST', headers: { 'X-Merchant-Id': m, 'Content-Type': 'application/json' }, body: '{}' }));
check('400 invalid_idempotency_key', await create(m, 'x'.repeat(256), GOOD));
check('400 malformed_request', await create(m, uniq('k'), '{битый'));
check('422 validation_failed', await create(m, uniq('k'), { amount_minor: 0, currency: 'RUB', order_id: 'o' }));
check('409 idempotency_key_reuse', await create(m, 'k-reuse', GOOD).then(() => create(m, 'k-reuse', { ...GOOD, amount_minor: 999 })));
check('404 payment_not_found', await call('/v1/payments/pay_nope', { headers: { 'X-Merchant-Id': m } }));
check('409 payment_not_cancelable', await create(m, uniq('k'), { ...GOOD, amount_minor: 10002 }).then((r) => call(`/v1/payments/${r.id}/cancel`, { method: 'POST', headers: { 'X-Merchant-Id': m } })));
check('404 маршрут не найден', await call('/v1/nope', { headers: { 'X-Merchant-Id': m } }));
check('405 метод не тот', await call('/v1/payments', { method: 'DELETE', headers: { 'X-Merchant-Id': m } }));

console.log('\n--- preflight OPTIONS: контракт обещает 204 без тела на ЛЮБОЙ путь ---');
for (const p of ['/v1/payments', `/v1/payments/${good.id}`, `/v1/payments/${good.id}/cancel`, '/v1/nope', '/', '/совсем/другое']) {
  const r = await call(p, { method: 'OPTIONS', headers: { Origin: 'http://localhost:8081', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type,idempotency-key,x-merchant-id' } });
  const body = r.text.length === 0 ? 'без тела' : `ТЕЛО ${r.text.length}б`;
  check(`OPTIONS ${p} → ${r.status} ${body}`, r);
}
