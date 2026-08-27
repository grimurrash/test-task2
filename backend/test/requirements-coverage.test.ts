/**
 * A4 — «все границы из раздела 5 покрыты тестами» становится проверкой.
 *
 * До задачи #180 это было утверждение: ни один прогон не падал, если
 * требование оставалось без теста. По правилу самого проекта — правило без
 * механизма проигрывает первому же тексту, который окажется убедительнее.
 *
 * Устройство сверки:
 *
 *   перечень — из `docs/product/PRD.md`, раздел 5. Руками он нигде не выписан,
 *     поэтому новое требование попадает в него само и само же ломает прогон,
 *     если за ним ничего не стоит;
 *   привязка — пометка `@req <ID>`, с которой **начинается имя теста**.
 *     Именно имя, а не комментарий: упоминание — не использование, и пометка
 *     в комментарии засчитывала бы тест, которого нет;
 *   обоснование — строка в `docs/product/requirements-coverage.md` для
 *     требований о доставке, которые честным тестом прогона не проверяются.
 *     Слабость названа, а не спрятана за пометкой на тесте-декорации.
 *
 * Третий исход обязателен (REPORT 4.14, задача #127): «проверять было нечего»
 * здесь всегда отказ, а не зелёный. Не нашёлся корень репозитория, пуст
 * каталог тестов, разобрался пустой перечень — падение с названной причиной.
 *
 * Известная граница метода: пометкой считается строковый литерал, начинающийся
 * с `@req`. Строка-константа такого вида вне имени теста засчиталась бы —
 * цена того, что разбор идёт по тексту, а не по прогону. Прогон бы этого
 * не дал: `node --test` запускает каждый файл своим процессом, и общего
 * реестра между файлами не существует, а фронтовые тесты идут вообще другим
 * прогонщиком.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

/** Корень репозитория: в контейнере — из окружения, локально — подъёмом. */
function repoRoot(): string {
  const fromEnv = process.env['REPO_ROOT'];
  if (fromEnv !== undefined && fromEnv !== '') {
    assert.ok(
      existsSync(path.join(fromEnv, 'docs', 'product', 'PRD.md')),
      `REPO_ROOT=${fromEnv}, но PRD там нет. Сверка покрытия без требований ` +
        'проверяет пустоту — это отказ, а не пропуск.',
    );
    return fromEnv;
  }
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i += 1) {
    if (existsSync(path.join(dir, 'docs', 'product', 'PRD.md'))) return dir;
    dir = path.dirname(dir);
  }
  throw new Error(
    'Корень репозитория не найден: нет docs/product/PRD.md ни в одном родителе. ' +
      'В контейнере смонтируйте репозиторий и задайте REPO_ROOT — сверка ' +
      'покрытия обязана падать, а не пропускаться.',
  );
}

const ROOT = repoRoot();

/** Идентификатор требования: буква раздела, номер, необязательный подпункт. */
const REQUIREMENT = /^([FURD])(\d{1,2})([a-z]?)$/;
/** Похоже на идентификатор — чтобы неразобранное падало громко, а не тихо. */
const LOOKS_LIKE_REQUIREMENT = /^[A-Za-z]{1,2}\d/;

interface Registry {
  ids: string[];
  unparsed: string[];
}

/** Перечень требований раздела 5 PRD — закрытый и разобранный, а не список имён. */
function registry(): Registry {
  const text = readFileSync(path.join(ROOT, 'docs', 'product', 'PRD.md'), 'utf8');
  const lines = text.split('\n');
  const from = lines.findIndex((line) => line.startsWith('## 5. '));
  const to = lines.findIndex((line) => line.startsWith('## 6. '));
  assert.ok(from >= 0 && to > from, 'в PRD не найден раздел 5 — перечень брать неоткуда');

  const ids: string[] = [];
  const unparsed: string[] = [];
  for (const line of lines.slice(from, to)) {
    if (!line.startsWith('|')) continue;
    const cell = line.split('|')[1]?.trim() ?? '';
    if (REQUIREMENT.test(cell)) ids.push(cell);
    else if (LOOKS_LIKE_REQUIREMENT.test(cell)) unparsed.push(cell);
  }
  return { ids, unparsed };
}

const REGISTRY = registry();

interface Marker {
  id: string;
  file: string;
}

