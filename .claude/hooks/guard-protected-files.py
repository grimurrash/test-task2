#!/usr/bin/env python3
"""PreToolUse: правка файлов, которые сами задают правила, — только с подтверждения.

Хук, который защищает хуки. Иначе механизм отключается тем же агентом,
которого он ограничивает, и превращается обратно в пожелание.
"""
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _hooklib as H

PROTECTED = [
    (r"\.claude/settings\.json$", "настройки проекта и список хуков"),
    (r"\.claude/hooks/", "сами хуки"),
    (r"\.claude/guard-allow\.txt$", "список исключений из запретов"),
    (r"\.github/workflows/", "конфигурация CI"),
    (r"(?:^|/)CLAUDE\.md$", "правила проекта"),
]

def main():
    data = H.read_input()
    tool = data.get("tool_name", "")
    for text in H.targets(data):
        for pattern, human in PROTECTED:
            if re.search(pattern, text):
                H.decide(
                    "ask",
                    "guard-protected-files: правится «%s».\nФайл: %s\nИнструмент: %s\n"
                    "Это файл, который определяет правила работы, — подтвердите изменение."
                    % (human, text, tool),
                    guard="guard-protected-files",
                )
    H.ok()

main()
