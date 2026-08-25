#!/usr/bin/env python3
"""PreToolUse: файлы, которые сами задают правила, правятся только по пропуску.

Хук, который защищает хуки. Иначе механизм отключается тем же агентом,
которого он ограничивает, и превращается обратно в пожелание.

Две дыры, найденные 2026-08-25 и закрытые здесь.

Первая: хук висел только на Write и Edit, поэтому `sed -i` по .claude/hooks/
проходил молча — проверено запуском, ни один из трёх хуков на Bash не возразил.
Теперь проверяются и команды: если команда намерена писать и упоминает
защищённый путь, она получает отказ.

Вторая: решение «ask» зависит от того, покажет ли среда диалог. В неинтерактивной
сессии диалога нет, и «ask» пропускает команду, оставляя в журнале только след.
Поэтому здесь отказ, а разрешение выдаётся заранее: сэр открывает зону
«protected-files» командой scripts/unlock.sh в своём терминале.

Исключения из .claude/guard-allow.txt здесь намеренно не действуют: постоянное
исключение для файла правил — это и есть снятие защиты.

Третья, найденная 2026-08-25 (issue #24): корень для разрешения путей брался
из `CLAUDE_PROJECT_DIR`/`os.getcwd()` — внутри linked worktree это могло
оказаться самим worktree, а не основной копией. Теперь корень — общий для
обеих через `git rev-parse --git-common-dir` (`_hooklib.repo_root`).
"""
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _hooklib as H
from _paths import INLINE_CODE, WRITE_INTENT, normalize, path_candidates, resolve

PROTECTED = [
    (r"\.claude/settings\.json$", "настройки проекта и список хуков"),
    (r"\.claude/hooks/", "сами хуки"),
    (r"\.claude/guard-allow\.txt$", "список исключений из запретов"),
    (r"\.claude/state/unlock\.json$", "выданные пропуски"),
    (r"\.github/workflows/", "конфигурация CI"),
    (r"(?:^|/)CLAUDE\.md$", "правила проекта"),
    (r"scripts/unlock\.sh$", "выдача пропусков"),
]

# Те же файлы, но упомянутые внутри команды. Путь может стоять в кавычках,
# внутри встроенного кода, сразу после скобки — якоря «начало строки или слэш»
# там не работают: python3 -c "open('CLAUDE.md','w')" прошёл мимо проверки,
# потому что в токене не было ни одного слэша.
MENTION = [
    (r"\.claude/settings\.json", "настройки проекта и список хуков"),
    (r"\.claude/hooks/", "сами хуки"),
    (r"\.claude/guard-allow\.txt", "список исключений из запретов"),
    (r"\.claude/state/unlock\.json", "выданные пропуски"),
    (r"\.github/workflows/", "конфигурация CI"),
    (r"(?:^|[^\w.\-/])CLAUDE\.md(?![\w.\-])", "правила проекта"),
    (r"scripts/unlock\.sh", "выдача пропусков"),
]

# Запуск скрипта выдачи пропусков — именно запуск, а не упоминание. Первая
# версия ловила имя в любом месте команды и блокировала даже коммит, в тексте
# которого это имя встречалось. Механизм, дающий ложные тревоги, обходят так же
# охотно, как дырявый.
# Признаки записи внутри встроенного кода. Граница репозитория считает любой
# `python3 -c` намерением записи — там цена ошибки высока, наружу пишут один раз.
# Здесь та же строгость даёт перегиб: команда, читающая .claude/state/unlock.json,
# получала отказ наравне с командой, его переписывающей. Читать свои же файлы
# правил можно, менять — нет.
INLINE_WRITE = re.compile(
    r"open\s*\([^)]*['\"][wax]\+?['\"]"          # open(path, 'w'), 'a', 'x'
    r"|open\s*\([^)]*['\"]r\+['\"]"              # open(path, 'r+') — тоже запись
    r"|\bmode\s*=\s*['\"][wax]"
    r"|\.write(?:lines|_text|_bytes)?\s*\("
    r"|\bwriteFileSync\b|\bappendFileSync\b|\bfs\.\w*[Ww]rite\w*\s*\("
    r"|\b(?:json|yaml|pickle)\.dump\s*\("
    r"|\b(?:unlink|remove|rmtree|rename|replace|truncate|mkdir|makedirs|chmod|symlink)\s*\("
    r"|\bshutil\.\w+\s*\(",
    re.I)

