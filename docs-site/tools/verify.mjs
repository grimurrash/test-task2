// Сверяет прогон с тем, что обещает страница, и проходы между собой.
//
//   node tools/verify.mjs first.txt second.txt
//
// Две проверки, и они разные:
//
//   соответствие — ответ совпал с кодом, названным в тексте перед блоком;
//   устойчивость — второй проход ответил тем же, что первый.
//
// Прежняя версия умела только вторую, и это была дыра ровно того класса,
// который она ловит у примеров: прибитый ключ отвечает 200 в обоих проходах,
// проходы совпадают, инструмент молчит — а страница обещала 201. Соответствие
// проверяется первым проходом, устойчивость — вторым; поодиночке они
// не заменяют друг друга.

import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const outDir = resolve(here, '..', process.env.OUT ?? 'dist')
const [firstName, secondName] = process.argv.slice(2, 4)

if (!firstName) {
  console.error('нужен хотя бы один прогон: node tools/verify.mjs first.txt [second.txt]')
  process.exit(2)
}

async function statusesOf(name) {
  const text = await readFile(resolve(outDir, name), 'utf8')
  const parts = text.split(/===== БЛОК (\d+) =====/)
  const result = new Map()
  for (let i = 1; i < parts.length; i += 2) {
    const body = parts[i + 1] ?? ''
    result.set(Number(parts[i]), [...body.matchAll(/HTTP\/1\.1 (\d{3})/g)].map((m) => m[1]))
  }
  return result
}

const blocks = JSON.parse(await readFile(resolve(outDir, 'blocks.json'), 'utf8'))
const first = await statusesOf(firstName)
const second = secondName ? await statusesOf(secondName) : null

const problems = []
let checkedPromise = 0

blocks.forEach((block, n) => {
  const got = first.get(n) ?? []

  // Соответствие обещанию. Проверяются только блоки, у которых текст перед
  // ними назвал код и у которых вообще есть ответ: блоки подготовки
  // и присваивания переменных ничего не обещают.
  if (block.promised.length > 0 && got.length > 0) {
    checkedPromise += 1
    const unmet = block.promised.filter((code) => !got.includes(code))
    const extra = got.filter((code) => !block.promised.includes(code))
    if (unmet.length > 0 || extra.length > 0) {
      problems.push(
        `блок ${n}: страница обещает ${block.promised.join('/')}, ` +
          `пришло ${got.join('/') || '—'}`,
      )
    }
  }

  if (second) {
    const again = second.get(n) ?? []
    if (got.join('/') !== again.join('/')) {
      problems.push(
        `блок ${n}: первый проход ${got.join('/') || '—'}, второй ${again.join('/') || '—'}`,
      )
    }
  }
})

console.log(`блоков: ${blocks.length}, сверено с обещанием: ${checkedPromise}`)
console.log(second ? 'проходов сравнено: 2' : 'проходов сравнено: 1 (устойчивость не проверялась)')

if (problems.length === 0) {
  console.log('расхождений нет')
} else {
  for (const p of problems) console.log(`  ${p}`)
  process.exit(1)
}
