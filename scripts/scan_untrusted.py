#!/usr/bin/env python3
"""Поиск скрытых инструкций в тексте.

Один и тот же сканер используется дважды: хуком PostToolUse — на всём, что
агент прочитал в сессии, и в CI — на всех текстовых файлах репозитория.

Он ничего не блокирует. Задача — назвать находку вслух. На занятии это была
главная мысль про инъекции: «молча не выполнила» и «сказала вслух» — разные
уровни защиты, и полагаться можно только на второй.

CLI:  python3 scripts/scan_untrusted.py [путь ...]
      код возврата 1, если что-то найдено.
"""
# scan-untrusted: allow-samples — файл держит корпус шаблонов инъекций
# по долгу службы: без них сканеру нечем искать.
import os
import re
import sys

INVISIBLE = {
    "​": "ZERO WIDTH SPACE",
    "‌": "ZERO WIDTH NON-JOINER",
    "‍": "ZERO WIDTH JOINER",
    "‎": "LEFT-TO-RIGHT MARK",
    "‏": "RIGHT-TO-LEFT MARK",
    "‪": "LEFT-TO-RIGHT EMBEDDING",
    "‫": "RIGHT-TO-LEFT EMBEDDING",
    "‬": "POP DIRECTIONAL FORMATTING",
    "‭": "LEFT-TO-RIGHT OVERRIDE",
    "‮": "RIGHT-TO-LEFT OVERRIDE",
    "⁠": "WORD JOINER",
    "⁡": "FUNCTION APPLICATION",
    "﻿": "ZERO WIDTH NO-BREAK SPACE",
    "­": "SOFT HYPHEN",
}

PHRASES = [
    (r"ignore\s+(?:all\s+)?(?:the\s+)?(?:previous|prior|above|earlier)\s+instructions?", "классическая инъекция (англ.)"),
    (r"disregard\s+(?:all\s+)?(?:previous|prior|above|your)\s+", "классическая инъекция (англ.)"),
    (r"forget\s+(?:everything|all\s+previous)", "сброс инструкций"),
    (r"you\s+are\s+now\s+(?:a|an|the)\s+", "подмена роли"),
    (r"new\s+(?:system\s+)?instructions?\s*:", "подмена системного промпта"),
    (r"system\s*prompt\s*:", "подмена системного промпта"),
    (r"</?(?:system|important|admin)[-_ ]?(?:instruction|prompt|override)>", "псевдосистемный тег"),
    (r"do\s+not\s+(?:tell|inform|mention\s+to)\s+the\s+user", "просьба скрыть от пользователя"),
    (r"without\s+(?:telling|informing|asking)\s+the\s+user", "просьба действовать втайне"),
    (r"игнорируй\s+(?:все\s+)?(?:предыдущие|прошлые|прежние)", "классическая инъекция (рус.)"),
    (r"забудь\s+(?:все\s+)?(?:инструкции|предыдущие)", "сброс инструкций"),
    (r"не\s+сообщай\s+пользовател", "просьба скрыть от пользователя"),
    (r"ты\s+теперь\s+(?:не\s+)?(?:ассистент|агент|модель)", "подмена роли"),
    (r"выполни\s+(?:это\s+)?(?:немедленно|молча|без\s+подтверждени)", "давление на срочность"),
    (r"(?:seed[-\s]?(?:phrase|фраз)|мнемоническ\w+\s+фраз|приватн\w+\s+ключ\w*\s+кошельк)", "охота за ключами кошелька"),
    (r"curl\s+[^\s|;]+\s*\|\s*(?:ba)?sh", "загрузи-и-выполни"),
    (r"color\s*:\s*(?:#fff(?:fff)?|white)\b[^;}]*", "белый текст (возможна маскировка)"),
    (r"font-size\s*:\s*0(?:px|pt|em)?\b", "нулевой кегль (скрытый текст)"),
    (r"display\s*:\s*none[^;}]*", "скрытый блок"),
]

COMPILED = [(re.compile(p, re.I), h) for p, h in PHRASES]

