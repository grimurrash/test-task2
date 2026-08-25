// N3 + N13 + сверка тел ошибок со схемой контракта.
// HEAD — RFC 9110 §9.3.2: сервер, поддерживающий GET, обязан поддерживать HEAD.
import { call, create, uniq, GOOD } from './lib.mjs';
import { violations, ERROR_CODES } from './contract.mjs';

const m = uniq('routes');
const p = await create(m, uniq('k'), GOOD);
const H = { 'X-Merchant-Id': m };

const cases = [
  ['HEAD  /v1/payments', 'HEAD', '/v1/payments'],
  ['HEAD  /v1/payments/{id}', 'HEAD', `/v1/payments/${p.id}`],
  ['PUT   /v1/payments/{id}', 'PUT', `/v1/payments/${p.id}`],
  ['PATCH /v1/payments/{id}', 'PATCH', `/v1/payments/${p.id}`],
  ['DELETE /v1/payments', 'DELETE', '/v1/payments'],
  ['GET   /v1/payments/{id}/cancel', 'GET', `/v1/payments/${p.id}/cancel`],
  ['POST  /v1/payments/{id}', 'POST', `/v1/payments/${p.id}`],
  ['POST  /v1/nope', 'POST', '/v1/nope'],
  ['GET   /V1/payments (регистр)', 'GET', '/V1/payments'],
  ['GET   /v1/payments/ (косая)', 'GET', '/v1/payments/'],
  ['GET   /v1/payments///', 'GET', '/v1/payments///'],
  ['GET   //v1/payments', 'GET', '//v1/payments'],
  ['GET   /v1/payments?x=1', 'GET', '/v1/payments?x=1'],
  ['GET   /v1/payments/%zz (битый %)', 'GET', '/v1/payments/%zz'],
  ['GET   /v1/payments/%00', 'GET', '/v1/payments/%00'],
  ['GET   /v1/payments/{чужой id}', 'GET', `/v1/payments/${p.id}`, { 'X-Merchant-Id': uniq('other') }],
];

console.log('метод и путь                     | код | code                 | тело против schemas/Error');
for (const [name, method, path, headers] of cases) {
  const r = await call(path, { method, headers: headers ?? H });
  let schema = '—';
  if (r.status >= 400) {
    const v = violations('/components/schemas/Error', r.json);
    schema = v.length === 0 ? 'соответствует' : `НАРУШЕНИЕ: ${v.join('; ')}`;
  } else if (r.json?.payments !== undefined) {
    const v = violations('/components/schemas/PaymentList', r.json);
    schema = v.length === 0 ? 'список ок' : `НАРУШЕНИЕ: ${v.join('; ')}`;
  } else if (r.json?.id !== undefined) {
    const v = violations('/components/schemas/Payment', r.json);
    schema = v.length === 0 ? 'платёж ок' : `НАРУШЕНИЕ: ${v.join('; ')}`;
  } else if (r.text.length === 0) {
    schema = 'тело пустое';
  }
  console.log(`${name.padEnd(32)} | ${String(r.status).padEnd(3)} | ${String(r.code ?? '—').padEnd(20)} | ${schema}`);
  if (r.headers.allow !== undefined) console.log(`${''.padEnd(32)} |     | Allow: ${r.headers.allow}`);
}

console.log('\nКоды в контракте (ErrorCode.enum):', ERROR_CODES.join(', '));
