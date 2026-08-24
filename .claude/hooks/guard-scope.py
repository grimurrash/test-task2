#!/usr/bin/env python3
"""PreToolUse: агент пишет только внутри репозитория.

Читать снаружи можно — материалы курса лежат в другой папке. Писать, двигать
и удалять за пределами проекта нельзя: рядом с репозиторием чужие файлы.

Первая версия сравнивала строки и была вскрыта внешним ревью: проходили
относительные пути (`> ../../outside`), закавыченные (`> "/outside"`), пути через
переменную окружения и запись неучтёнными программами (`sed -i`, `python3 -c`).
Теперь путь сначала разворачивается в тот, куда команда действительно попадёт,
и проверяется намерение записи, а не список опасных имён команд.

Полной гарантии регулярки не дают и дать не могут — граница уровня ОС остаётся
задачей песочницы. Что именно остаётся дырой, записано в docs/HOOKS.md.
"""
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _hooklib as H
from _paths import normalize, path_candidates, resolve

WRITE_TOOLS = ("Write", "Edit", "MultiEdit", "NotebookEdit")

# Признаки намерения записи. Список неполон принципиально — поэтому ниже
# добавлена отдельная проверка встроенных интерпретаторов.
WRITE_INTENT = re.compile(
    r"(?<![0-9<>])>>?(?![>])"                                  # перенаправление вывода
    r"|\b(?:rm|rmdir|unlink|mv|cp|dd|truncate|shred|touch|mkdir|install|rsync|scp)\b"
    r"|\b(?:tee|ln)\b"
    r"|\b(?:chmod|chown|chgrp|xattr)\b"
    r"|\bsed\b[^|;&]*\s-i\b|\bperl\b[^|;&]*\s-[a-z]*i[a-z]*\b"
    r"|\bcurl\b[^|;&]*\s-(?:o|-output)\b|\bwget\b[^|;&]*\s-(?:O|-output-document)\b"
    r"|\bgit\s+(?:clone|init|worktree\s+add)\b",
    re.I)

# Встроенный код нельзя разобрать регуляркой: если он упоминает путь наружу,
# считаем это записью и отказываем. Ложный отказ дешевле пропущенной записи.
INLINE_CODE = re.compile(
    r"\b(?:python[\d.]*|python3)\s+-c\b|\bnode\s+-e\b|\bperl\s+-[a-z]*e\b"
    r"|\bruby\s+-e\b|\bphp\s+-r\b|\bosascript\b|\bawk\b[^|;&]*\bprint\s*>",
    re.I)

ALWAYS_OK = ("/tmp", "/private/tmp", "/dev/null", "/dev/stdout", "/dev/stderr", "/dev/fd")

def inside(resolved, root):
    if resolved.startswith(ALWAYS_OK):
        return True
    return resolved == root or resolved.startswith(root + os.sep)

def refuse(kind, path, root, extra=""):
    H.decide(
        "deny",
        "Заблокировано хуком guard-scope: %s за пределами репозитория.\n"
        "Путь: %s\nКорень проекта: %s%s\n"
        "Внутри проекта — пожалуйста. Наружу — только по прямой просьбе сэра "
        "и через исключение в .claude/guard-allow.txt." % (kind, path, root, extra),
        guard="guard-scope",
    )

def main():
    data = H.read_input()
    tool = data.get("tool_name", "")
    root = os.path.realpath(H.project_dir())

    if tool in WRITE_TOOLS:
        for path in H.targets(data):
            if H.allowed(path):
                continue
            if not inside(resolve(path, root), root):
                refuse("запись", path, root)
        H.ok()

    cmd = (data.get("tool_input") or {}).get("command") or ""
    if not cmd or H.allowed(cmd):
        H.ok()

    normalized = normalize(cmd)
    writes = bool(WRITE_INTENT.search(normalized))
    inline = bool(INLINE_CODE.search(normalized))
    if not writes and not inline:
        H.ok()

    for candidate in path_candidates(cmd):
        resolved = resolve(candidate, root)
        if inside(resolved, root):
            continue
        if inline and not writes:
            refuse("встроенный код обращается к пути", candidate, root,
                   "\nВстроенный код (-c, -e, -r) разобрать нельзя, поэтому "
                   "обращение наружу считается записью.")
        refuse("изменение файлов", candidate, root,
               "\nКоманда: %s" % cmd[:300])
    H.ok()

main()
