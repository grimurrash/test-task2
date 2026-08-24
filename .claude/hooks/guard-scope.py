#!/usr/bin/env python3
"""PreToolUse: агент пишет только внутри репозитория.

Читать снаружи можно — материалы курса лежат в другой папке. А вот писать,
двигать и удалять за пределами проекта нельзя: рядом с репозиторием лежат
раздатка на полгигабайта и семьдесят чужих работ.
"""
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _hooklib as H

WRITE_TOOLS = ("Write", "Edit", "MultiEdit", "NotebookEdit")
DESTRUCTIVE = re.compile(
    r"\b(?:rm|rmdir|mv|cp|dd|truncate|shred|chmod|chown|ln|tee|install)\b", re.I)
REDIRECT = re.compile(r"(?<![0-9<>])>>?\s*(?P<path>(?:/|~/)[^\s;|&]+)")
ABSPATH = re.compile(r"(?<![\w=])(?:/|~/)[^\s;|&'\"]{3,}")

ALWAYS_OK_PREFIXES = ("/tmp", "/private/tmp", "/dev/null", "/dev/stdout", "/dev/stderr")

def inside(path, root):
    try:
        real = os.path.realpath(os.path.expanduser(path))
    except Exception:
        return True
    if real.startswith(ALWAYS_OK_PREFIXES):
        return True
    return real == root or real.startswith(root + os.sep)

def main():
    data = H.read_input()
    tool = data.get("tool_name", "")
    root = os.path.realpath(H.project_dir())
    ti = data.get("tool_input") or {}

    if tool in WRITE_TOOLS:
        for path in H.targets(data):
            if not inside(path, root) and not H.allowed(path):
                H.decide(
                    "deny",
                    "Заблокировано хуком guard-scope: запись за пределами репозитория.\n"
                    "Путь: %s\nКорень проекта: %s\n"
                    "Внутри проекта — пожалуйста. Наружу — только по прямой просьбе сэра "
                    "и через исключение в .claude/guard-allow.txt." % (path, root),
                    guard="guard-scope",
                )
        H.ok()

    cmd = ti.get("command") or ""
    if not cmd or H.allowed(cmd):
        H.ok()

    suspects = []
    for m in REDIRECT.finditer(cmd):
        suspects.append(m.group("path"))
    if DESTRUCTIVE.search(cmd):
        suspects.extend(ABSPATH.findall(cmd))

    for path in suspects:
        if not inside(path, root):
            H.decide(
                "deny",
                "Заблокировано хуком guard-scope: команда меняет файлы вне репозитория.\n"
                "Путь: %s\nКоманда: %s\nКорень проекта: %s" % (path, cmd[:300], root),
                guard="guard-scope",
            )
    H.ok()

main()
