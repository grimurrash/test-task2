#!/bin/bash
# Пропуск для защищённых операций: открывает зону на указанное время.
#
# Зачем. Решение «ask» в хуке зависит от того, покажет ли среда диалог.
# В неинтерактивной сессии диалога нет, и «ask» молча пропускает команду —
# проверено 2026-08-25. Поэтому хуки отвечают отказом, а разрешение выдаётся
# заранее, отдельным сознательным действием, с зоной и сроком.
#
# Запускать в СВОЁМ терминале, не через агента: скрипт откажется работать,
# если увидит переменные окружения сессии Claude Code.
#
#   bash scripts/unlock.sh protected-files 15 "починка mark-verify"
#   bash scripts/unlock.sh --list
#   bash scripts/unlock.sh --revoke protected-files
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE="$ROOT/.claude/state/unlock.json"
LOG="$ROOT/.claude/logs/guard.jsonl"

ZONES="protected-files git-branch git-push-main git-history git-worktree"

usage() {
  cat <<TXT
Пропуск для защищённых операций.

  bash scripts/unlock.sh <зона> [минуты] ["причина"]   открыть зону (по умолчанию 15 минут)
  bash scripts/unlock.sh --list                        показать открытые зоны
  bash scripts/unlock.sh --revoke <зона>               закрыть зону досрочно

Зоны:
  protected-files   правка .claude/, .github/workflows/, CLAUDE.md
  git-branch        создание веток вне соглашения
  git-push-main     прямой push в main/master/develop
  git-history       git reset --hard, git clean -f
  git-worktree      git worktree add/remove
TXT
}

# Пропуск, выданный самому себе, — не пропуск. Если рядом переменные сессии
# агента, значит команду запускает агент, а не сэр.
if [ "${CLAUDECODE:-}" = "1" ] || [ -n "${CLAUDE_CODE_ENTRYPOINT:-}" ] || [ -n "${CLAUDE_AGENT_SDK_VERSION:-}" ]; then
  echo "unlock: отказано — команда запущена из сессии агента." >&2
  echo "Пропуск выдаёт сэр в своём терминале. В этом и смысл: иначе механизм" >&2
  echo "открывает себя тем, кого ограничивает." >&2
  exit 1
fi

case "${1:-}" in
  ""|-h|--help) usage; exit 0 ;;
  --list)
    python3 - "$STATE" <<'PY'
import json, sys, time
try:
    data = json.load(open(sys.argv[1], encoding="utf-8"))
except Exception:
    data = {}
now, live = time.time(), False
for zone, rec in sorted(data.items()):
    left = float(rec.get("until", 0)) - now
    if left > 0:
        live = True
        print("  %-16s ещё %2d мин  · %s" % (zone, int(left // 60) + 1, rec.get("reason", "")))
if not live:
    print("  открытых зон нет")
PY
    exit 0 ;;
  --revoke)
    zone="${2:-}"
    [ -n "$zone" ] || { echo "unlock: укажите зону" >&2; exit 1; }
    python3 - "$STATE" "$zone" <<'PY'
import json, sys
path, zone = sys.argv[1], sys.argv[2]
try:
    data = json.load(open(path, encoding="utf-8"))
except Exception:
    data = {}
data.pop(zone, None)
json.dump(data, open(path, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
print("unlock: зона «%s» закрыта" % zone)
PY
    exit 0 ;;
esac

zone="$1"
minutes="${2:-15}"
reason="${3:-без указания причины}"

case " $ZONES " in
  *" $zone "*) ;;
  *) echo "unlock: неизвестная зона «$zone»" >&2; usage >&2; exit 1 ;;
esac

case "$minutes" in
  ''|*[!0-9]*) echo "unlock: минуты должны быть числом" >&2; exit 1 ;;
esac
if [ "$minutes" -lt 1 ] || [ "$minutes" -gt 120 ]; then
  echo "unlock: срок от 1 до 120 минут. Бессрочный пропуск — это снятие запрета," >&2
  echo "а не подтверждение; для постоянных исключений есть .claude/guard-allow.txt." >&2
  exit 1
fi

mkdir -p "$(dirname "$STATE")" "$(dirname "$LOG")"
python3 - "$STATE" "$LOG" "$zone" "$minutes" "$reason" <<'PY'
import json, sys, time
state_path, log_path, zone, minutes, reason = sys.argv[1:6]
try:
    data = json.load(open(state_path, encoding="utf-8"))
except Exception:
    data = {}
until = time.time() + int(minutes) * 60
human = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(until))
data[zone] = {"until": until, "human_until": human, "reason": reason,
              "issued_at": time.strftime("%Y-%m-%d %H:%M:%S")}
json.dump(data, open(state_path, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
with open(log_path, "a", encoding="utf-8") as fh:
    fh.write(json.dumps({"ts": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "event": "unlock-issued",
                         "zone": zone, "minutes": int(minutes), "reason": reason,
                         "until": human}, ensure_ascii=False) + "\n")
print("unlock: зона «%s» открыта до %s (%s мин)" % (zone, human, minutes))
print("причина: %s" % reason)
PY
