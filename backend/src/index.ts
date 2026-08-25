/** Точка входа. Порт — 8080, переопределяется переменной PORT (R2). */
import { createServer } from './app.js';

const port = Number(process.env['PORT'] ?? 8080);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error(`PORT задан неверно: ${String(process.env['PORT'])}`);
  process.exit(1);
}

const server = createServer();

server.listen(port, () => {
  console.log(`Платёжный сервис слушает http://0.0.0.0:${port}`);
});

// Данные живут в памяти (R6): остановка обнуляет состояние, и это ожидаемое
// поведение песочницы, а не потеря.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
