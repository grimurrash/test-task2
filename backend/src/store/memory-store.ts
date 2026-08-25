/**
 * Хранилище в памяти (R6) и — главное — захват ключа идемпотентности.
 *
 * Наивная реализация, которая и есть главный дефект темы:
 *
 *     if (!keys.has(k)) {          // проверка
 *       await persist(payment);    //   ← щель: сюда попадает второй запрос
 *       keys.set(k, record);       // запись
 *     }
 *
 * Здесь `reserve` делает проверку и захват **без единого `await` между ними**.
 * В однопоточном цикле событий это атомарно: второй запрос не может вклиниться
 * между `get` и `set`. Асинхронная фиксация происходит уже после захвата,
 * и на это время ключ виден как «в полёте» — состояние, ради которого
 * в контракте заведён код `request_in_progress`.
 *
 * Граница честности: это корректно для одного процесса. Горизонтальное
 * масштабирование потребует общего хранилища и уникального ограничения
 * на пару (мерчант, ключ).
 */
import type { Payment } from '../domain/payment.js';

export interface StoreOptions {
  now: () => number;
  ttlMs: number;
}

interface KeyRecord {
  fingerprint: string;
  reservedAt: number;
  /** Пока не задан — запрос ещё в полёте. */
  paymentId?: string;
}

export interface Ticket {
  slot: string;
  record: KeyRecord;
}

export type ReserveOutcome =
  | { kind: 'reserved'; ticket: Ticket }
  | { kind: 'replay'; payment: Payment }
  | { kind: 'conflict' }
  | { kind: 'in_progress' };

interface StoredPayment {
  merchantId: string;
  seq: number;
  payment: Payment;
}

export class MemoryStore {
  readonly #keys = new Map<string, KeyRecord>();
  readonly #payments = new Map<string, StoredPayment>();
  readonly #now: () => number;
  readonly #ttlMs: number;
  #seq = 0;

  constructor(options: StoreOptions) {
    this.#now = options.now;
    this.#ttlMs = options.ttlMs;
  }

  #slot(merchantId: string, key: string): string {
    // Ключ уникален в пределах мерчанта (F6). Разделитель — нулевой байт:
    // его не может быть ни в идентификаторе мерчанта (набор [A-Za-z0-9._-]),
    // ни в значении заголовка. Записан экранированием, чтобы файл оставался
    // текстовым для diff, grep и ревью.
    return `${merchantId}\u0000${key}`;
  }

  #expired(record: KeyRecord): boolean {
    return this.#now() - record.reservedAt > this.#ttlMs;
  }

  /**
   * Критическая секция. Между `get` и `set` нет ни одного `await` — и это
   * не стилистика, а условие корректности F4.
   */
  reserve(merchantId: string, key: string, fingerprint: string): ReserveOutcome {
    const slot = this.#slot(merchantId, key);
    const existing = this.#keys.get(slot);

    if (existing !== undefined && !this.#expired(existing)) {
      // Конфликт тела разбирается раньше гонки: он окончателен, повтор позже
      // его не исправит, тогда как `request_in_progress` — приглашение повторить.
      if (existing.fingerprint !== fingerprint) return { kind: 'conflict' };
      if (existing.paymentId === undefined) return { kind: 'in_progress' };

      const stored = this.#payments.get(existing.paymentId);
      if (stored === undefined) return { kind: 'in_progress' };
      return { kind: 'replay', payment: stored.payment };
    }

    const record: KeyRecord = { fingerprint, reservedAt: this.#now() };
    this.#keys.set(slot, record);
    return { kind: 'reserved', ticket: { slot, record } };
  }

  /** Фиксация: платёж появляется в хранилище, бронь превращается в повтор. */
  commit(ticket: Ticket, merchantId: string, payment: Payment): void {
    this.#seq += 1;
    this.#payments.set(payment.id, { merchantId, seq: this.#seq, payment });
    ticket.record.paymentId = payment.id;
  }

  /**
   * Освобождение брони, если создание сорвалось. Снимается только своя запись:
   * чужую, поставленную после истечения TTL, трогать нельзя.
   */
  release(ticket: Ticket): void {
    if (this.#keys.get(ticket.slot) === ticket.record) {
      this.#keys.delete(ticket.slot);
    }
  }

  /** Чужой платёж неотличим от несуществующего — оба дают undefined. */
  find(merchantId: string, id: string): Payment | undefined {
    const stored = this.#payments.get(id);
    if (stored === undefined || stored.merchantId !== merchantId) return undefined;
    return stored.payment;
  }

  replace(payment: Payment): void {
    const stored = this.#payments.get(payment.id);
    if (stored === undefined) return;
    this.#payments.set(payment.id, { ...stored, payment });
  }

  /**
   * Список мерчанта, новые сверху. При совпадении `created_at` порядок задаёт
   * номер записи — иначе сортировка перестала бы быть детерминированной,
   * а тест на неё начал бы мигать.
   */
  list(merchantId: string): Payment[] {
    return [...this.#payments.values()]
      .filter((stored) => stored.merchantId === merchantId)
      .sort((a, b) => {
        if (a.payment.created_at !== b.payment.created_at) {
          return a.payment.created_at < b.payment.created_at ? 1 : -1;
        }
        return b.seq - a.seq;
      })
      .map((stored) => stored.payment);
  }
}