const TEST_DIRS = [
  path.join(ROOT, 'backend', 'test'),
  path.join(ROOT, 'frontend', 'src', 'test'),
];

function testFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...testFiles(full));
    else if (/\.tsx?$/.test(entry.name)) found.push(full);
  }
  return found;
}

/** Строковые литералы файла — одинарные, двойные и обратные кавычки. */
const LITERAL = /'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g;
/** Пропущенный тест: пометка в нём засчитывалась бы за проверку, которой нет. */
const SKIPPED = /\b(?:describe|it|test)\.(?:skip|todo)\s*(?:\(|<)/g;

function markersIn(file: string): { markers: string[]; skippedWithMarker: boolean } {
  const source = readFileSync(file, 'utf8');
  const markers: string[] = [];

  for (const match of source.matchAll(LITERAL)) {
    const literal = match[1] ?? match[2] ?? match[3] ?? '';
    // Пометка открывает имя теста. Так упоминание в прозе не превращается
    // в покрытие: комментарий строковым литералом не является, а литерал,
    // начинающийся с `@req`, — это имя.
    if (!literal.startsWith('@req')) continue;
    for (const found of literal.matchAll(/@req\s+([A-Za-z]\d{1,2}[a-z]?)/g)) {
      markers.push(found[1] ?? '');
    }
  }

  let skippedWithMarker = false;
  for (const skip of source.matchAll(SKIPPED)) {
    const tail = source.slice(skip.index, skip.index + 400);
    if (tail.includes('@req')) skippedWithMarker = true;
  }

  return { markers, skippedWithMarker };
}

function collectMarkers(): { all: Marker[]; skipped: string[]; byArea: Map<string, Set<string>> } {
  const all: Marker[] = [];
  const skipped: string[] = [];
  const byArea = new Map<string, Set<string>>();
  const self = fileURLToPath(import.meta.url).replace(/dist[\\/]/, '').replace(/\.js$/, '.ts');

  for (const dir of TEST_DIRS) {
    assert.ok(existsSync(dir), `каталог тестов не найден: ${dir}`);
    const files = testFiles(dir);
    assert.ok(files.length > 0, `каталог тестов пуст: ${dir} — сверять нечего`);
    const area = dir.includes('frontend') ? 'frontend' : 'backend';

    for (const file of files) {
      // Сам файл сверки исключён: пометки в его собственном тексте
      // засчитывали бы требования за упоминание в описании механизма.
      if (path.resolve(file) === path.resolve(self)) continue;
      const { markers, skippedWithMarker } = markersIn(file);
      if (skippedWithMarker) skipped.push(path.relative(ROOT, file));
      for (const id of markers) {
        all.push({ id, file: path.relative(ROOT, file) });
        const set = byArea.get(area) ?? new Set<string>();
        set.add(id);
        byArea.set(area, set);
      }
    }
  }
  return { all, skipped, byArea };
}

const MARKERS = collectMarkers();

interface Waiver {
  id: string;
  proof: string;
  why: string;
}

/** Обоснования: требование, чем подтверждается, почему не тестом прогона. */
function waivers(): Waiver[] {
  const file = path.join(ROOT, 'docs', 'product', 'requirements-coverage.md');
  assert.ok(
    existsSync(file),
    `нет файла обоснований ${file}. Без него требования о доставке остались бы ` +
      'без объяснения — а сверка обязана видеть обе половины покрытия.',
  );
  const found: Waiver[] = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.startsWith('|')) continue;
    const cells = line.split('|').map((c) => c.trim());
    const id = cells[1] ?? '';
    if (!REQUIREMENT.test(id)) continue;
    found.push({ id, proof: cells[2] ?? '', why: cells[3] ?? '' });
  }
  return found;
}

const WAIVERS = waivers();

