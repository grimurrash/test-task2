#!/bin/bash
# Шаг CI «test» — тесты бэкенда и песочницы.
#
# Бэкенд: проверка ответов против openapi.yaml, сверка заголовков с контрактом,
# тест на две одновременные отправки, сверка покрытия требований (A4).
#
# Песочница добавлена задачей #180, и вот почему. Сверка покрытия засчитывает
# требованию тест по пометке `@req <ID>` в его имени, а требования U1–U7
# проверяет фронт. Пока CI гонял только бэкенд, зелёный прогон утверждал
# покрытие тестами, которых не запускал, — то есть механизм A4 был бы
# декларацией. Сама сверка это и ловит: без строки про frontend ниже она
# краснеет и называет требования, оставшиеся неподтверждёнными.
set -euo pipefail
STACK="$(cat "$(dirname "$0")/../../.ci-stack" 2>/dev/null || echo none)"

if [ "$STACK" = "none" ]; then
  echo "ci/test: ПРОПУЩЕН — стек не выбран (.ci-stack = none)"
  exit 0
fi

if [ "$STACK" != "node" ]; then
  echo "ci/test: стек $STACK, но команда не прописана в scripts/ci/test.sh"
  echo "Допишите команду — шаг обязан либо проверять, либо явно объявлять себя пропущенным."
  exit 1
fi

# shellcheck source=scripts/ci/node-env.sh
source "$(dirname "$0")/node-env.sh"

echo "ci/test: npm test в backend/ ($(node --version))"
(cd "$BACKEND_DIR" && npm test)

FRONTEND_DIR="$CI_ROOT/frontend"
if [ ! -d "$FRONTEND_DIR" ]; then
  echo "ci/test: каталог frontend/ не найден, а требования U1–U7 проверяет он."
  echo "Шаг обязан либо проверять, либо явно объявлять себя пропущенным."
  exit 1
fi

if [ ! -d "$FRONTEND_DIR/node_modules" ]; then
  echo "ci/test: устанавливаю зависимости frontend/ (npm ci)"
  (cd "$FRONTEND_DIR" && npm ci --no-audit --no-fund)
fi

echo "ci/test: npm test во frontend/"
(cd "$FRONTEND_DIR" && npm test)
