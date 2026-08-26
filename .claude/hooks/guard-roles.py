#!/usr/bin/env python3
"""PreToolUse (Bash): границы между координатором и исполнителями.

Схема из двух ролей (docs/roles/) держится на двух правилах, которые в тексте
регламента остались бы пожеланиями:

  1. Тикет закрывает координатор, не исполнитель. Иначе владелец задачи
     становится единственным источником истины о том, что она выполнена, —
     ровно то, что разбор 25 августа назвал главной причиной, по которой
     приёмку делает не автор (multisession.md, §3.3).

  2. Исполнитель работает только в своей копии. Четыре инцидента с общей
     рабочей копией и два «отката» на 707 и 603 строки за одну смену —
     цена того, что это правило было текстом (§4.4).

Роль определяется каталогом, а не словом о себе: сессия, чей рабочий каталог
лежит внутри `.worktrees/<имя>`, — исполнитель, всякая другая — координатор
или сэр. Признак машинный и подделать его в чате нельзя.

Границы механизма названы честно. Он читает команды, а не намерения: закрыть
тикет через веб-интерфейс или из другого каталога он не помешает, и цель
у него другая — не запереть, а не дать сделать это по невнимательности,
оставив отказ в журнале.
"""
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _hooklib as H
from _paths import strip_heredocs

# Позиция имеет значение, как и в guard-git: команда должна стоять на месте
# запуска, а не быть упомянутой в тексте коммита или сообщения.
CMD_POS = r"(?:^\s*|[;&|\n]\s*)"

ISSUE_CLOSE = re.compile(CMD_POS + r"gh\s+issue\s+close\b", re.I)
WORKTREE_PATH = re.compile(r"\.worktrees/([a-z0-9._-]+)", re.I)

def own_worktree(cwd):
    """Имя копии, если сессия работает внутри .worktrees/<имя>, иначе None."""
    parts = os.path.realpath(cwd or "").replace(os.sep, "/").split("/")
    if ".worktrees" in parts:
        idx = parts.index(".worktrees")
        if idx + 1 < len(parts):
            return parts[idx + 1]
    return None

def main():
    data = H.read_input()
    cmd = (data.get("tool_input") or {}).get("command") or ""
    if not cmd or H.allowed(cmd):
        H.ok()

    mine = own_worktree(data.get("cwd") or "")
    if not mine:
        H.ok()                      # координатор и сэр этим хуком не ограничены

    cmd_clean = strip_heredocs(cmd)

    if ISSUE_CLOSE.search(cmd_clean):
        H.decide(
            "deny",
            "Заблокировано хуком guard-roles: тикет закрывает координатор.\n"
            "Команда: %s\n"
            "Исполнитель сдаёт работу рапортом через SendMessage — что сделано, "
            "чем проверено, что осталось. Закрытие по слову автора и есть тот "
            "случай, ради которого приёмку делает не автор." % cmd[:300],
            guard="guard-roles",
        )

    foreign = {name for name in WORKTREE_PATH.findall(cmd_clean) if name != mine}
    if foreign:
        H.decide(
            "deny",
            "Заблокировано хуком guard-roles: обращение к чужой рабочей копии "
            "(%s) из копии «%s».\nКоманда: %s\n"
            "У каждой сессии своя копия и свой HEAD. Общая копия за прошлую смену "
            "дала четыре инцидента и два «отката», которых никто не делал."
            % (", ".join(sorted(foreign)), mine, cmd[:300]),
            guard="guard-roles",
        )

    H.ok()

main()