describe('@req A4 сверка покрытия · перечень требований разобран', () => {
  it('раздел 5 PRD дал непустой перечень', () => {
    assert.ok(
      REGISTRY.ids.length >= 43,
      `требований разобрано ${String(REGISTRY.ids.length)}, а в PRD их не меньше 43. ` +
        'Скорее всего сломался разбор таблиц, и сверка проверяет пустоту.',
    );
  });

  it('ни одна ячейка, похожая на идентификатор, не осталась неразобранной', () => {
    assert.deepEqual(
      REGISTRY.unparsed,
      [],
      'Эти ячейки раздела 5 выглядят требованиями, но не разобраны. Пока они ' +
        'не разобраны, требование проходит мимо сверки молча — а это ровно та ' +
        'дыра, которую сверка закрывает.',
    );
  });

  it('ряд идентификаторов сплошной: пропущенного номера нет', () => {
    const gaps: string[] = [];
    for (const letter of ['F', 'U', 'D', 'R']) {
      const numbers = REGISTRY.ids
        .filter((id) => id.startsWith(letter))
        .map((id) => Number(REQUIREMENT.exec(id)?.[2] ?? '0'));
      const max = Math.max(...numbers);
      for (let n = 1; n <= max; n += 1) {
        if (!numbers.includes(n)) gaps.push(`${letter}${String(n)}`);
      }
    }
    assert.deepEqual(gaps, [], 'в ряду требований пропущен номер — раздел перекроили');
  });
});

describe('@req A4 сверка покрытия · у каждого требования есть тест или обоснование', () => {
  const marked = new Set(MARKERS.all.map((m) => m.id));
  const waived = new Set(WAIVERS.map((w) => w.id));

  it('требований без теста и без обоснования нет', () => {
    const orphans = REGISTRY.ids.filter((id) => !marked.has(id) && !waived.has(id));
    assert.deepEqual(
      orphans,
      [],
      'У этих требований раздела 5 нет ни теста с пометкой `@req <ID>` в имени, ' +
        'ни строки в docs/product/requirements-coverage.md. Требование без ' +
        'проверки — это утверждение.',
    );
  });

  it('пометок на несуществующие требования нет', () => {
    const stale = MARKERS.all.filter((m) => !REGISTRY.ids.includes(m.id));
    assert.deepEqual(
      stale.map((m) => `${m.id} (${m.file})`),
      [],
      'Пометка ссылается на требование, которого в PRD нет: привязка устарела ' +
        'или в идентификаторе опечатка. Молча такая пометка выглядит покрытием.',
    );
  });

  it('обоснований на несуществующие требования нет', () => {
    const stale = WAIVERS.filter((w) => !REGISTRY.ids.includes(w.id)).map((w) => w.id);
    assert.deepEqual(stale, [], 'обоснование ссылается на требование вне PRD');
  });

  it('требование не может быть одновременно покрыто тестом и обосновано', () => {
    const both = WAIVERS.filter((w) => marked.has(w.id)).map((w) => w.id);
    assert.deepEqual(
      both,
      [],
      'У требования есть тест — значит строка обоснования устарела и прячет ' +
        'настоящую проверку за объяснением, почему её нет.',
    );
  });

  it('у каждого обоснования названы и механизм, и причина', () => {
    const empty = WAIVERS.filter((w) => w.proof.length < 10 || w.why.length < 10).map((w) => w.id);
    assert.deepEqual(
      empty,
      [],
      'Обоснование без механизма или без причины — это освобождение, а не ' +
        'заявление. Пустая клетка проходит глазами и не проходит здесь.',
    );
  });

  it('пометок в пропущенных тестах нет', () => {
    assert.deepEqual(
      MARKERS.skipped,
      [],
      '`describe.skip` / `it.todo` с пометкой засчитывал бы за покрытие тест, ' +
        'который не выполняется.',
    );
  });
});

describe('@req A4 сверка покрытия · пометка означает исполняемый тест', () => {
  it('требования, закрытые только фронтом, действительно гоняются в CI', () => {
    const backend = MARKERS.byArea.get('backend') ?? new Set<string>();
    const frontend = MARKERS.byArea.get('frontend') ?? new Set<string>();
    const frontendOnly = [...frontend].filter((id) => !backend.has(id));
    if (frontendOnly.length === 0) return;

    const ci = readFileSync(path.join(ROOT, 'scripts', 'ci', 'test.sh'), 'utf8');
    assert.ok(
      ci.includes('frontend'),
      `Требования ${frontendOnly.join(', ')} закрыты только фронтовыми тестами, ` +
        'а шаг CI их не запускает. Тогда зелёный прогон утверждает покрытие ' +
        'тестами, которых не выполнял, — то есть сверка врёт.',
    );
  });
});
