#!/bin/bash
# Шаг CI «analyse» — статическая проверка типов (tsc --noEmit).
set -euo pipefail
STACK="$(cat "$(dirname "$0")/../../.ci-stack" 2>/dev/null || echo none)"

if [ "$STACK" = "none" ]; then
  echo "ci/analyse: ПРОПУЩЕН — стек не выбран (.ci-stack = none)"
  exit 0
fi

if [ "$STACK" != "node" ]; then
  echo "ci/analyse: стек $STACK, но команда не прописана в scripts/ci/analyse.sh"
  echo "Допишите команду — шаг обязан либо проверять, либо явно объявлять себя пропущенным."
  exit 1
fi

# shellcheck source=scripts/ci/node-env.sh
source "$(dirname "$0")/node-env.sh"

echo "ci/analyse: tsc --noEmit в backend/"
cd "$BACKEND_DIR"
npm run typecheck
