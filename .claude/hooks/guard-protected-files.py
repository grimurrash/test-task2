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
    root = os.path.realpath(H.project_dir())

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

        if not (WRITE_INTENT.search(normalized) or INLINE_CODE.search(normalized)):
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
