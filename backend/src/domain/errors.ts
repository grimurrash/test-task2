/**
 * Формат ошибок 5.4: единый конверт `{"error": {code, message, details?}}`.
 *
 * Восемь кодов контракта — исчерпывающий перечень для тех ситуаций, которые
 * контракт описывает. Коды из `OFF_CONTRACT_CODES` описывают то, о чём контракт
 * молчит вовсе (чужой маршрут, чужой метод, отказ сервера): конверт держится
 * и там, но выдавать эти коды за часть контракта нельзя.
 */

export type ContractErrorCode =
  | 'merchant_id_required'
  | 'invalid_merchant_id'
  | 'idempotency_key_required'
  | 'invalid_idempotency_key'
  | 'malformed_request'
  | 'validation_failed'
  | 'idempotency_key_reuse'
  | 'request_in_progress'
  | 'payment_not_found'
  | 'payment_not_cancelable';

/**
 * Коды за границей контракта: неизвестный маршрут, чужой метод и отказ сервера
 * контракт не описывает вовсе. Конверт 5.4 держим и там, но выдавать эти коды
 * за часть контракта нельзя — `5xx` контракт объявляет своей границей прямо.
 */
export type OffContractErrorCode = 'not_found' | 'method_not_allowed' | 'internal_error';

export type ErrorCode = ContractErrorCode | OffContractErrorCode;

export interface ErrorDetails {
  errors?: Record<string, string>;
  status?: string;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    readonly details?: ErrorDetails,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  body(): { error: { code: ErrorCode; message: string; details?: ErrorDetails } } {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details ? { details: this.details } : {}),
      },
    };
  }
}

export const merchantIdRequired = (): ApiError =>
  new ApiError(400, 'merchant_id_required', 'Заголовок X-Merchant-Id обязателен');

export const invalidMerchantId = (): ApiError =>
  new ApiError(
    400,
    'invalid_merchant_id',
    'X-Merchant-Id должен быть непустой строкой до 64 символов из набора A–Z a–z 0–9 . _ -',
  );

export const idempotencyKeyRequired = (): ApiError =>
  new ApiError(
    400,
    'idempotency_key_required',
    'Заголовок Idempotency-Key обязателен при создании платежа: непустая строка до 255 символов',
  );

export const invalidIdempotencyKey = (): ApiError =>
  new ApiError(
    400,
    'invalid_idempotency_key',
    'Idempotency-Key не должен быть длиннее 255 символов',
  );

export const malformedRequest = (reason: string): ApiError =>
  new ApiError(400, 'malformed_request', `Тело запроса не разобрано: ${reason}`);

export const validationFailed = (errors: Record<string, string>): ApiError =>
  new ApiError(422, 'validation_failed', 'Тело запроса не прошло валидацию', { errors });

export const idempotencyKeyReuse = (): ApiError =>
  new ApiError(
    409,
    'idempotency_key_reuse',
    'Idempotency-Key уже использован с другим телом запроса; существующий платёж не изменён',
  );

export const requestInProgress = (): ApiError =>
  new ApiError(
    409,
    'request_in_progress',
    'Запрос с этим Idempotency-Key ещё обрабатывается; повторите попытку позже',
  );

export const paymentNotFound = (): ApiError =>
  new ApiError(404, 'payment_not_found', 'Платёж не найден');

export const paymentNotCancelable = (status: string): ApiError =>
  new ApiError(409, 'payment_not_cancelable', `Платёж в статусе ${status} отменить нельзя`, {
    status,
  });
