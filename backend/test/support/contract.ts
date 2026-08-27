/**
 * Проверка ответов против `openapi/openapi.yaml` (A7).
 *
 * Контракт — источник правды, а не украшение: каждый ответ в тестах проходит
 * через `assertMatchesContract`, и расхождение падает тестом, а не всплывает
 * у фронта. OpenAPI 3.1 — это JSON Schema 2020-12, поэтому схемы берутся
 * из документа как есть, без переписывания.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const require = createRequire(import.meta.url);
/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
// ajv 8 — пакет CommonJS без карты exports; сборка 2020-12 подключается
// напрямую файлом, поэтому интероп разбирается здесь, а не растекается по коду.
const ajvExport = require('ajv/dist/2020.js');
const formatsExport = require('ajv-formats');
const Ajv2020 = (ajvExport.default ?? ajvExport) as new (opts: object) => AjvLike;
const addFormats = (formatsExport.default ?? formatsExport) as (ajv: AjvLike) => void;
/* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */

interface ValidateFn {
  (data: unknown): boolean;
  errors?: { instancePath: string; message?: string }[] | null;
}

interface AjvLike {
  addSchema(schema: unknown, key: string): void;
  compile(schema: unknown): ValidateFn;
}

// Ключ обязан выглядеть как URI с расширением: по голому `contract` ajv
// разбирает `contract#/components/...` как путь, а не как указатель.
const CONTRACT_ID = 'openapi.json';

/**
 * Контракт живёт вне `backend/`: в образе он появляется монтированием, локально —
 * соседней папкой. Путь переопределяется `OPENAPI_PATH`; отсутствие файла —
 * громкий отказ, а не тихий пропуск проверки.
 */
function contractPath(): string {
  const fromEnv = process.env['OPENAPI_PATH'];
  if (fromEnv) return fromEnv;
  const here = path.dirname(fileURLToPath(import.meta.url));
  // dist/test/support → backend/ → корень репозитория
  return path.resolve(here, '..', '..', '..', '..', 'openapi', 'openapi.yaml');
}

function loadContract(): Record<string, unknown> {
  const file = contractPath();
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    throw new Error(
      `Контракт не найден: ${file}. Проверка соответствия (A7) без него невозможна. ` +
        'Локально запускайте тесты из backend/, в контейнере смонтируйте openapi/ ' +
        'или задайте OPENAPI_PATH.',
    );
  }
  return parseYaml(text) as Record<string, unknown>;
}

export const contract = loadContract();

const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addSchema(contract, CONTRACT_ID);

const compiled = new Map<string, ValidateFn>();

function validatorFor(pointer: string): ValidateFn {
  let fn = compiled.get(pointer);
  if (!fn) {
    fn = ajv.compile({ $ref: `${CONTRACT_ID}#${pointer}` });
    compiled.set(pointer, fn);
  }
  return fn;
}

function pointerOf(ref: string): string {
  if (!ref.startsWith('#/')) throw new Error(`Неожиданный $ref в контракте: ${ref}`);
  return ref.slice(1);
}

function resolvePointer(pointer: string): Record<string, unknown> {
  let node: unknown = contract;
  for (const raw of pointer.split('/').slice(1)) {
    const token = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    node = (node as Record<string, unknown>)[token];
    if (node === undefined) throw new Error(`Контракт: не разрешается указатель ${pointer}`);
  }
  return node as Record<string, unknown>;
}

/** Указатель на схему ответа: путь → метод → статус → application/json. */
export function responseSchemaPointer(route: string, method: string, status: number): string {
  const paths = contract['paths'] as Record<string, Record<string, unknown>>;
  const operation = paths[route]?.[method.toLowerCase()] as Record<string, unknown> | undefined;
  if (!operation) throw new Error(`Контракт не описывает ${method} ${route}`);

  const responses = operation['responses'] as Record<string, Record<string, unknown>>;
  let response = responses[String(status)];
  if (!response) {
    throw new Error(`Контракт не описывает ответ ${status} у ${method} ${route}`);
  }
  if (typeof response['$ref'] === 'string') {
    response = resolvePointer(pointerOf(response['$ref']));
  }

  const content = response['content'] as Record<string, Record<string, unknown>> | undefined;
  const schema = content?.['application/json']?.['schema'] as Record<string, unknown> | undefined;
  if (!schema) throw new Error(`Контракт: у ответа ${status} ${method} ${route} нет схемы JSON`);
  if (typeof schema['$ref'] !== 'string') {
    // В нынешнем контракте все схемы ответов — ссылки. Встроенная схема означает,
    // что контракт изменился и помощник обязан сказать об этом, а не промолчать.
    throw new Error(`Схема ответа ${status} ${method} ${route} задана не ссылкой — обновите помощник`);
  }
  return pointerOf(schema['$ref']);
}

