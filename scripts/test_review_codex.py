#!/usr/bin/env python3
"""Проверка внешнего ревьюера на путях отказа.

Сам вердикт внешней модели здесь не проверяется — он стоит денег и требует
авторизации. Проверяется другое, и оно важнее: обёртка обязана деградировать
предсказуемо. Ревьюер, который молча исчез, опаснее ревьюера, которого нет:
в первом случае отчёт выглядит проверенным, будучи непроверенным.

    python3 scripts/test_review_codex.py
"""
import json
import os
import subprocess
import sys

ROOT = os.path.realpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
SCRIPT = os.path.join(ROOT, "scripts", "review_codex.py")

CASES = [
    ("codex не установлен", ["проверь что-нибудь"], {"CODEX_BIN": "/nonexistent/codex"}),
    ("задание пустое", [""], {}),
    ("codex есть, но не авторизован", ["проверь что-нибудь"], {"CODEX_BIN": "/usr/bin/true"}),
]

def main():
    failures = 0
    print("Проверка scripts/review_codex.py на путях отказа\n")
    for title, args, extra_env in CASES:
        env = dict(os.environ)
        env.update(extra_env)
        proc = subprocess.run([sys.executable, SCRIPT] + args,
                              capture_output=True, text=True, env=env, timeout=60)
        ok = proc.returncode == 3
        reason = ""
        try:
            data = json.loads(proc.stdout)
            ok = ok and data.get("verdict") == "unavailable" and bool(data.get("summary"))
            ok = ok and data.get("findings") == []
            reason = data.get("summary", "")
        except json.JSONDecodeError:
            ok = False
            reason = "stdout не JSON: " + proc.stdout[:120]
        failures += 0 if ok else 1
        print("  %s %-32s код %d · %s" % ("✓" if ok else "✗", title, proc.returncode, reason[:90]))

    print("\n%s" % ("ВСЁ ЗЕЛЁНОЕ" if failures == 0 else "ПРОВАЛОВ: %d" % failures))
    return 1 if failures else 0

if __name__ == "__main__":
    sys.exit(main())
