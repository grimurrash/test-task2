// Локальная раздача собранной статики — для проверки страницы без Docker.
// В образе статику раздаёт nginx (см. Dockerfile), этот сервер в него не едет.

import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import { dirname, extname, join, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, process.env.OUT ?? 'dist')
const port = Number(process.env.PORT ?? 8082)

const types = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.yaml': 'application/yaml; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
}

createServer(async (req, res) => {
  const requested = decodeURIComponent(new URL(req.url, 'http://localhost').pathname)

  // То же, что делает nginx в образе: облачные функции Scalar выключены,
  // их путь гасим пустым ответом, а не 404 в консоли.
  if (requested.startsWith('/vector/')) {
    res.writeHead(204).end()
    return
  }

  const relative = normalize(requested).replace(/^(\.\.[/\\])+/, '')
  let file = join(root, relative)

  try {
    const info = await stat(file)
    if (info.isDirectory()) file = join(file, 'index.html')
  } catch {
    res.writeHead(404, { 'Content-Type': types['.html'] })
    res.end('<h1>404</h1>')
    return
  }

  res.writeHead(200, { 'Content-Type': types[extname(file)] ?? 'application/octet-stream' })
  createReadStream(file).pipe(res)
}).listen(port, () => {
  console.log(`Документация: http://localhost:${port}`)
})
