/**
 * Формат ошибок 5.4: единый конверт `{"error": {code, message, details?}}`.
 *
 * Двенадцать кодов контракта — исчерпывающий перечень для всего, что контракт
 * описывает, включая маршрутизацию (#94). За его границей остался только отказ
 * сервера: `5xx` контракт объявляет своей границей прямо.
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
  | 'payment_not_cancelable'
  // Коды маршрутизации: путь вне описанных и метод, для пути не описанный.
  // Внесены в контракт задачей #94 — прежде отвечали кодами вне перечня,
  // и любой такой ответ нарушал A7. Находка QA #74.
  | 'not_found'
  | 'method_not_allowed';

/**
 * За границей контракта остался только отказ сервера: `5xx` контракт объявляет
 * своей границей прямо — формат тела там не гарантируется. Конверт 5.4 держим
 * и в нём, но выдавать этот код за часть контракта нельзя.
 */
export type OffContractErrorCode = 'internal_error';

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

export const invalidMerchantId = (reason: string): ApiError =>
  new ApiError(400, 'invalid_merchant_id', `X-Merchant-Id не принят: ${reason}`);

export const idempotencyKeyRequired = (): ApiError =>
  new ApiError(
    400,
    'idempotency_key_required',
    'Заголовок Idempotency-Key обязателен при создании платежа: непустая строка до 255 символов',
  );

/**
 * Причина называется в сообщении. Отказ 400 полезен ровно тем, что приходит
 * немедленно и к тому, кто может починить запрос, — а «слишком длинный»
 * на дубле заголовка уводит от настоящей причины и отнимает у клиента то самое
 * время, ради экономии которого отказ и выдан.
 */
export const invalidIdempotencyKey = (reason: string): ApiError =>
  new ApiError(400, 'invalid_idempotency_key', `Idempotency-Key не принят: ${reason}`);

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
