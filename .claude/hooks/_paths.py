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
    r"|\bruby\s+-e\b|\bphp\s+-r\b|\bosascript\b|\bawk\b[^|;&]*\bprint\s*>"
    # Код, поданный интерпретатору документом (`python3 - <<'PY'`, `bash <<'SH'`),
    # — тот же встроенный код, только другой формы. Без этой строки тело
    # оставалось в команде (см. heredoc_body_is_data), но хук выходил раньше,
    # чем до него добирался: ни перенаправления, ни знакомой команды записи
    # в строке нет. Найдено на ревью PR #53 (issue #43).
    r"|(?:^|[;&|]\s*)(?:sudo\s+)?(?:(?:ba|z|k|da|c)?sh|python[\d.]*|node|deno|bun"
    r"|perl|ruby|php|osascript)\b[^\n]*<<",
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

# Тело heredoc — данные ТОЛЬКО если получатель его записывает (`cat > file`,
# `gh pr create --body-file -`). Если получатель — интерпретатор, тело
# ИСПОЛНЯЕТСЯ, и вырезать его значит убрать из проверки настоящий код.
# Найдено на ревью PR #53 (issue #43): `python3 - <<'PY' … PY` писал наружу,
# `bash <<'SH'` удалял наружу, а через `guard-secrets` тем же приёмом читался
# `.env` — то есть обход, ради которого хук и заведён, менял форму и проходил.
# Проверяется первый токен строки-открывашки и токены после конвейера: важна
# позиция команды, а не упоминание слова (`cat > bash-notes.md <<'EOF'` пишет
# файл, а не исполняет).
INTERPRETER = re.compile(
    r"(?:^|[;&|]\s*)(?:sudo\s+)?(?:env\s+\S+\s+)*"
    r"(?:(?:ba|z|k|da|c)?sh|python[\d.]*|node|deno|bun|perl|ruby|php|osascript|awk|xargs)"
    r"\b", re.I)

def heredoc_body_is_data(opening_line):
    """True, если тело документа получатель запишет, а не исполнит."""
    return not INTERPRETER.search(opening_line)

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
        if not heredoc_body_is_data(line):
            continue          # тело исполняется — оставляем его под проверку
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
# Проверяется НАЧАЛО стадии, а не вся команда. Первая версия искала docker
# по всей строке и, найдя, сужала разбор целиком: `docker compose up -d &&
# rm -rf <наружу>` проходил границу — удаление оказывалось «аргументом
# контейнера». Найдено на ревью PR #53 (issue #43).
CONTAINER_CMD = re.compile(r"^\s*(?:sudo\s+)?(?:docker|podman)\s+", re.I)

# Границы стадий: каждая проверяется отдельно, чтобы сужение одной стадии
# не распространялось на соседние.
STAGE_SPLIT = re.compile(r"\|\||&&|[;&|\n]")
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
    normalized = normalize(command)          # уже без тел «пишущих» heredoc
    found = []
    # Разбор идёт постадийно: сужение, законное для одной стадии, не должно
    # распространяться на соседнюю. `docker compose up && rm -rf <наружу>` —
    # две разные команды, и вторая обязана проверяться полностью.
    for stage in STAGE_SPLIT.split(normalized):
        if not stage.strip():
            continue
        # Перенаправления реальны в любой стадии, включая docker: `docker ps >
        # /outside/file` пишет на хост, а не в контейнер.
        for match in REDIRECT.finditer(stage):
            found.append(match.group("path"))
        is_container, volume_sources = container_scope(stage)
        if is_container:
            # Остальные аргументы описывают файловую систему контейнера;
            # проверять в ней нечего. Источники томов — реальные пути хоста.
            found.extend(volume_sources)
            continue
        for token in SPLIT.split(stage):
            token = token.strip("<>")
            if not token or token.startswith("-"):
                continue
            if DIGITS_ONLY.match(token) or GLOB_ONLY.match(token):
                continue
            if "/" in token or token in (".", ".."):
                found.append(token)
    return found
