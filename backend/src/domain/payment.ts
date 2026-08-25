/** Платёж — основной ресурс API. Форма и правила взяты из openapi/openapi.yaml. */

export type PaymentStatus = 'pending' | 'succeeded' | 'failed' | 'canceled';
export type StatusReason = 'test_amount_rule' | null;
export type Currency = 'RUB' | 'USD' | 'EUR';

export const CURRENCIES: readonly Currency[] = ['RUB', 'USD', 'EUR'];

export interface Payment {
  id: string;
  status: PaymentStatus;
  status_reason: StatusReason;
  amount_minor: number;
  currency: Currency;
  order_id: string;
  description: string | null;
  created_at: string;
}

/** Разобранное и проверенное тело запроса на создание. */
export interface CreateCommand {
  amount_minor: number;
  currency: Currency;
  order_id: string;
  description: string | null;
}

/**
 * Правило тестовых сумм (F17, F18). Считается остатком, а не последними
 * цифрами: поэтому суммы 1 и 2 минорных единицы — тоже триггеры, и контракт
 * это оговаривает отдельно.
 */
export function statusForAmount(amountMinor: number): {
  status: PaymentStatus;
  status_reason: StatusReason;
} {
  const remainder = amountMinor % 100;
  if (remainder === 1) return { status: 'failed', status_reason: 'test_amount_rule' };
  if (remainder === 2) return { status: 'succeeded', status_reason: 'test_amount_rule' };
  return { status: 'pending', status_reason: null };
}

/**
 * Порядок ключей задан здесь и только здесь: повтор обязан вернуть тот же
 * ресурс байт-в-байт (F2), а это свойство сериализации, а не хранения.
 */
export function buildPayment(
  id: string,
  command: CreateCommand,
  createdAt: string,
): Payment {
  const { status, status_reason } = statusForAmount(command.amount_minor);
  return {
    id,
    status,
    status_reason,
    amount_minor: command.amount_minor,
    currency: command.currency,
    order_id: command.order_id,
    description: command.description,
    created_at: createdAt,
  };
}

/**
 * Отпечаток тела для сравнения повторов.
 *
 * Пробел C ревью контракта: «то же тело» контрактом не определено. Временное
 * чтение — сравнение по разобранным полям, а не побайтово: иначе идемпотентность
 * становится свойством JSON-сериализатора клиента, а не смысла запроса.
 * Когда контракт получит определение, меняется только эта функция.
 */
export function fingerprintOf(command: CreateCommand): string {
  return JSON.stringify([
    command.amount_minor,
    command.currency,
    command.order_id,
    command.description,
  ]);
}
