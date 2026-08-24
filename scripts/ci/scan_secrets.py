#!/usr/bin/env python3
"""Поиск секретов в том, что попало в git.

Ключ утекает не через взлом, а через файл, который показали сами. Проверка
идёт по файлам, которые git считает своими: незакоммиченный мусор не в счёт,
а вот .env в индексе — это уже утечка.

    python3 scripts/ci/scan_secrets.py     # код 1, если что-то найдено
"""
import os
import re
import subprocess
import sys

PATTERNS = [
    (r"AKIA[0-9A-Z]{16}", "ключ доступа AWS"),
    (r"-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----", "приватный ключ"),
    (r"\bghp_[A-Za-z0-9]{30,}", "токен GitHub"),
    (r"\bgithub_pat_[A-Za-z0-9_]{60,}", "токен GitHub (fine-grained)"),
    (r"\bxox[baprs]-[A-Za-z0-9-]{10,}", "токен Slack"),
    (r"\bsk-[A-Za-z0-9]{32,}", "ключ API вида sk-"),
    (r"\bAIza[0-9A-Za-z_\-]{35}", "ключ Google API"),
    (r"(?i)\b(?:api[_-]?key|secret|password|passwd|token)\s*[:=]\s*[\"'][^\"'\s]{16,}[\"']", "похоже на секрет в коде"),
    (r"(?i)postgres(?:ql)?://[^:\s]+:[^@\s]{4,}@", "строка подключения с паролем"),
    (r"(?i)mysql://[^:\s]+:[^@\s]{4,}@", "строка подключения с паролем"),
]
COMPILED = [(re.compile(p), h) for p, h in PATTERNS]

# Файлы, которые содержат сами шаблоны и потому всегда «находят» себя.
SELF = {"scripts/ci/scan_secrets.py", "scripts/scan_untrusted.py", "docs/HOOKS.md"}
FORBIDDEN_TRACKED = re.compile(r"(?:^|/)(?:\.env(?!\.(?:example|dist|sample|template))|id_rsa|id_ed25519|\.npmrc|\.git-credentials|\.netrc)(?:$|\.)")
BINARY_EXT = {".png", ".jpg", ".jpeg", ".gif", ".pdf", ".zip", ".mp4", ".ico", ".woff", ".woff2"}

def tracked_files():
    try:
        out = subprocess.run(["git", "ls-files"], capture_output=True, text=True, timeout=60)
        return [f for f in out.stdout.splitlines() if f]
    except Exception:
        return []

def main():
    problems = []
    files = tracked_files()
    if not files:
        print("scan_secrets: git не вернул файлов — пропускаю")
        return 0

    for path in files:
        if FORBIDDEN_TRACKED.search(path):
            problems.append((path, 0, "файл такого рода не должен быть в git"))

    for path in files:
        if path in SELF or os.path.splitext(path)[1].lower() in BINARY_EXT:
            continue
        try:
            if os.path.getsize(path) > 1_500_000:
                continue
            with open(path, encoding="utf-8", errors="replace") as fh:
                for lineno, line in enumerate(fh, 1):
                    if len(line) > 4000:
                        continue
                    for rx, human in COMPILED:
                        if rx.search(line):
                            problems.append((path, lineno, human))
                            break
        except OSError:
            continue

    if not problems:
        print("scan_secrets: секретов в отслеживаемых файлах не найдено (%d файлов)" % len(files))
        return 0
    print("scan_secrets: НАХОДКИ (%d):" % len(problems))
    for path, lineno, human in problems:
        print("  %s:%s — %s" % (path, lineno or "-", human))
    return 1

if __name__ == "__main__":
    sys.exit(main())
