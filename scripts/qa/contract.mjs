// Проверка тела ответа против openapi/openapi.yaml — тем же способом, каким
// это делает набор бэкенда (backend/test/support/contract.ts), но снаружи.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
// scripts/qa → scripts → корень репозитория
const root = path.resolve(here, '..', '..');
const require = createRequire(path.join(root, 'backend', 'package.json'));
const { parse: parseYaml } = require('yaml');
const ajvExport = require('ajv/dist/2020.js');
const formatsExport = require('ajv-formats');
const Ajv2020 = ajvExport.default ?? ajvExport;
const addFormats = formatsExport.default ?? formatsExport;

export const contract = parseYaml(readFileSync(path.join(root, 'openapi', 'openapi.yaml'), 'utf8'));

const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addSchema(contract, 'openapi.json');

const cache = new Map();
function validatorFor(pointer) {
  if (!cache.has(pointer)) cache.set(pointer, ajv.compile({ $ref: `openapi.json#${pointer}` }));
  return cache.get(pointer);
}

/** Возвращает список нарушений схемы (пустой — тело соответствует контракту). */
export function violations(pointer, data) {
  const fn = validatorFor(pointer);
  if (fn(data)) return [];
  return (fn.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message}`);
}

export const ERROR_CODES = contract.components.schemas.ErrorCode.enum;
