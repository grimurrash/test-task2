#!/usr/bin/env python3
"""PreToolUse: не даёт агенту прочитать или переписать секреты.

Ключевой момент занятия: `deny` в permissions — это шаблон на строку команды.
Запрет `cat secrets.txt` не мешает `python -c "print(open('secrets.txt').read())"`.
Поэтому здесь проверяется не имя команды, а любое упоминание защищённого пути
в любом инструменте — Bash, Read, Edit, Write, Grep, Glob.
"""
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _hooklib as H
from _paths import normalize

HOME = re.escape(os.path.expanduser("~"))

# Что закрыто наглухо.
SECRETS = [
    (r"(?:^|[\s\"'=:(/])\.env(?!\.(?:example|dist|sample|template))(?:\.[\w-]+)?(?:$|[\s\"':,)])", "файл окружения .env"),
    (r"(?:~|" + HOME + r")/\.ssh/", "приватные ключи SSH"),
    (r"\bid_(?:rsa|ed25519|ecdsa|dsa)\b", "приватный ключ SSH"),
    (r"(?:~|" + HOME + r")/\.aws/", "учётные данные AWS"),
    (r"(?:~|" + HOME + r")/\.claude/settings\.json", "глобальные настройки Claude Code"),
    (r"(?:~|" + HOME + r")/\.claude\.json", "глобальный конфиг Claude Code"),
    (r"(?:~|" + HOME + r")/\.claude/history\.jsonl", "история команд Claude Code"),
    (r"\.git-credentials\b", "сохранённые пароли git"),
    (r"\.netrc\b", "учётные данные netrc"),
    (r"\.pgpass\b", "пароли PostgreSQL"),
    (r"(?:^|/)\.npmrc\b", "токены npm"),
    (r"\.(?:pem|p12|pfx|keystore|jks)\b", "файл с ключом или сертификатом"),
    (r"recovery[-_]?codes", "коды восстановления"),
    (r"(?:^|/)(?:secrets?|credentials)\.(?:json|ya?ml|txt|env|php|ini)\b", "файл с секретами"),
    (r"\bsecurity\s+find-(?:generic|internet)-password\b", "связка ключей macOS"),
    # Раньше шаблон ловил любое упоминание слова и блокировал безобидное
    # `rg sudo README.md`. Теперь sudo должен стоять в позиции команды.
    (r"(?:^|[;&|]\s*|\$\(\s*|`\s*)sudo\s", "повышение прав (sudo)"),
]

def main():
    data = H.read_input()
    tool = data.get("tool_name", "")
    for text in H.targets(data):
        if H.allowed(text):
            continue
        # Сравнивается развёрнутая строка: $HOME/.aws/credentials и ~/.aws/credentials
        # это один и тот же файл, и различать их — значит защищать только один.
        haystack = normalize(text)
        for pattern, human in SECRETS:
            if re.search(pattern, haystack, re.I):
                H.decide(
                    "deny",
                    "Заблокировано хуком guard-secrets: попытка обратиться к «%s».\n"
                    "Инструмент: %s\nФрагмент: %s\n"
                    "Это механизм, а не пожелание — сменой команды его не обойти. "
                    "Если доступ действительно нужен, сэр добавит исключение "
                    "в .claude/guard-allow.txt." % (human, tool, text[:200]),
                    guard="guard-secrets",
                )
    H.ok()

main()
