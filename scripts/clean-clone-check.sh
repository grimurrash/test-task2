#!/bin/bash
# A8 — инструкция из README.md на чистом клоне, повторяемо.
#
#   bash scripts/clean-clone-check.sh                 # текущая ветка
#   bash scripts/clean-clone-check.sh --ref main      # другая ветка
#
# Прогон делался однажды руками, вывод лёг в REPORT 2.1 — и повторить его было
# нечем: порядок шагов жил в прозе отчёта, а проверяющий, пришедший завтра,
# повторял его по памяти автора. Здесь он делается сам: клон во временную
# папку, подъём по README, приёмочный сценарий, уборка.
#
# ─────────────────────────────────────────────────────────────────────────────
# ТРИ исхода, а не два. Третий по умолчанию сливается с первым и наступает
# чаще остальных — от обычных вещей: стенд не поднят, порт занят, сборка
# осталась от прошлого шага (REPORT 4.14, задача #127).
#
#   0 — сошлось:                приёмка прошла, расхождений нет
#   1 — разошлось:              приёмка нашла расхождение с заявленным поведением
#   2 — проверять было нечего:  нет Docker или git, порт занят, клон пуст,
#                               образ не собрался, стенд не ответил, приёмка
#                               не выполнила ни одной проверки
#
# Ноль печатается только вместе с числом выполненных проверок: «прошло
# 0 проверок» кодом 0 не заканчивается никогда.
# ─────────────────────────────────────────────────────────────────────────────
#
# ПОБОЧНОЕ ДЕЙСТВИЕ, названное вслух: сборка в клоне идёт теми же командами,
# что в README, а `compose.yaml` задаёт постоянные теги образов
# (`psp-backend:local` и соседние). Значит теги в вашем Docker будут
# пересобраны из клона. Контейнеры, сети и тома скрипт убирает за собой
# полностью; образы — намеренно нет: тег общий, и удаление задело бы стенд,
# поднятый вами руками. Прятать это за неполной уборкой хуже, чем назвать.
set -uo pipefail

PROJECT="psp-clean-clone"
API_PORT="${API_PORT:-19080}"
SANDBOX_PORT="${SANDBOX_PORT:-19081}"
DOCS_PORT="${DOCS_PORT:-19082}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-300}"

SOURCE_REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REF=""

while [ $# -gt 0 ]; do
  case "$1" in
    --ref) REF="${2:-}"; shift 2 ;;
    --repo) SOURCE_REPO="${2:-}"; shift 2 ;;
    *) printf 'Неизвестный аргумент: %s\n' "$1"; exit 2 ;;
  esac
done

say()     { printf '\n\033[1m%s\033[0m\n' "$1"; }
step()    { printf '  · %s\n' "$1"; }

# «Проверять было нечего» — отдельный выход с названной причиной. Именно он
# сливается с успехом, если о нём не позаботиться специально.
nothing() {
  printf '\n\033[1mПРОВЕРЯТЬ БЫЛО НЕЧЕГО: %s\033[0m\n' "$1"
  printf 'Это не «сошлось» и не «разошлось» — проверка не состоялась.\n'
  exit 2
}

CLONE_DIR=""
STAND_UP=0
cleanup() {
  if [ "$STAND_UP" = "1" ] && [ -n "$CLONE_DIR" ] && [ -d "$CLONE_DIR" ]; then
    printf '\n  · убираю стенд (контейнеры, сети, тома)\n'
    (cd "$CLONE_DIR" && docker compose -p "$PROJECT" down -v --remove-orphans >/dev/null 2>&1)
  fi
  [ -n "$CLONE_DIR" ] && rm -rf "$CLONE_DIR"
}
trap cleanup EXIT

say "A8 · инструкция README на чистом клоне"

# ── 1. Предусловия ───────────────────────────────────────────────────────────
command -v git >/dev/null 2>&1 || nothing "git не установлен"
command -v curl >/dev/null 2>&1 || nothing "curl не установлен"
command -v docker >/dev/null 2>&1 || nothing "Docker не установлен — единственное предусловие README"
docker version >/dev/null 2>&1 || nothing "Docker установлен, но демон не отвечает"
step "предусловия: git, curl, Docker на месте"

[ -d "$SOURCE_REPO/.git" ] || [ -f "$SOURCE_REPO/.git" ] || nothing "источник не репозиторий: $SOURCE_REPO"
if [ -z "$REF" ]; then
  REF="$(cd "$SOURCE_REPO" && git rev-parse --abbrev-ref HEAD 2>/dev/null)"
  [ -n "$REF" ] || nothing "не определить текущую ветку в $SOURCE_REPO"
fi
step "источник: $SOURCE_REPO, ветка $REF"

# ── 2. Порты ─────────────────────────────────────────────────────────────────
# Занятый порт — самая частая причина, по которой «проверять было нечего»:
# отвечает чужой стенд, и прогон меряет не то, что поднял.
for port in "$API_PORT" "$SANDBOX_PORT" "$DOCS_PORT"; do
  if curl -s -o /dev/null --max-time 2 "http://localhost:$port" 2>/dev/null; then
    nothing "порт $port уже кем-то занят — отвечал бы чужой стенд, а не клон"
  fi
done
step "порты $API_PORT, $SANDBOX_PORT, $DOCS_PORT свободны"

