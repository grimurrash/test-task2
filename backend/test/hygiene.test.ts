/**
 * Гигиена набора: собственный HTTP-клиент в тесте — объявленное исключение,
 * а не привычка.
 *
 * Обвязка `test/support` сверяет каждый ответ с контрактом (A7), тела запросов
 * со схемой запроса, а тела ошибок — со `schemas/Error`. Всё это работает,
 * пока запрос идёт **через неё**. Тест, поднявший свой сокет, проходит мимо
 * всех проверок разом — и мимо тихо, потому что выглядит как обычный тест.
 *
 * Сырой клиент иногда нужен по существу: дубль заголовка (#73) и не-ASCII
 * значение (#75) через `fetch` не отправить. Поэтому не запрет, а объявление:
 * файл называет себя маркером в шапке, и список объявивших остаётся коротким
 * и на виду. Та же форма, что у маркера сканера инъекций.
 *
 * Проверка ловит обход **до запуска** — по тексту файла, а не по поведению.
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const MARKER = 'raw-http-client: allowed';

/** Признаки того, что файл разговаривает с сервером в обход обвязки. */
const RAW_CLIENT_SIGNS: [RegExp, string][] = [
  [/\bnet\.connect\s*\(/, 'net.connect'],
  [/\bnew net\.Socket\b/, 'new net.Socket'],
  [/\bhttp\.request\s*\(/, 'http.request'],
  [/\bhttps\.request\s*\(/, 'https.request'],
  [/\bfetch\s*\(/, 'fetch'],
];

/** Исходники тестов, а не собранные: проверяем то, что читает человек. */
function testSourceDir(): string {
  // dist/test/hygiene.test.js → backend/ → backend/test
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', '..', 'test');
}

function testFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...testFiles(full));
    else if (entry.name.endsWith('.ts')) found.push(full);
  }
  return found;
}

describe('Гигиена набора · сырой HTTP-клиент объявляется', () => {
  const root = testSourceDir();
  const files = testFiles(root).filter((file) => !file.includes(`${path.sep}support${path.sep}`));

  it('файлы тестов найдены — проверка не холостая', () => {
    assert.ok(files.length >= 5, `найдено файлов: ${String(files.length)}, ожидалось больше`);
  });

  for (const file of files) {
    const name = path.relative(root, file);

    it(`${name} — либо ходит через обвязку, либо объявляет сырой клиент`, () => {
      const source = readFileSync(file, 'utf8');
      const used = RAW_CLIENT_SIGNS.filter(([pattern]) => pattern.test(source)).map(([, label]) => label);
      if (used.length === 0) return;

      assert.ok(
        source.slice(0, 2048).includes(MARKER),
        `${name} поднимает собственного клиента (${used.join(', ')}) и проходит мимо всех сверок обвязки.\n` +
          `Если это нужно по существу — объявите файл строкой «${MARKER} — причина» в первых 2 КБ.\n` +
          'Если нет — ходите через test/support/harness.ts, там сверки встроены.',
      );
    });
  }

  it('объявивших сырой клиент — единицы, и они на виду', () => {
    const declared = files
      .filter((file) => readFileSync(file, 'utf8').slice(0, 2048).includes(MARKER))
      .map((file) => path.relative(root, file));

    assert.ok(
      declared.length <= 3,
      `файлов с собственным клиентом стало ${String(declared.length)}: ${declared.join(', ')}. ` +
        'Список обязан оставаться коротким — иначе объявление превращается в формальность.',
    );
  });
});
