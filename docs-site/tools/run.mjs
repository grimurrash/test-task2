// Прогон блоков со страницы: подряд, в одной shell-сессии, чтобы переменные
// ($API, $KEY, $PAYMENT_ID) жили между шагами так же, как у читателя,
// копирующего команды по порядку. Сами команды не редактируются.
//
//   node tools/run.mjs first.txt
//   node tools/run.mjs second.txt
//   node tools/compare.mjs first.txt second.txt
//
// Два прогона — не перестраховка: пример, отвечающий во втором проходе не тем,
// что обещает страница, сломан, даже если в первом он зелёный. Один проход
// по свежему стенду этого не различает.

import { readFile, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const outDir = resolve(here, '..', process.env.OUT ?? 'dist')
const outName = process.argv[2] ?? 'run-output.txt'

const blocks = JSON.parse(await readFile(resolve(outDir, 'blocks.json'), 'utf8'))
const script = blocks.map((b, i) => `echo "===== БЛОК ${i} ====="\n${b}\necho`).join('\n')

const shell = spawn('bash', ['-c', script], { stdio: ['ignore', 'pipe', 'pipe'] })
let out = ''
shell.stdout.on('data', (d) => (out += d))
shell.stderr.on('data', (d) => (out += d))
shell.on('close', async (code) => {
  await writeFile(resolve(outDir, outName), out)
  console.log(`блоков выполнено: ${blocks.length}, код возврата shell: ${code}`)
})