# ── 3. Клон ──────────────────────────────────────────────────────────────────
CLONE_DIR="$(mktemp -d /tmp/psp-clean-clone.XXXXXX)" || nothing "не создать временный каталог"
if ! git clone --quiet --branch "$REF" "$SOURCE_REPO" "$CLONE_DIR/repo" 2>/dev/null; then
  nothing "клон не сделан: ветки $REF нет или источник недоступен"
fi
CLONE_DIR_REPO="$CLONE_DIR/repo"

for required in compose.yaml README.md scripts/acceptance.sh; do
  [ -s "$CLONE_DIR_REPO/$required" ] || nothing "клон пуст или неполон: нет $required"
done
step "клон: $CLONE_DIR_REPO ($(cd "$CLONE_DIR_REPO" && git rev-parse --short HEAD))"

# ── 4. Подъём по README ──────────────────────────────────────────────────────
say "Подъём стенда: docker compose up -d --build"
printf '  (теги образов psp-*:local будут пересобраны из клона — см. шапку скрипта)\n'
STAND_UP=1
if ! (cd "$CLONE_DIR_REPO" && API_PORT="$API_PORT" SANDBOX_PORT="$SANDBOX_PORT" DOCS_PORT="$DOCS_PORT" \
      docker compose -p "$PROJECT" up -d --build); then
  nothing "образы не собрались или контейнеры не поднялись"
fi

BACKEND_ID="$(cd "$CLONE_DIR_REPO" && docker compose -p "$PROJECT" ps -q backend 2>/dev/null)"
[ -n "$BACKEND_ID" ] || nothing "контейнер backend не создан — мерить нечего"
step "стенд поднят проектом $PROJECT, backend ${BACKEND_ID:0:12}"

# ── 5. Ожидание готовности ───────────────────────────────────────────────────
say "Жду, пока API ответит (потолок $HEALTH_TIMEOUT с)"
READY=0
WAITED=0
while [ "$WAITED" -lt "$HEALTH_TIMEOUT" ]; do
  CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 \
    -H 'X-Merchant-Id: clean-clone' "http://localhost:$API_PORT/v1/payments" 2>/dev/null)"
  if [ "$CODE" = "200" ]; then READY=1; break; fi
  # Контейнер мог умереть — ждать дальше незачем, это тоже «нечего проверять».
  RUNNING="$(docker inspect -f '{{.State.Running}}' "$BACKEND_ID" 2>/dev/null)"
  [ "$RUNNING" = "true" ] || nothing "контейнер backend остановился, не начав отвечать"
  sleep 3
  WAITED=$((WAITED + 3))
done
[ "$READY" = "1" ] || nothing "API не ответил за $HEALTH_TIMEOUT секунд"
step "API отвечает на порту $API_PORT (через $WAITED с)"

# Проверяем, что отвечает именно наш контейнер, а не чужой стенд на том же
# порту: имя проекта у него наше (REPORT 4.14 №14 — «отвечает стенд от прошлого
# шага, а клон не проверен ничем»).
OWNER="$(docker ps --filter "publish=$API_PORT" --format '{{.ID}}' | head -1)"
[ "${OWNER:-}" = "${BACKEND_ID:0:12}" ] || nothing "порт $API_PORT держит чужой контейнер ($OWNER)"
step "на порту отвечает контейнер этого прогона, а не соседний стенд"

for part in "песочница:$SANDBOX_PORT" "документация:$DOCS_PORT"; do
  name="${part%%:*}"; port="${part##*:}"
  CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://localhost:$port" 2>/dev/null)"
  [ "$CODE" = "200" ] || nothing "$name не отвечает на порту $port (код «$CODE»)"
  step "$name отвечает на порту $port"
done

# ── 6. Приёмка из клона ──────────────────────────────────────────────────────
say "Приёмочный сценарий из клона: bash scripts/acceptance.sh"
ACCEPTANCE_OUT="$CLONE_DIR/acceptance.txt"
(cd "$CLONE_DIR_REPO" && BASE_URL="http://localhost:$API_PORT" bash scripts/acceptance.sh) \
  > "$ACCEPTANCE_OUT" 2>&1
ACCEPTANCE_RC=$?
cat "$ACCEPTANCE_OUT"

# `acceptance.sh` отвечает кодом 1 и на расхождение, и на недоступный API —
# то есть самая частая причина «нечего проверять» приходит сюда как
# «разошлось». Разбираем это здесь, а не правим приёмку: она за рамками задачи.
if grep -q 'API недоступен' "$ACCEPTANCE_OUT"; then
  nothing "приёмка не достучалась до API — ни одна проверка не выполнена"
fi

PASSED="$(grep -c '✓' "$ACCEPTANCE_OUT" | tr -d ' ')"
FAILED="$(grep -c '✗' "$ACCEPTANCE_OUT" | tr -d ' ')"
if [ "${PASSED:-0}" -eq 0 ]; then
  nothing "приёмка выполнила 0 проверок — вывод пуст или формат изменился"
fi

say "Итог"
if [ "$ACCEPTANCE_RC" -ne 0 ] || [ "${FAILED:-0}" -ne 0 ]; then
  printf '\033[1mРАЗОШЛОСЬ: расхождений — %s, проверок выполнено — %s.\033[0m\n' "$FAILED" "$PASSED"
  printf 'Инструкция README отработала, но поведение разошлось с заявленным.\n'
  exit 1
fi

printf '\033[1mСОШЛОСЬ: %s проверок пройдено, расхождений нет.\033[0m\n' "$PASSED"
printf 'Клон: ветка %s, чистая временная папка. Стенд убран.\n' "$REF"
exit 0
