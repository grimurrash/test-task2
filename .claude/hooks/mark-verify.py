#!/usr/bin/env python3
"""PostToolUse (Bash): отмечает факт прогона тестов и анализаторов.

Гейт качества должен опираться на факт, а не на слова агента о том, что
«всё проверено». Здесь фиксируется, что именно и когда запускалось.

issue #33: несколько ролевых сессий пишут один и тот же verify.json — не
у каждой своя копия (CLAUDE_PROJECT_DIR не различает .worktrees/<роль>,
issue #24). Раньше плоские ключи tests/static/scan затирались чужим
прогоном: сессия A видела «тесты красные», хотя красным был прогон сессии B.
Теперь запись — под ключом session_id внутри verify.json, а не поверх
общих ключей; читает её тем же ключом gate-quality.py.

issue #65: здесь же фиксируется вторая половина факта — правка кода. Раньше
её выводил gate-quality из mtime самого свежего исходника во всём рабочем
дереве, а дерево включает чужие копии в .worktrees/*: из 555 сторожёных
файлов 487 принадлежали соседним сессиям. Сессия, не тронувшая ни строки,
получала требование прогона; координатор, который кода не пишет вовсе, —
на каждом завершении. Признак «код правился» стал событием этой сессии:
правка инструментом или команда с намерением записи в исходник.
"""
import json
import os
import re
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _hooklib as H
from _paths import WRITE_INTENT, path_candidates, strip_heredocs, tokenize

KINDS = [
    (r"\b(?:pytest|phpunit|pest|vitest|jest|mocha|go\s+test|cargo\s+test)\b", "tests"),
    (r"\bnode\s+--test\b|\bnpm\s+(?:run\s+)?test\b|\byarn\s+test\b|\bpnpm\s+test\b", "tests"),
    (r"\bcomposer\s+(?:run-script\s+)?test\b|\bmake\s+test\b|\bscripts/ci/test\.sh\b", "tests"),
    # Собственные тесты репозитория. Без этой строки gate-quality не видит ни один
    # прогон и блокирует завершение любой сессии, где правился код: до появления
    # продукта в проекте нет ни pytest, ни npm test — только эти два способа.
    (r"\bscripts/test_[a-z_]+\.py\b|\bpython3?\s+-m\s+unittest\b", "tests"),
    (r"\b(?:phpstan|psalm|mypy|ruff|eslint|tsc|golangci-lint|php-cs-fixer|phpcs)\b", "static"),
    (r"\bmake\s+(?:lint|analyse|analyze)\b|\bscripts/ci/(?:lint|analyse)\.sh\b", "static"),
    (r"\bscripts/scan_untrusted\.py\b", "scan"),
]

# Записи сессий старше недели чистятся при каждой новой записи — иначе
# verify.json растёт записями сессий, которых давно нет, без каких-либо
# ограничений.
SESSION_TTL = 7 * 24 * 3600

# Что считается кодом. Список тот же, каким его знал gate-quality, когда сам
# обходил дерево: тесты требуются за правку исходника, а не за правку текста.
# Расширять его молча нельзя — каждое новое расширение это новое требование
# прогона к каждой сессии, которая такой файл тронет.
SOURCE_EXT = (".py", ".js", ".ts", ".tsx", ".php", ".go", ".rs", ".java", ".kt", ".sh")

# Интерпретаторы: путь сразу после них — то, что ЗАПУСКАЮТ, а не то, что
# правят. Без этого различения `python3 .claude/hooks/lint-claude-md.py`
# считался правкой хука, стоило в той же строке оказаться символу `>`
# (например, внутри искомой подстроки `'<Имя>'`): признак намерения записи
# срабатывал на тексте, а путь исходника уже лежал среди кандидатов.
# Поймано на этой же сессии, своим же механизмом.
INTERPRETERS = ("python", "python2", "python3", "bash", "sh", "zsh", "node",
                "ruby", "perl", "php", "deno", "bun")

def is_source(path):
    return bool(path) and os.path.splitext(path)[1].lower() in SOURCE_EXT

def launched_paths(command):
    """Пути, которые команда запускает: аргумент сразу после интерпретатора.

    Флаги между интерпретатором и файлом пропускаются (`python3 -u x.py`),
    но `-c`/`-e` прерывают разбор: дальше идёт код, а не имя файла.
    """
    tokens = tokenize(command)
    out = set()
    for i, token in enumerate(tokens):
        if os.path.basename(token) not in INTERPRETERS:
            continue
        for nxt in tokens[i + 1:]:
            if nxt in ("-c", "-e", "-r"):
                break
            if nxt.startswith("-"):
                continue
            out.add(nxt)
            break
    return out

def edited_source(data):
    """Путь исходника, который эта сессия правила прямо сейчас, или None.

    Два способа, потому что править код можно двумя: инструментом правки
    и командой. Для команды одного упоминания пути мало — нужен признак
    намерения записи, иначе `grep -n token backend/app.py` стал бы «правкой»
    и потребовал прогона тестов. Это ровно тот класс ложных отказов, который
    разобран в _paths: признак принимается за свойство, упоминание — за
    использование.
    """
    tool = data.get("tool_name") or ""
    tool_input = data.get("tool_input") or {}

    if tool in ("Write", "Edit", "MultiEdit", "NotebookEdit"):
        path = tool_input.get("file_path") or tool_input.get("notebook_path") or ""
        return path if is_source(path) else None

    if tool == "Bash":
        cmd = strip_heredocs(tool_input.get("command") or "")
        if not cmd or not WRITE_INTENT.search(cmd):
            return None
        launched = launched_paths(cmd)
        for candidate in path_candidates(cmd):
            if is_source(candidate) and candidate not in launched:
                return candidate
    return None

