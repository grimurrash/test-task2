"""Нормализация путей и команд перед проверкой.

Внешнее ревью показало, чего стоит наивное сравнение строк: `$HOME/.aws/credentials`
не совпадал с шаблоном `~/.aws/`, а `> "../../outside/file"` проходил мимо проверки
границ. Регулярка сравнивала то, что написано, а не то, куда команда попадёт.
"""
import os
import re

HOME = os.path.expanduser("~")

ENV_HOME = re.compile(r"\$\{HOME\}|\$HOME\b|\$\{?USERPROFILE\}?\b")
QUOTES = str.maketrans("", "", "\"'")
SPLIT = re.compile(r"[\s;|&()]+")
REDIRECT = re.compile(r"(?<![0-9<>])>>?\s*(?P<path>(?:[\"'][^\"']+[\"'])|[^\s;|&<>]+)")

def normalize(text):
    """Разворачивает $HOME и ~, снимает кавычки. Строка становится сравнимой."""
    if not text:
        return ""
    out = ENV_HOME.sub(HOME, text)
    out = out.translate(QUOTES)
    out = re.sub(r"(?:^|(?<=[\s=:]))~(?=/|$)", HOME, out)
    return out

def resolve(path, root):
    """Абсолютный путь, куда команда попадёт на самом деле."""
    expanded = os.path.expanduser(normalize(path))
    if not os.path.isabs(expanded):
        expanded = os.path.join(root, expanded)
    return os.path.realpath(expanded)

def path_candidates(command):
    """Всё, что в команде похоже на путь: аргументы, цели перенаправления."""
    normalized = normalize(command)
    found = []
    for match in REDIRECT.finditer(normalized):
        found.append(match.group("path"))
    for token in SPLIT.split(normalized):
        token = token.strip("<>")
        if not token or token.startswith("-"):
            continue
        if "/" in token or token in (".", ".."):
            found.append(token)
    return found