RUN_UNLOCK = re.compile(
    r"(?:^|[;&|]\s*)(?:(?:bash|sh|zsh|source)\s+)?(?:\./)?scripts/unlock\.sh\b")

ZONE = "protected-files"

def protected_hit(text, root):
    """Название защищённого файла, если строка ведёт к нему. Иначе None.

    Смотрим и на написанное, и на то, куда путь попадёт на самом деле:
    `../2/.claude/hooks/x.py` — тот же файл, что и `.claude/hooks/x.py`.
    """
    variants = [normalize(text)]
    resolved = resolve(text, root)
    if resolved == root or resolved.startswith(root + os.sep):
        variants.append(os.path.relpath(resolved, root))
    for variant in variants:
        for pattern, human in PROTECTED:
            if re.search(pattern, variant):
                return human
    return None

def main():
    data = H.read_input()
    tool = data.get("tool_name", "")
    # issue #24: корень — общий для основной копии и её worktree, а не то,
    # что случайно лежит в CLAUDE_PROJECT_DIR/cwd. См. _hooklib.repo_root.
    root = H.repo_root(data.get("cwd"))

    if tool == "Bash":
        cmd = (data.get("tool_input") or {}).get("command") or ""
        if not cmd:
            H.ok()
        normalized = normalize(cmd)

        # Пропуск себе не выдают. Запуск scripts/unlock.sh из сессии агента
        # запрещён всегда — в том числе при открытой зоне, иначе агент продлевал
        # бы себе разрешение сам, и весь механизм сводился бы к одной команде.
        if RUN_UNLOCK.search(normalized):
            H.decide(
                "deny",
                "Заблокировано хуком guard-protected-files: выдача пропуска из сессии агента.\n"
                "Команда: %s\n"
                "Пропуск выдаёт сэр в своём терминале — механизм, который открывает "
                "себя тем, кого ограничивает, защитой не является." % cmd[:300],
                guard="guard-protected-files",
            )

        # Подмена корня состояния — то же самое, что выдача пропуска себе,
        # только окольным путём: хуки станут читать unlock.json из каталога,
        # который агент полностью контролирует (issue #54). Переменная
        # существует ради изоляции прогона тестов, и выставлять её вправе
        # тот, кто запускает набор, а не команда внутри сессии.
        if re.search(r"\bCLAUDE_GUARD_STATE_DIR\b", normalized):
            H.decide(
                "deny",
                "Заблокировано хуком guard-protected-files: подмена корня состояния "
                "обвязки из сессии агента.\nКоманда: %s\n"
                "CLAUDE_GUARD_STATE_DIR уводит пропуски и журналы на другой каталог. "
                "Задать её из команды — значит подсунуть хукам собственный unlock.json; "
                "это выдача пропуска себе, а не настройка." % cmd[:300],
                guard="guard-protected-files",
            )

        writes = bool(WRITE_INTENT.search(normalized))
        inline = bool(INLINE_CODE.search(normalized))
        if not writes and not inline:
            H.ok()
        # Встроенный код без единого признака записи — это чтение.
        if not writes and inline and not INLINE_WRITE.search(normalized):
            H.ok()

        for candidate in path_candidates(cmd):
            human = protected_hit(candidate, root)
            if human:
                H.confirm(
                    ZONE,
                    "Заблокировано хуком guard-protected-files: команда правит «%s».\n"
                    "Команда: %s" % (human, cmd[:300]),
                    guard="guard-protected-files",
                )

        # Путь мог не выделиться в отдельный аргумент — он бывает внутри кавычек
        # встроенного кода. Здесь ищем упоминание по всей команде, но только когда
        # намерение записи уже установлено выше.
        for pattern, human in MENTION:
            if re.search(pattern, normalized):
                H.confirm(
                    ZONE,
                    "Заблокировано хуком guard-protected-files: команда правит «%s».\n"
                    "Команда: %s" % (human, cmd[:300]),
                    guard="guard-protected-files",
                )
        H.ok()

    for text in H.targets(data):
        human = protected_hit(text, root)
        if human:
            H.confirm(
                ZONE,
                "Заблокировано хуком guard-protected-files: правится «%s».\n"
                "Файл: %s\nИнструмент: %s" % (human, text, tool),
                guard="guard-protected-files",
            )
    H.ok()

main()