# Файл, который держит образцы инъекций по долгу службы, объявляет об этом сам —
# строкой с маркером в своей шапке (issue #42). Раньше здесь был список имён
# (`SELF_FILES`), и он отставал от репозитория: как только собственные тесты
# появились у роли бэкенда, сканер начал валить их CI. Перечисление не
# закрывается — ровно как список защищённых упоминаний в guard-protected-files.
#
# Маркер — обычная подстрока, поэтому работает в комментарии любого языка:
#   Python/shell/YAML:  # scan-untrusted: allow-samples
#   TS/JS/Go:           // scan-untrusted: allow-samples
#   Markdown/HTML:      <!-- scan-untrusted: allow-samples -->
#
# Ищется только в начале файла: маркер, оказавшийся в глубине внешнего текста —
# случайно или намеренно, — отключал бы проверку файла, а сканер существует
# ровно ради внешнего текста. Заодно это выполняет требование «виден человеку
# при чтении файла, а не спрятан».
#
# Пропуск объявляется вслух в выводе — тихая фильтрация превращает отчёт в ложь.
# Клапан `.claude/guard-allow.txt` здесь намеренно не действует: это другой
# механизм (ослабление запретов хуков), и смешивать их не надо.
SAMPLE_MARKER = "scan-untrusted: allow-samples"
MARKER_WINDOW = 2048

# .worktrees — рабочие копии ролей. Внутри каждой лежит полная копия репозитория,
# включая файлы с намеренными образцами инъекций; без пропуска сканер находил бы
# их снова и снова и возвращал ненулевой код на здоровом дереве.
SKIP_DIRS = {".git", ".worktrees", "node_modules", "vendor", ".venv", "venv",
             "dist", "build", "__pycache__", ".claude/logs"}
TEXT_EXT = {".md", ".txt", ".json", ".yml", ".yaml", ".html", ".htm", ".csv", ".xml",
            ".js", ".ts", ".py", ".php", ".go", ".sh", ".toml", ".ini", ".cfg", ".sql"}

def find_markers(text, limit=40):
    """Возвращает список (тип, что нашли, фрагмент)."""
    found = []
    for ch, name in INVISIBLE.items():
        if ch in text:
            idx = text.index(ch)
            found.append(("невидимый символ", name,
                          repr(text[max(0, idx - 40):idx + 40])))
            if len(found) >= limit:
                return found
    for rx, human in COMPILED:
        m = rx.search(text)
        if m:
            start = max(0, m.start() - 60)
            found.append(("фраза", human, text[start:m.end() + 60].replace("\n", " ")))
            if len(found) >= limit:
                return found
    return found

def declares_samples(text):
    """Файл объявил себя носителем образцов инъекций — маркер в шапке."""
    return SAMPLE_MARKER in text[:MARKER_WINDOW]

def scan_path(root, skipped=None):
    hits = []
    skipped = skipped if skipped is not None else []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        for name in filenames:
            path = os.path.join(dirpath, name)
            if os.path.splitext(name)[1].lower() not in TEXT_EXT:
                continue
            if os.path.getsize(path) > 2_000_000:
                continue
            try:
                with open(path, encoding="utf-8", errors="replace") as fh:
                    text = fh.read()
            except OSError:
                continue
            if declares_samples(text):
                skipped.append(path)
                continue
            for kind, human, snippet in find_markers(text):
                hits.append((path, kind, human, snippet))
    return hits

def main(argv):
    roots = argv[1:] or ["."]
    all_hits = []
    skipped = []
    for root in roots:
        if os.path.isdir(root):
            all_hits.extend(scan_path(root, skipped))
        elif os.path.isfile(root):
            # Тот же маркер действует и когда файл назван прямо: иначе механизм
            # вёл бы себя по-разному в зависимости от того, как его позвали —
            # каталогом или файлом. Прежний SELF_FILES здесь не проверялся вовсе.
            with open(root, encoding="utf-8", errors="replace") as fh:
                text = fh.read()
            if declares_samples(text):
                skipped.append(root)
                continue
            for kind, human, snippet in find_markers(text):
                all_hits.append((root, kind, human, snippet))
    if skipped:
        print("scan_untrusted: пропущены файлы с образцами инъекций: %s"
              % ", ".join(sorted(skipped)))
    if not all_hits:
        print("scan_untrusted: скрытых инструкций не найдено")
        return 0
    print("scan_untrusted: находки (%d):" % len(all_hits))
    for path, kind, human, snippet in all_hits:
        print("  %s\n    %s — %s\n    %s" % (path, kind, human, snippet[:200]))
    return 1

if __name__ == "__main__":
    sys.exit(main(sys.argv))
