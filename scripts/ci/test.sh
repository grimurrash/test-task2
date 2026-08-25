#!/bin/bash
# Шаг CI «test» — тесты бэкенда, включая проверку ответов против openapi.yaml
# и тест на две одновременные отправки.
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
cd "$BACKEND_DIR"
npm test
