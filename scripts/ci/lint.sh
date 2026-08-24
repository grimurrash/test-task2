#!/bin/bash
# Шаг CI «lint». Стек проекта ещё не выбран — файл .ci-stack содержит "none",
# и шаг честно сообщает, что пропущен, вместо того чтобы делать вид, что проверил.
#
# Когда стек выберут, сюда вписывается настоящая команда, а в .ci-stack — имя стека.
#   PHP:    vendor/bin/phpunit  /  vendor/bin/phpstan analyse  /  vendor/bin/php-cs-fixer fix --dry-run
#   Node:   npm test            /  npx eslint .                /  npx tsc --noEmit
#   Python: pytest              /  ruff check .                /  mypy .
set -euo pipefail
STACK="$(cat "$(dirname "$0")/../../.ci-stack" 2>/dev/null || echo none)"

if [ "$STACK" = "none" ]; then
  echo "ci/lint: ПРОПУЩЕН — стек не выбран (.ci-stack = none)"
  exit 0
fi

echo "ci/lint: стек $STACK, но команда не прописана в scripts/ci/lint.sh"
echo "Допишите команду — шаг обязан либо проверять, либо явно объявлять себя пропущенным."
exit 1
