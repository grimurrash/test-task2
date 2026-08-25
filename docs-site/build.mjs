// Сборка страницы документации из контракта.
//
// Страница не пишется руками: единственный источник текста — openapi.yaml.
// Скрипт читает контракт, сверяет его полноту, кладёт рядом со статикой и
// генерирует HTML, который рендерит его в браузере. Контракт поменялся —
// достаточно пересобрать.

import { access, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'
import { marked } from 'marked'

const here = dirname(fileURLToPath(import.meta.url))

// Путь к контракту переопределяется переменной SPEC: в образе он лежит не там,
// где в рабочей копии.
const specPath = process.env.SPEC
  ? resolve(process.env.SPEC)
  : resolve(here, '..', 'openapi', 'openapi.yaml')
const outDir = resolve(here, process.env.OUT ?? 'dist')
// Токены дизайна (задача #10) — общий файл песочницы и документации. Пока
// он не слит в main, страница живёт на нейтральном дефолте из theme.css;
// как только файл появится, сборка подхватит его сама.
const tokensPath = process.env.TOKENS
  ? resolve(process.env.TOKENS)
  : resolve(here, '..', 'design', 'tokens.css')
const scalarBundle = resolve(
  here,
  'node_modules/@scalar/api-reference/dist/browser/standalone.js',
)

// Операции контракта — метод, путь, operationId.
function operationsOf(spec) {
  const methods = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options']
  const found = []
  for (const [path, item] of Object.entries(spec.paths ?? {})) {
    for (const method of methods) {
      if (item?.[method]) {
        found.push({ method: method.toUpperCase(), path, id: item[method].operationId })
      }
    }
  }
  return found
}

// Сверка полноты. Приёмка требует, чтобы на странице были все эндпоинты и все
// коды ошибок контракта. Рендерит их браузер, поэтому проверяем то, что едет
// в браузер: сам документ. Расхождение — не предупреждение, а падение сборки.
function checkContract(spec, raw) {
  const problems = []

  const operations = operationsOf(spec)
  if (operations.length === 0) problems.push('в контракте не найдено ни одной операции')
  for (const op of operations) {
    if (!op.id) problems.push(`${op.method} ${op.path}: нет operationId`)
  }

  const codes = spec.components?.schemas?.ErrorCode?.enum ?? []
  if (codes.length === 0) problems.push('в контракте не найден перечень ErrorCode')
  for (const code of codes) {
    // Код должен не только числиться в перечне, но и быть объяснён в тексте
    // документа — иначе интегратор увидит имя без условия срабатывания.
    const mentions = raw.split(code).length - 1
    if (mentions < 2) problems.push(`код ${code} упомянут только в перечне ErrorCode`)
  }

  if (!spec.info?.description) problems.push('в контракте нет info.description')

  if (problems.length > 0) {
    throw new Error(`контракт не прошёл сверку:\n  - ${problems.join('\n  - ')}`)
  }

  return { operations, codes }
}

const layout = ({ title, nav, body, wide = false }) => `<!doctype html>
<html lang="ru">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title}</title>
    <link rel="stylesheet" href="./tokens.css" />
    <link rel="stylesheet" href="./page.css" />
    <link rel="stylesheet" href="./theme.css" />
  </head>
  <body${wide ? ' class="wide"' : ''}>
    <header class="site-header">
      <span class="site-title">Идемпотентный платёжный сервис</span>
      <nav>${nav}</nav>
    </header>
${body}
  </body>
</html>
`

const referencePage = () =>
  layout({
    title: 'Документация API — идемпотентный платёжный сервис',
    nav: `
        <a href="./index.html" class="current">Справочник API</a>
        <a href="./scenarios.html">Сценарии curl</a>
      `,
    wide: true,
    body: `    <div id="scalar"></div>
    <script src="./standalone.js"></script>
    <script>
      Scalar.createApiReference('#scalar', {
        url: './openapi.yaml',
        // Интерфейс по-русски: контракт написан по-русски, смешение языков
        // в подписях полей читателю ничего не даёт.
        localization: { locale: 'ru' },
        // Страница обязана работать без интернета: у проверяющего есть только
        // Docker. Всё, что стучится наружу, выключено — панель разработчика
        // Scalar (Deploy/Share), телеметрия, интеграция MCP.
        showDeveloperTools: 'never',
        telemetry: false,
        mcp: { disabled: true },
        // «Open API Client» уводит в облачный клиент Scalar и передаёт туда
        // адрес localhost, до которого тот не достучится. Кнопка «Test Request»
        // рядом с операцией остаётся — она шлёт запрос из браузера, локально.
        hideClientButton: true,
        documentDownloadType: 'yaml',
        // Шрифты Scalar лежат на его CDN — берём системные, они уже заданы
        // в theme.css.
        withDefaultFonts: false,
        // Поиск по документу подтягивает подсказки с api.scalar.com. База
        // переставлена на свой же хост: наружу запрос не уходит, локальный
        // поиск по странице работает.
        externalUrls: { apiBaseUrl: '' },
      })
    </script>`,
  })

const scenariosPage = (html) =>
  layout({
    title: 'Сценарии curl — идемпотентный платёжный сервис',
    nav: `
        <a href="./index.html">Справочник API</a>
        <a href="./scenarios.html" class="current">Сценарии curl</a>
      `,
    body: `    <main class="prose">
${html}
    </main>`,
  })

async function build() {
  const raw = await readFile(specPath, 'utf8')
  const spec = parse(raw)
  const { operations, codes } = checkContract(spec, raw)

  await rm(outDir, { recursive: true, force: true })
  await mkdir(outDir, { recursive: true })

  // Контракт едет на страницу как есть — страница читает тот же файл, который
  // читает бэкенд. Ни строчки текста по дороге не переписывается.
  await writeFile(resolve(outDir, 'openapi.yaml'), raw)
  await cp(scalarBundle, resolve(outDir, 'standalone.js'))
  await cp(resolve(here, 'src', 'page.css'), resolve(outDir, 'page.css'))
  await cp(resolve(here, 'src', 'theme.css'), resolve(outDir, 'theme.css'))

  // Токены дизайна копируются как есть, значения не переписываются: у песочницы
  // и документации обязан быть один источник цвета и шрифтов, иначе проверяющий
  // прочтёт две страницы как две разные системы.
  const tokens = await access(tokensPath).then(
    () => true,
    () => false,
  )
  if (tokens) {
    await cp(tokensPath, resolve(outDir, 'tokens.css'))
  } else {
    await writeFile(
      resolve(outDir, 'tokens.css'),
      '/* Токены дизайна (design/tokens.css) не найдены — страница собрана\n' +
        '   на нейтральном дефолте из theme.css. */\n',
    )
  }

  await writeFile(resolve(outDir, 'index.html'), referencePage())

  const scenarios = await readFile(resolve(here, 'src', 'scenarios.md'), 'utf8')
  await writeFile(
    resolve(outDir, 'scenarios.html'),
    scenariosPage(marked.parse(scenarios, { async: false })),
  )

  console.log(`Контракт: ${specPath}`)
  console.log(
    `Операций: ${operations.length} — ${operations.map((o) => `${o.method} ${o.path}`).join(', ')}`,
  )
  console.log(`Кодов ошибок: ${codes.length} — ${codes.join(', ')}`)
  console.log(
    tokens ? `Токены дизайна: ${tokensPath}` : 'Токены дизайна: не найдены, взят дефолт',
  )
  console.log(`Собрано в: ${outDir}`)
}

await build()
