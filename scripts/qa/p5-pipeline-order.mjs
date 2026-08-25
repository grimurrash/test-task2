// N4, доведённая до «доехало»: конвейер HTTP/1.1 — десять POST подряд в одном
// сокете. Сервер обрабатывает их по порядку, поэтому порядок создания известен
// точно, а created_at у соседей совпадает по миллисекунде.
import net from 'node:net';
import { call, uniq } from './lib.mjs';

const PORT = Number(new URL(process.env.BASE ?? 'http://localhost:8123').port);
const N = 10;
const merchant = uniq('pipe');

function request(i) {
  const body = JSON.stringify({ amount_minor: 100000 + i, currency: 'RUB', order_id: `pipe-${String(i).padStart(2, '0')}` });
  return [
    'POST /v1/payments HTTP/1.1',
    'Host: localhost',
    'Content-Type: application/json',
    `X-Merchant-Id: ${merchant}`,
    `Idempotency-Key: ${merchant}-${i}`,
    `Content-Length: ${Buffer.byteLength(body)}`,
    '', body,
  ].join('\r\n');
}

const raw = await new Promise((resolve, reject) => {
  const chunks = [];
  const sock = net.connect(PORT, '127.0.0.1', () => {
    sock.write(Array.from({ length: N }, (_, i) => request(i)).join(''));
  });
  sock.on('data', (c) => {
    chunks.push(c);
    const text = Buffer.concat(chunks).toString('utf8');
    if ((text.match(/^HTTP\/1\.1 /gm) ?? []).length === N && text.trimEnd().endsWith('}')) {
      sock.end();
      resolve(text);
    }
  });
  sock.on('error', reject);
  sock.on('close', () => resolve(Buffer.concat(chunks).toString('utf8')));
});

const statuses = (raw.match(/HTTP\/1\.1 \d{3}/g) ?? []).map((s) => s.slice(-3));
console.log(`ответов получено: ${statuses.length} из ${N}, статусы: ${statuses.join(',')}`);

// Тело приходит chunked — сервер не ставит Content-Length. Прошлая версия
// разбирала его как обычное, получала undefined и считала совпадения
// created_at по собственным undefined: «доехало» было ложным. Метки берутся
// из списка мерчанта, то есть от сервера.
const list = await call('/v1/payments', { headers: { 'X-Merchant-Id': merchant } });
const rows = list.json.payments;
for (const r of rows) console.log(`  ${r.order_id} ${r.id} ${r.created_at}`);

const times = new Map();
for (const r of rows) times.set(r.created_at, (times.get(r.created_at) ?? 0) + 1);
const tied = [...times.values()].filter((n) => n > 1).reduce((a, b) => a + b, 0);
console.log(`\nразличных created_at: ${times.size} на ${rows.length} платежей; делят метку с соседом: ${tied}`);
console.log('доехало:', tied > 1 ? 'да — совпадение created_at достигнуто на живом сервере' : 'НЕТ — метки различны, свойство не проверено');

const got = rows.map((p) => p.order_id);
const want = Array.from({ length: N }, (_, i) => `pipe-${String(i).padStart(2, '0')}`).reverse();
console.log(`\nсписок:    ${got.join(' ')}`);
console.log(`ожидание:  ${want.join(' ')}`);
console.log('порядок «новые сверху» при совпадающем created_at:', JSON.stringify(got) === JSON.stringify(want) ? 'держится' : 'НАРУШЕН');
