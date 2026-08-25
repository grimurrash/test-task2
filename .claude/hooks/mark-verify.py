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
"""
import json
import os
import re
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _hooklib as H

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

def main():
    data = H.read_input()
    cmd = (data.get("tool_input") or {}).get("command") or ""
    if not cmd:
        sys.exit(0)
    kinds = {kind for pattern, kind in KINDS if re.search(pattern, cmd, re.I)}
    if not kinds:
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
    if re.search(FAILURE_MARKERS, tail[-4000:]):
        failed = True

    session_id = data.get("session_id") or "unknown"
    now = time.time()
    record = {
        kind: {
            "ts": now,
            "human_ts": time.strftime("%Y-%m-%d %H:%M:%S"),
            "command": cmd[:300],
            "failed": failed,
        }
        for kind in kinds
    }

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

    path = os.path.join(H.project_dir(), ".claude", "state", "verify.json")
    H.update_json_state(path, mutate)
    sys.exit(0)

main()
