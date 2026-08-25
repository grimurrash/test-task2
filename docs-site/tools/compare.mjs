// Сравнивает два прогона поблочно: коды ответов и коды ошибок. Машинно,
// а не глазами — глаз сверяет то, куда смотрит, а смотрит он туда, где ждёт
// разницу.
//
//   node tools/compare.mjs first.txt second.txt

import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const outDir = resolve(here, '..', process.env.OUT ?? 'dist')
const [a, b] = process.argv.slice(2, 4)

if (!a || !b) {
  console.error('нужно два файла: node tools/compare.mjs first.txt second.txt')
  process.exit(2)
}

async function parse(name) {
  const text = await readFile(resolve(outDir, name), 'utf8')
  const parts = text.split(new RegExp('===== БЛОК (\\d+) ====='))
  const result = new Map()
  for (let i = 1; i < parts.length; i += 2) {
    const body = parts[i + 1] ?? ''
    const statuses = [...body.matchAll(/HTTP\/1\.1 (\d{3})/g)].map((m) => m[1])
    const codes = [...body.matchAll(/"code":"([a-z_]+)"/g)].map((m) => m[1])
    result.set(Number(parts[i]), `${statuses.join('/') || '—'} ${codes.join('/')}`.trim())
  }
  return result
}

const first = await parse(a)
const second = await parse(b)

const diffs = []
for (const [n, value] of first) {
  if (second.get(n) !== value) diffs.push([n, value, second.get(n) ?? '(нет блока)'])
}

console.log(`блоков сравнено: ${first.size}`)
if (diffs.length === 0) {
  console.log('расхождений между проходами: нет')
} else {
  for (const [n, x, y] of diffs) console.log(`  блок ${n}: первый «${x}» · второй «${y}»`)
  process.exit(1)
}
