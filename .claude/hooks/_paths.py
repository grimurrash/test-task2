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

# Признаки намерения записи. Список неполон принципиально — поэтому рядом
# стоит отдельная проверка встроенных интерпретаторов. Живёт здесь, а не в
# отдельном хуке, чтобы граница репозитория и защита файлов правил смотрели
# на команду одинаково: два разных списка разойдутся при первой же правке.
WRITE_INTENT = re.compile(
    r"(?<![0-9<>])>>?(?![>])"                                  # перенаправление вывода
    r"|\b(?:rm|rmdir|unlink|mv|cp|dd|truncate|shred|touch|mkdir|install|rsync|scp)\b"
    r"|\b(?:tee|ln)\b"
    r"|\b(?:chmod|chown|chgrp|xattr)\b"
    r"|\bsed\b[^|;&]*\s-i\b|\bperl\b[^|;&]*\s-[a-z]*i[a-z]*\b"
    r"|\bcurl\b[^|;&]*\s-(?:o|-output)\b|\bwget\b[^|;&]*\s-(?:O|-output-document)\b"
    r"|\bgit\s+(?:clone|init|worktree\s+add)\b"
    r"|\bpatch\b|\bapply\b[^|;&]*\.patch\b",
    re.I)

# Встроенный код нельзя разобрать регуляркой: если он упоминает защищённый путь
# или путь наружу, считаем это записью. Ложный отказ дешевле пропущенной записи.
INLINE_CODE = re.compile(
    r"\b(?:python[\d.]*|python3)\s+-c\b|\bnode\s+-e\b|\bperl\s+-[a-z]*e\b"
    r"|\bruby\s+-e\b|\bphp\s+-r\b|\bosascript\b|\bawk\b[^|;&]*\bprint\s*>",
    re.I)

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

# Токен из одних цифр и слэшей — арифметика, а не путь: `//60` внутри
# python3 -c читался как абсолютный путь и получал отказ. Отбрасывается только
# то, что не начинается с точки или тильды, поэтому `../2` и `./7` остаются
# путями и проверяются: сосед по имени из цифр — обычное дело.
# issue #97: цифра ОБЯЗАТЕЛЬНА. Со звёздочкой группа допускала ноль повторений,
# поэтому токен из одних слэшей подходил под «арифметику» — и корень файловой
# системы выбрасывался из разбора, не доходя до проверки границы. Проверено
# подачей команд всем восьми хукам действующего main: ни один не отказывал
# ни на `rm -rf /`, ни на `chmod -R 777 /`.
#
# Второй раз за день сужение против ложной тревоги сняло защиту там, ради чего
# механизм существует (первый — «токен из слэшей и звёздочек», issue #43).
# Цена обратного хода названа: деление С ПРОБЕЛАМИ внутри встроенного кода
# (`print(a / b)`) даёт токен `/`, и он теперь путь — то есть отказ. Без
# пробелов (`3600//60`, `a/b`) токен остаётся арифметикой, и кейс, ради
# которого правило вводилось, проходит по-прежнему.
DIGITS_ONLY = re.compile(r"^/*(?:\d+/*)+$")

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
        if DIGITS_ONLY.match(token):
            continue
        if "/" in token or token in (".", ".."):
            found.append(token)
    return found
