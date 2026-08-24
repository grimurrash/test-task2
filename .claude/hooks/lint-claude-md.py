#!/usr/bin/env python3
"""Линтер правил проекта.

Занятие 2 началось с того, что агент удалил папку Temp, хотя в CLAUDE.md было
написано не удалять. Разбор: «формулировка была мягкой». Этот линтер ищет
ровно такие формулировки — правила, которые звучат как просьба и ничем
не подкреплены, — и предлагает перевести их в механизм.

CLI:  python3 .claude/hooks/lint-claude-md.py [файл ...]
"""
import os
import re
import sys

SOFT = [
    (r"\b(?:постарайся|по\s+возможности|желательно|лучше\s+не|не\s+забудь|старайся|аккуратн\w+\s+с)\b",
     "мягкая формулировка — агент обойдёт её при первом же убедительном тексте"),
    (r"\b(?:try\s+to|please\s+(?:avoid|don'?t)|if\s+possible|prefer\s+not\s+to)\b",
     "мягкая формулировка (англ.)"),
    (r"\b(?:никогда|ни\s+в\s+коем\s+случае|запрещено|нельзя)\b(?![^\n]*хук)",
     "жёсткий запрет без механизма — стоит подкрепить хуком или правом ОС"),
]

def lint(path):
    try:
        with open(path, encoding="utf-8") as fh:
            lines = fh.read().splitlines()
    except OSError:
        return ["не удалось прочитать %s" % path]

    notes = []
    if len(lines) > 200:
        notes.append("%s: %d строк — длинный файл правил читается хуже; вынесите детали в docs/"
                     % (path, len(lines)))
    for i, line in enumerate(lines, 1):
        if line.strip().startswith(("#", ">", "|")):
            continue
        for pattern, human in SOFT:
            if re.search(pattern, line, re.I):
                notes.append("%s:%d — %s\n      %s" % (path, i, human, line.strip()[:120]))
                break
    return notes

def main(argv):
    paths = argv[1:]
    if not paths:
        root = os.environ.get("CLAUDE_PROJECT_DIR") or os.getcwd()
        paths = [p for p in (os.path.join(root, "CLAUDE.md"),) if os.path.exists(p)]
    notes = []
    for path in paths:
        notes.extend(lint(path))
    if not notes:
        print("lint-claude-md: правила выглядят механическими, мягких формулировок нет")
        return 0
    print("lint-claude-md: замечания (%d):" % len(notes))
    for note in notes:
        print("  · " + note)
    return 0

if __name__ == "__main__":
    sys.exit(main(sys.argv))
