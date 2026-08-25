"""Нормализация путей и команд перед проверкой.

Внешнее ревью показало, чего стоит наивное сравнение строк: `$HOME/.aws/credentials`
не совпадал с шаблоном `~/.aws/`, а `> "../../outside/file"` проходил мимо проверки
границ. Регулярка сравнивала то, что написано, а не то, куда команда попадёт.

issue #43: обратная сторона той же строгости — восемь известных ложных отказов
за день, все одного класса: путеподобная строка **упомянута**, а не использована.
Здесь разбирается класс, а не случаи. Правило разбора одно: сужать по структуре
команды (тело heredoc, чужая файловая система, форма токена), а не по содержимому
пути — содержимое подделывается, структура нет. На каждое сужение в
`scripts/test_hooks.py` стоит парная проверка, что настоящий выход наружу
по-прежнему отклоняется; без неё сужение незаметно становится ослаблением.
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
    """Разворачивает $HOME и ~, снимает кавычки, вырезает тела heredoc.
    Строка становится сравнимой.

    Вырезание heredoc живёт здесь, а не в каждом хуке отдельно: на команду
    смотрят трое (граница репозитория, защита файлов правил, защита истории),
    и текст, который команда пишет в файл, для всех троих одинаково является
    данными. Иначе один и тот же класс ложных тревог пришлось бы чинить
    в трёх местах — и он уже проявился в двух (issue #43, случаи 7 и 8).
    """
    if not text:
        return ""
    out = strip_heredocs(text)
    out = ENV_HOME.sub(HOME, out)
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
DIGITS_ONLY = re.compile(r"^/*(?:\d+/*)*$")

# Токен из слэшей и звёздочек — glob-шаблон, а не путь: строка `/**` внутри
# скрипта читалась как абсолютный путь наружу (issue #43, случай 3). Настоящий
# путь с подстановкой (`/outside/*.txt`) содержит и обычные символы, поэтому
# под это правило не подпадает и проверяется как раньше.
GLOB_ONLY = re.compile(r"^[/*]+$")

# Тело heredoc — данные, которые команда ПИШЕТ, а не путь, по которому она
# пишет. Четыре из восьми ложных отказов issue #43 — отсюда: текст задания,
# журнальная запись, тело PR, комментарий с путём в прозе. Тот же разбор уже
# стоял в guard-git (issue #20) — здесь он вынесен в общий модуль, чтобы
# граница репозитория и защита файлов правил смотрели на команду одинаково.
#
# Понимает одиночный `<<DELIM` / `<<-DELIM` / `<<'DELIM'` / `<<"DELIM"` на
# строку. Несколько heredoc в одной команде и вложенные — не разбирает: тогда
# текст просто не вырезается, то есть худший исход — прежний ложный отказ,
# а не пропуск записи.
HEREDOC_OPEN = re.compile(r"<<-?\s*(['\"]?)([A-Za-z_][A-Za-z0-9_]*)\1")

def strip_heredocs(command):
    """Команда без тел heredoc-документов: остаётся то, что она исполняет.

    Вырезается только ЗАКРЫТЫЙ документ — тот, у которого найдена метка конца.
    Открытая метка без закрывающей оставляется как есть: иначе всё до конца
    команды считалось бы данными, и настоящая команда, идущая следом, исчезала
    бы из проверки. Это не теория — поймано парным тестом issue #43 на второй
    же минуте: `cat > f <<'EOF' … EOF`, а следом `echo x > ../../outside/file`
    проходили как безобидные, потому что функция применялась дважды и на
    втором проходе закрывающей метки уже не было.

    Как следствие функция идемпотентна: повторный прогон ничего не меняет.
    """
    if "<<" not in command:
        return command
    lines = command.split("\n")
    out = []
    i = 0
    while i < len(lines):
        line = lines[i]
        out.append(line)
        m = HEREDOC_OPEN.search(line)
        i += 1
        if not m:
            continue
        delim = m.group(2)
        end = i
        while end < len(lines) and lines[end].strip() != delim:
            end += 1
        if end >= len(lines):
            continue          # метка конца не найдена — тело не вырезаем
        i = end + 1           # пропустить тело вместе со строкой-меткой
    return "\n".join(out)

# Пути после docker/podman относятся к файловой системе КОНТЕЙНЕРА и к границе
# хоста отношения не имеют (issue #43, случай 4). Единственное исключение —
# источник тома: в `-v /host/path:/container/path` левая половина реальна,
# и её проверять обязательно, иначе сужение стало бы дырой.
CONTAINER_CMD = re.compile(r"(?:^|[;&|]\s*)(?:sudo\s+)?(?:docker|podman)\s+", re.I)
VOLUME_FLAG = re.compile(r"(?:^|\s)(?:-v|--volume|--mount)(?:=|\s+)(?P<spec>[^\s]+)")

def container_scope(command):
    """(есть ли docker-команда, пути-источники томов). Пути внутри контейнера
    в кандидаты не попадают — но источники томов попадают."""
    if not CONTAINER_CMD.search(command):
        return False, []
    sources = []
    for m in VOLUME_FLAG.finditer(command):
        spec = m.group("spec")
        if spec.startswith("type="):          # --mount type=bind,source=...
            for part in spec.split(","):
                if part.startswith(("source=", "src=")):
                    sources.append(part.split("=", 1)[1])
            continue
        head = spec.split(":", 1)[0]          # -v /host/path:/container/path
        if head:
            sources.append(head)
    return True, sources

def path_candidates(command):
    """Всё, что в команде похоже на путь: аргументы, цели перенаправления.

    Из разбора исключается то, что путём не является: тела heredoc (данные),
    glob-токены и — для docker/podman — пути внутри контейнера, кроме
    источников примонтированных томов.
    """
    normalized = normalize(command)          # уже без тел heredoc
    is_container, volume_sources = container_scope(normalized)
    found = [normalize(src) for src in volume_sources]
    if is_container:
        # Аргументы docker-команды описывают чужую файловую систему; проверять
        # в ней нечего. Перенаправления и тома уже учтены отдельно.
        for match in REDIRECT.finditer(normalized):
            found.append(match.group("path"))
        return found
    for match in REDIRECT.finditer(normalized):
        found.append(match.group("path"))
    for token in SPLIT.split(normalized):
        token = token.strip("<>")
        if not token or token.startswith("-"):
            continue
        if DIGITS_ONLY.match(token) or GLOB_ONLY.match(token):
            continue
        if "/" in token or token in (".", ".."):
            found.append(token)
    return found
