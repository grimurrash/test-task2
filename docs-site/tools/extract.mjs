// Достаёт команды из собранной страницы сценариев — ровно в том виде, в каком
// их копирует читатель. Проверять надо то, что попало на страницу, а не
// исходник: между ними стоит сборка, и подставляет она в том числе адрес API.
//
//   node tools/extract.mjs        # читает dist/scenarios.html → dist/blocks.json

import { readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const outDir = resolve(here, '..', process.env.OUT ?? 'dist')

const html = await readFile(resolve(outDir, 'scenarios.html'), 'utf8')
const pattern = new RegExp('<pre><code[^>]*>([\\s\\S]*?)</code></pre>', 'g')
const unescape = (s) =>
  s
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&')

const blocks = [...html.matchAll(pattern)].map((m) => unescape(m[1]).trim())
await writeFile(resolve(outDir, 'blocks.json'), JSON.stringify(blocks, null, 1))

console.log(`блоков на странице: ${blocks.length}`)