def main():
    data = H.read_input()
    cmd = (data.get("tool_input") or {}).get("command") or ""
    # Тело heredoc — данные, а не команда. Без вырезания сообщение коммита,
    # в котором написано «прогон: python3 scripts/test_hooks.py», отмечалось
    # как настоящий прогон тестов, и гейт после этого считал сессию проверенной.
    # Ошибка в тихую сторону: механизм не мешает, а врёт. Поймано на себе же —
    # отметка о прогоне встала на команду `git commit -F - <<'MSG'`.
    executed = strip_heredocs(cmd)
    kinds = {kind for pattern, kind in KINDS if re.search(pattern, executed, re.I)} if executed else set()
    edited = edited_source(data)
    if not kinds and not edited:
        sys.exit(0)

    resp = data.get("tool_response")
    failed = False
    if isinstance(resp, dict):
        failed = bool(resp.get("is_error")) or bool(resp.get("interrupted"))
        tail = str(resp.get("stdout", "")) + str(resp.get("stderr", ""))
    else:
        tail = str(resp or "")
    # Источник истины о провале — код возврата, он уже учтён в `failed` выше.
    # Текст лишь дополняет его: прогон, съевший свой код возврата через конвейер
    # (`pytest | tail`), иначе прошёл бы как зелёный.
    #
    # Маркеры подобраны так, чтобы не встречаться вне отчёта о провале. Прежний
    # шаблон ловил голые FAILED и ERROR и дважды за день пометил зелёный прогон
    # красным: сначала на печати поля `failed=False`, потом на заголовке теста,
    # в котором стояло слово FAILED. Ложная тревога обесценивает механизм так же
    # верно, как пропуск: гейт, который врёт, начинают обходить.
    FAILURE_MARKERS = (
        # pytest, jest, vitest: «1 failed, 4 passed». Хвост (?!\s*=) отсекает печать
        # самого состояния: строка «19:21:30 failed = True» из вывода этого же
        # механизма иначе читается как «30 failed» и метит зелёный прогон красным.
        r"\d+\s+failed\b(?!\s*=)"
        r"|\bFAILURES!"            # PHPUnit
        r"|\bFailures:\s*[1-9]"    # PHPUnit, сводка
        r"|---\s*FAIL[:\s]"        # go test
        r"|#\s*fail\s+[1-9]"       # node:test, TAP-сводка
        r"|\bnot ok\b"             # TAP
        r"|✗"                      # собственные проверки репозитория
        r"|ПРОВАЛОВ:\s*[1-9]"      # scripts/test_hooks.py
    )
    # Провал ПРАВКИ — только код возврата инструмента, без разбора текста.
    # Маркеры выше читают отчёт прогонщика; в ответе правки на их месте лежит
    # содержимое файла, и правка теста, где написано «✗», иначе считалась бы
    # неудавшейся — то есть код правился, а требование прогона не выставлялось.
    # Ошибка в тихую сторону, худшую из двух.
    edit_failed = bool(resp.get("is_error")) if isinstance(resp, dict) else False
    if re.search(FAILURE_MARKERS, tail[-4000:]):
        failed = True

    session_id = data.get("session_id") or "unknown"
    now = time.time()
    human = time.strftime("%Y-%m-%d %H:%M:%S")
    record = {
        kind: {
            "ts": now,
            "human_ts": human,
            "command": cmd[:300],
            "failed": failed,
        }
        for kind in kinds
    }
    # Правка, которая не удалась, правкой не считается: инструмент вернул
    # ошибку, файл остался прежним, и требовать за него прогон — та же ложная
    # тревога, только с другой стороны.
    if edited and not edit_failed:
        record["edited"] = {"ts": now, "human_ts": human, "path": edited[:300]}

    def mutate(state):
        # Плоский формат до issue #33 (ключи tests/static/scan прямо на
        # верхнем уровне) выбрасывается при первой же записи в новом
        # формате — это чужие, уже не относящиеся ни к одной сессии данные,
        # держать их дальше значило бы читать их же по ошибке снова.
        state.pop("tests", None)
        state.pop("static", None)
        state.pop("scan", None)
        sessions = state.setdefault("sessions", {})
        sessions.setdefault(session_id, {}).update(record)
        stale = [
            sid for sid, rec in sessions.items()
            if max((v.get("ts", 0) for v in rec.values()), default=0) < now - SESSION_TTL
        ]
        for sid in stale:
            del sessions[sid]

    # issue #54: пишем туда, куда указано, а не туда, что проверяем. В обычной
    # сессии это одно и то же; набор тестов уводит запись к себе, чтобы отметка
    # о выдуманном прогоне не попадала в боевой verify.json и не стирала чужую.
    path = H.state_path("verify.json")
    H.update_json_state(path, mutate)
    sys.exit(0)

main()
