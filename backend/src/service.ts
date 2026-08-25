/** Сценарии API поверх хранилища: создание, чтение, отмена, список. */
import {
  buildPayment,
  fingerprintOf,
  type CreateCommand,
  type Payment,
} from './domain/payment.js';
import {
  idempotencyKeyReuse,
  paymentNotCancelable,
  paymentNotFound,
  requestInProgress,
} from './domain/errors.js';
import type { MemoryStore } from './store/memory-store.js';

export interface ServiceDeps {
  now: () => number;
  newId: () => string;
  /**
   * Фиксация платежа. В памяти она мгновенна, но остаётся асинхронной
   * намеренно: контракт заводит код `request_in_progress`, а он существует
   * только там, где у создания есть окно. Тест подменяет эту функцию барьером
   * и делает окно наблюдаемым.
   */
  commit: (payment: Payment) => Promise<void> | void;
}

export interface CreateResult {
  /** 201 — платёж создан этим запросом; 200 — повтор вернул существующий. */
  status: 201 | 200;
  payment: Payment;
}

export class PaymentService {
  constructor(
    private readonly store: MemoryStore,
    private readonly deps: ServiceDeps,
  ) {}

  async create(
    merchantId: string,
    idempotencyKey: string,
    command: CreateCommand,
  ): Promise<CreateResult> {
    const outcome = this.store.reserve(merchantId, idempotencyKey, fingerprintOf(command));

    switch (outcome.kind) {
      case 'conflict':
        throw idempotencyKeyReuse();
      case 'in_progress':
        throw requestInProgress();
      case 'replay':
        return { status: 200, payment: outcome.payment };
      case 'reserved':
        break;
    }

    const payment = buildPayment(
      this.deps.newId(),
      command,
      new Date(this.deps.now()).toISOString(),
    );

    try {
      await this.deps.commit(payment);
    } catch (error) {
      // Сорвавшееся создание не имеет права держать ключ занятым:
      // иначе клиент, которому нечего повторять, получал бы вечный 409.
      this.store.release(outcome.ticket);
      throw error;
    }

    this.store.commit(outcome.ticket, merchantId, payment);
    return { status: 201, payment };
  }

  get(merchantId: string, id: string): Payment {
    const payment = this.store.find(merchantId, id);
    if (payment === undefined) throw paymentNotFound();
    return payment;
  }

  /** Отмена идемпотентна: повтор возвращает тот же результат, а не ошибку. */
  cancel(merchantId: string, id: string): Payment {
    const payment = this.get(merchantId, id);
    if (payment.status === 'canceled') return payment;
    if (payment.status !== 'pending') throw paymentNotCancelable(payment.status);

    const canceled: Payment = { ...payment, status: 'canceled' };
    this.store.replace(canceled);
    return canceled;
  }

  list(merchantId: string): { payments: Payment[] } {
    return { payments: this.store.list(merchantId) };
  }
}
