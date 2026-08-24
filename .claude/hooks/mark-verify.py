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
    if re.search(r"\b(?:FAIL(?:ED|URES)?|ERROR|Tests:\s*\d+\s*failed|✗|not ok)\b", tail[-4000:], re.I):
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
