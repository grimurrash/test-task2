// Достаёт команды из собранной страницы сценариев — ровно в том виде, в каком
// их копирует читатель, — и вместе с ними **обещание страницы**: код ответа,
// помеченный в самом блоке строкой вида `# ожидается 201`.
//
//   node tools/extract.mjs        # dist/scenarios.html → dist/blocks.json
//
// Почему пометка в блоке, а не разбор текста вокруг. Текст рядом с блоком
// упоминает и соседние коды, и числа вроде «255 символов»: угадывание по нему
// даёт ложные срабатывания, а инструмент, который кричит по пустякам, быстро
// перестаёт что-либо значить. Пометка живёт в том же блоке, который читает
// человек, поэтому вторым источником правды не становится — расходиться ей
// не с чем.

import { readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const outDir = resolve(here, '..', process.env.OUT ?? 'dist')

const html = await readFile(resolve(outDir, 'scenarios.html'), 'utf8')

const unescape = (s) =>
  s
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&')

const pattern = /<pre><code[^>]*>([\s\S]*?)<\/code><\/pre>/g
const blocks = [...html.matchAll(pattern)].map((m) => {
  const code = unescape(m[1]).trim()
  // «# ожидается 201» или «# ожидается 404, 405» — один или несколько кодов.
  const promised = [...code.matchAll(/#\s*ожидается\s+([\d,\s]+)/g)].flatMap((hit) =>
    hit[1].split(/[\s,]+/).filter(Boolean),
  )
  return { code, promised }
})

await writeFile(resolve(outDir, 'blocks.json'), JSON.stringify(blocks, null, 1))

const withPromise = blocks.filter((b) => b.promised.length > 0).length
console.log(`блоков на странице: ${blocks.length}, из них с пометкой ожидания: ${withPromise}`)
