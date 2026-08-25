#!/usr/bin/env python3
"""PreToolUse (Bash): защита истории и защищённых веток.

Правила сэра из ~/.claude/CLAUDE.md переведены из текста в механизм:
force-push в master/main/develop запрещён, чужие коммиты не переписываем,
ветки без спроса не заводим.
"""
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _hooklib as H

PROTECTED = r"(?:master|main|develop|release/[\w.\-/]+)"

DENY = [
    (r"\bgit\s+push\b[^|;&]*\s(?:--force\b|-f\b)(?![\w-])", "force-push"),
    (r"\bgit\s+push\b[^|;&]*--force-with-lease\b[^|;&]*\s" + PROTECTED, "force-with-lease в защищённую ветку"),
    (r"\bgit\s+push\b[^|;&]*\s\+[\w./-]*" + PROTECTED, "push с перезаписью (refspec с +)"),
    (r"\bgit\s+push\b[^|;&]*--mirror\b", "push --mirror переписывает всё"),
    (r"\bgit\s+filter-branch\b", "переписывание истории"),
    (r"\bgit\s+filter-repo\b", "переписывание истории"),
    (r"\bgit\s+reflog\s+expire\b", "уничтожение reflog"),
    (r"\bgit\s+update-ref\s+-d\b", "удаление ссылки напрямую"),
    (r"\bgit\s+(?:commit|push|merge)\b[^|;&]*--no-verify\b", "обход собственных проверок"),
    (r"\bgit\s+branch\s+(?:-D|--delete\s+--force)\s+" + PROTECTED, "удаление защищённой ветки"),
    (r"\bgit\s+config\b[^|;&]*\bcore\.hooksPath\b", "подмена пути хуков git"),
]

# Операции, которые раньше спрашивали подтверждения. Теперь каждая привязана
# к зоне пропуска: «ask» в неинтерактивной сессии пропускает команду, поэтому
# барьером служит отказ, а разрешение выдаётся заранее через scripts/unlock.sh.
CONFIRM = [
    (r"\bgit\s+push\b[^|;&]*\s(?:origin\s+)?" + PROTECTED + r"\b",
     "прямой push в защищённую ветку (обычно нужен PR)", "git-push-main"),
    (r"\bgit\s+reset\s+--hard\b",
     "git reset --hard выбрасывает несохранённую работу", "git-history"),
    (r"\bgit\s+clean\s+-[\w]*f",
     "git clean -f удаляет неотслеживаемые файлы", "git-history"),
    (r"\bgit\s+checkout\s+-b\b|\bgit\s+switch\s+-c\b",
     "создание новой ветки", "git-branch"),
    (r"\bgit\s+worktree\s+(?:add|remove)\b",
     "операция с worktree", "git-worktree"),
]

def main():
    data = H.read_input()
    cmd = (data.get("tool_input") or {}).get("command") or ""
    if not cmd or H.allowed(cmd):
        H.ok()
    for pattern, human in DENY:
        if re.search(pattern, cmd, re.I):
            H.decide(
                "deny",
                "Заблокировано хуком guard-git: %s.\nКоманда: %s\n"
                "Правило сэра: force-push в master/main/develop и перезапись чужих "
                "коммитов запрещены во всех режимах." % (human, cmd[:300]),
                guard="guard-git",
            )
    for pattern, human, zone in CONFIRM:
        if re.search(pattern, cmd, re.I):
            H.confirm(
                zone,
                "Заблокировано хуком guard-git: %s.\nКоманда: %s" % (human, cmd[:300]),
                guard="guard-git",
            )
    H.ok()

main()
