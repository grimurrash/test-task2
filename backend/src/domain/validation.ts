/**
 * Границы входа: заголовки (400) и тело (422).
 *
 * Разделение — из контракта и RFC 9110: 400 — проблема формы запроса, 422 —
 * запрос разобран, но поля не проходят проверку. Вся валидация тела отвечает
 * единым `validation_failed`, а карта «поле → нарушение» перечисляет **все**
 * нарушения разом, а не первое встреченное.
 */
import {
  CURRENCIES,
  type CreateCommand,
  type Currency,
} from './payment.js';
import {
  idempotencyKeyRequired,
  invalidIdempotencyKey,
  invalidMerchantId,
  malformedRequest,
  merchantIdRequired,
  validationFailed,
} from './errors.js';

/**
 * Длина строки так, как её определяет контракт.
 *
 * `maxLength` в JSON Schema 2020-12 — это число символов по RFC 8259, то есть
 * **кодовых точек**, а не кодовых единиц UTF-16. `str.length` в JavaScript
 * считает единицы, и на символах вне основной плоскости (эмодзи, редкие иероглифы)
 * даёт вдвое больше. Из-за этого `order_id` из 33 эмодзи получал 422, хотя
 * контракт и любой сгенерированный из него клиент считают его валидным.
 *
 * Дефект #64. Проверено измерением: тот же `ajv`, которым сверяются ответы,
 * признаёт такую строку валидной против `maxLength: 64`.
 */
function charLength(value: string): number {
  return [...value].length;
}

const MERCHANT_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const IDEMPOTENCY_KEY_MAX = 255;
const ORDER_ID_MAX = 64;
const DESCRIPTION_MAX = 512;

/**
 * Длина значения заголовка в символах.
 *
 * Node отдаёт значение заголовка декодированным побайтно (latin-1), поэтому
 * `value.length` — это число БАЙТ, а не символов: кириллическая буква весит
 * два, эмодзи четыре. Контракт меряет символы, и ключ из 128 кириллических
 * букв отвергался как «длиннее 255». Находка QA #75 — тот же класс, что #64,
 * но третья единица измерения: там кодовые единицы UTF-16, здесь байты UTF-8.
 */
function headerCharLength(value: string): number {
  return [...Buffer.from(value, 'latin1').toString('utf8')].length;
}

/**
 * Заголовок, присланный дважды, — не одно значение и не склейка из двух.
 *
 * Node склеивает повторы через запятую. Для `X-Merchant-Id` склейка выпадала
 * из набора и потому давала 400 — но по совпадению, а не по устройству.
 * У `Idempotency-Key` набор шире, склейка проходила проверку, и на один ключ
 * рождались два платежа (#73). Теперь дубль отвергается явно у обоих.
 */
export function requireMerchantId(values: string[]): string {
  const value = values[0];
  if (value === undefined) throw merchantIdRequired();
  if (values.length > 1) throw invalidMerchantId();
  if (!MERCHANT_ID_PATTERN.test(value)) throw invalidMerchantId();
  return value;
}

/**
 * Пустое значение приравнивается к отсутствию заголовка, слишком длинное —
 * отдельный код: пробел B ревью контракта закрыт правкой (#32, PR #38),
 * симметрично `invalid_merchant_id`.
 */
export function requireIdempotencyKey(values: string[]): string {
  const value = values[0];
  if (value === undefined || value.length === 0) throw idempotencyKeyRequired();
  if (values.length > 1) throw invalidIdempotencyKey('заголовок прислан несколько раз');
  if (headerCharLength(value) > IDEMPOTENCY_KEY_MAX)
    throw invalidIdempotencyKey(`длина превышает ${IDEMPOTENCY_KEY_MAX} символов`);
  return value;
}

/**
 * Разбор тела — слой между заголовками и полями.
 *
 * Пробел A ревью контракта закрыт правкой (#32, PR #38): «разбирать нечего» —
 * это форма запроса, то есть 400 `malformed_request`, а не 422. Ось
 * «400 — форма, 422 — разобранные поля» из RFC 9110 держится целиком.
 */
