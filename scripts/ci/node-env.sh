#!/bin/bash
# Общая подготовка шагов CI для стека node. Подключается через `source`.
#
# Шаг обязан либо проверять, либо явно объявлять себя пропущенным. Поэтому
# несовпадение версии Node здесь — отказ с названной причиной и названной
# починкой, а не тихий пропуск и не SyntaxError из глубины зависимостей.
set -euo pipefail

CI_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BACKEND_DIR="$CI_ROOT/backend"
REQUIRED_MAJOR=22

if [ ! -d "$BACKEND_DIR" ]; then
  echo "ci: каталог backend/ не найден — проверять нечего"
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "ci: Node не установлен, а .ci-stack объявляет стек node."
  echo "Починка: добавьте в .github/workflows/ci.yml шаг"
  echo "  - uses: actions/setup-node@v4"
  echo "    with: { node-version: '$REQUIRED_MAJOR' }"
  exit 1
fi

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt "$REQUIRED_MAJOR" ]; then
  echo "ci: нужен Node $REQUIRED_MAJOR или новее, найден $(node --version)."
  echo "Починка: добавьте в .github/workflows/ci.yml шаг"
  echo "  - uses: actions/setup-node@v4"
  echo "    with: { node-version: '$REQUIRED_MAJOR' }"
  exit 1
fi

# Зависимости ставятся один раз на джоб: три шага подряд не тратят на это время.
if [ ! -d "$BACKEND_DIR/node_modules" ]; then
  echo "ci: устанавливаю зависимости backend/ (npm ci)"
  (cd "$BACKEND_DIR" && npm ci --no-audit --no-fund)
fi