/**
 * Схема запроса — место, куда автоматическая сверка не доставала.
 *
 * A7 проверяет **ответы** против схем контракта, а валидация **запроса**
 * написана руками и с контрактом не сверялась ничем. Один дефект оттуда уже
 * вылез (#64: `maxLength` в JSON Schema — кодовые точки, а не единицы UTF-16),
 * и вылез не проверкой, а разговором. Здесь дыра закрывается: каждое тело,
 * отправленное тестами, прогоняется через схему контракта, и вердикт схемы
 * обязан совпасть с вердиктом сервера.
 */
/**
 * Тело любого ответа 4xx обязано быть конвертом `schemas/Error` с кодом
 * из перечня — включая маршруты, которых в контракте нет.
 *
 * До #94 сервис отвечал на чужой метод и чужой путь кодами вне перечня,
 * и это не ловилось ничем: сверка A7 привязана к описанным путям, а такие
 * ответы приходят там, где описанного пути нет по определению. Дыра нашлась
 * QA, а не прогоном — и закрывается здесь.
 */
export function assertErrorEnvelope(status: number, body: unknown, what: string): void {
  if (status < 400 || status >= 500) return;
  assertValidAgainst('/components/schemas/Error', body, `Ответ ${String(status)} на ${what}`);
}

export function requestBodyValid(body: unknown): boolean {
  return validatorFor('/components/schemas/PaymentCreateRequest')(body);
}

export function requestBodyErrors(body: unknown): string {
  const validate = validatorFor('/components/schemas/PaymentCreateRequest');
  validate(body);
  return (validate.errors ?? [])
    .map((e) => `${e.instancePath || '/'} — ${e.message ?? 'нарушение'}`)
    .join('; ');
}

/**
 * Вердикт схемы без исключения — для сверок, где интересен сам вердикт,
 * а не падение: сверка заголовков (#180) сравнивает «что говорит контракт»
 * с «что сделал сервер», и обе стороны обязаны быть данными, а не броском.
 */
export function matchesSchema(pointer: string, data: unknown): boolean {
  return validatorFor(pointer)(data);
}

/** Схема параметра контракта по его имени в `components/parameters`. */
export function parameterSchemaPointer(name: string): string {
  const parameters = (contract['components'] as Record<string, unknown>)['parameters'] as
    | Record<string, unknown>
    | undefined;
  if (!parameters?.[name]) {
    throw new Error(
      `Контракт не описывает параметр ${name}. Сверка заголовков без него ` +
        'проверяет пустоту — это отказ, а не пропуск.',
    );
  }
  return `/components/parameters/${name}/schema`;
}

export function assertValidAgainst(pointer: string, data: unknown, what: string): void {
  const validate = validatorFor(pointer);
  if (validate(data)) return;
  const details = (validate.errors ?? [])
    .map((e) => `  ${e.instancePath || '/'} — ${e.message ?? 'нарушение'}`)
    .join('\n');
  throw new Error(
    `${what} не соответствует контракту (${pointer}):\n${details}\n` +
      `Данные: ${JSON.stringify(data, null, 2)}`,
  );
}

/**
 * Главная проверка A7: тело ответа обязано соответствовать схеме,
 * объявленной контрактом для этого маршрута, метода и статуса.
 */
export function assertMatchesContract(
  route: string,
  method: string,
  status: number,
  body: unknown,
): void {
  const pointer = responseSchemaPointer(route, method, status);
  assertValidAgainst(pointer, body, `Ответ ${status} на ${method} ${route}`);
}
