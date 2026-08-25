#!/usr/bin/env python3
"""PostToolUse (Bash): отмечает факт прогона тестов и анализаторов.

Гейт качества должен опираться на факт, а не на слова агента о том, что
«всё проверено». Здесь фиксируется, что именно и когда запускалось.
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

    path = os.path.join(H.project_dir(), ".claude", "state", "verify.json")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    state = {}
    try:
        with open(path, encoding="utf-8") as fh:
            state = json.load(fh)
    except Exception:
        state = {}
    for kind in kinds:
        state[kind] = {
            "ts": time.time(),
            "human_ts": time.strftime("%Y-%m-%d %H:%M:%S"),
            "command": cmd[:300],
            "failed": failed,
        }
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(state, fh, ensure_ascii=False, indent=1)
    sys.exit(0)

main()