export function parseBody(raw: string, contentType: string | undefined): Record<string, unknown> {
  if (contentType !== undefined) {
    const mediaType = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
    if (mediaType.length > 0 && mediaType !== 'application/json') {
      throw malformedRequest(`ожидается Content-Type application/json, получен ${mediaType}`);
    }
  }
  if (raw.trim().length === 0) {
    throw malformedRequest('тело запроса пусто');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw malformedRequest('не разбирается как JSON');
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw malformedRequest('ожидается объект JSON');
  }
  return parsed as Record<string, unknown>;
}

function checkAmount(value: unknown, errors: Record<string, string>): void {
  if (value === undefined) {
    errors['amount_minor'] = 'поле обязательно';
    return;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    errors['amount_minor'] = 'ожидается целое число';
    return;
  }
  if (!Number.isInteger(value)) {
    errors['amount_minor'] = 'ожидается целое число без дробной части';
    return;
  }
  if (value < 1) {
    errors['amount_minor'] = 'целое строго больше нуля';
    return;
  }
  if (value > Number.MAX_SAFE_INTEGER) {
    errors['amount_minor'] = 'не выше границы безопасного целого (2^53 − 1)';
  }
}

function checkCurrency(value: unknown, errors: Record<string, string>): void {
  if (value === undefined) {
    errors['currency'] = 'поле обязательно';
    return;
  }
  if (typeof value !== 'string' || !CURRENCIES.includes(value as Currency)) {
    errors['currency'] = `вне списка ${CURRENCIES.join(', ')} (регистр строгий)`;
  }
}

function checkOrderId(value: unknown, errors: Record<string, string>): void {
  if (value === undefined) {
    errors['order_id'] = 'поле обязательно';
    return;
  }
  if (typeof value !== 'string') {
    errors['order_id'] = 'ожидается строка';
    return;
  }
  if (value.length === 0) {
    errors['order_id'] = 'не должен быть пустым';
    return;
  }
  if (charLength(value) > ORDER_ID_MAX) {
    errors['order_id'] = `длина превышает ${ORDER_ID_MAX} символов`;
  }
}

/**
 * `description` в запросе объявлен `type: string` без `null` — в отличие
 * от ответа, где поле nullable. Асимметрия намеренная: в запросе поле опускают.
 * Читаем строго по контракту.
 */
function checkDescription(value: unknown, errors: Record<string, string>): void {
  if (value === undefined) return;
  if (typeof value !== 'string') {
    errors['description'] = 'ожидается строка либо отсутствие поля';
    return;
  }
  if (charLength(value) > DESCRIPTION_MAX) {
    errors['description'] = `длина превышает ${DESCRIPTION_MAX} символов`;
  }
}

const KNOWN_FIELDS = new Set(['amount_minor', 'currency', 'order_id', 'description']);

/**
 * Карта нарушений создаётся **без прототипа**.
 *
 * Ключи сюда приходят из тела запроса, то есть от недоверенной стороны.
 * У обычного объекта `errors['__proto__'] = '...'` не создаёт своего поля,
 * а уходит в сеттер прототипа — нарушение теряется молча, и поле сверх схемы
 * проезжает в ответ 201 вместо 422. Находка ревью #47; свойство контракта
 * («лишние поля отвергаются») держалось на том, что никто не назовёт поле
 * служебным именем.
 */
function emptyErrors(): Record<string, string> {
  return Object.create(null) as Record<string, string>;
}

export function validateCreateBody(body: Record<string, unknown>): CreateCommand {
  const errors = emptyErrors();

  checkAmount(body['amount_minor'], errors);
  checkCurrency(body['currency'], errors);
  checkOrderId(body['order_id'], errors);
  checkDescription(body['description'], errors);

  // Решение по пробелу C (#32): `additionalProperties: false` — лишнее поле
  // теперь ошибка, а не тихо отброшенное значение.
  for (const field of Object.keys(body)) {
    if (!KNOWN_FIELDS.has(field)) errors[field] = 'поле не описано контрактом';
  }

  if (Object.keys(errors).length > 0) throw validationFailed(errors);

  return {
    amount_minor: body['amount_minor'] as number,
    currency: body['currency'] as Currency,
    order_id: body['order_id'] as string,
    description: (body['description'] as string | undefined) ?? null,
  };
}
