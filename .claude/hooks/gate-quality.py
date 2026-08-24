#!/usr/bin/env python3
"""Stop: не даёт объявить работу законченной без доказательств.

Проверяется три вещи: тесты после последней правки кода, отсутствие
незакоммиченных изменений и отсутствие красного прогона. Если что-то из
этого не так — сессия не закрывается, и в контекст уходит причина.

Гейт срабатывает один раз на условие: повторный Stop с той же причиной
в течение десяти минут пропускается, чтобы не зациклить работу.
"""
import hashlib
import json
import os
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _hooklib as H

SOURCE_SKIP = (".claude/logs", ".claude/state", ".git", "node_modules", "vendor")
COOLDOWN = 600

def git(root, *args):
    try:
        out = subprocess.run(["git", "-C", root] + list(args),
                             capture_output=True, text=True, timeout=15)
        return out.stdout.strip()
    except Exception:
        return ""

def newest_source_mtime(root):
    newest = 0.0
    for dirpath, dirnames, filenames in os.walk(root):
        rel = os.path.relpath(dirpath, root)
        if any(rel == s or rel.startswith(s) for s in SOURCE_SKIP):
            dirnames[:] = []
            continue
        dirnames[:] = [d for d in dirnames if d not in (".git", "node_modules", "vendor", "__pycache__")]
        for name in filenames:
            if os.path.splitext(name)[1].lower() not in (
                    ".py", ".js", ".ts", ".tsx", ".php", ".go", ".rs", ".java", ".kt", ".sh"):
                continue
            try:
                newest = max(newest, os.path.getmtime(os.path.join(dirpath, name)))
            except OSError:
                pass
    return newest

def main():
    data = H.read_input()
    if data.get("stop_hook_active"):
        sys.exit(0)

    root = os.path.realpath(H.project_dir())
    if not os.path.isdir(os.path.join(root, ".git")):
        sys.exit(0)

    problems = []

    dirty = git(root, "status", "--porcelain")
    if dirty:
        count = len([ln for ln in dirty.splitlines() if ln.strip()])
        problems.append("незакоммиченных изменений: %d (git status --porcelain непустой)" % count)

    state = {}
    try:
        with open(os.path.join(root, ".claude", "state", "verify.json"), encoding="utf-8") as fh:
            state = json.load(fh)
    except Exception:
        pass

    code_ts = newest_source_mtime(root)
    tests = state.get("tests")
    if code_ts > 0:
        if not tests:
            problems.append("тесты в этой сессии не запускались ни разу")
        elif tests.get("ts", 0) < code_ts:
            problems.append("код правился после последнего прогона тестов (%s)" % tests.get("human_ts"))
        elif tests.get("failed"):
            problems.append("последний прогон тестов был красным: %s" % tests.get("command"))

    static = state.get("static")
    if static and static.get("failed"):
        problems.append("последний прогон анализаторов был красным: %s" % static.get("command"))

    if not problems:
        sys.exit(0)

    signature = hashlib.sha1("|".join(problems).encode()).hexdigest()
    marker = os.path.join(root, ".claude", "state", "gate-last-block.json")
    try:
        with open(marker, encoding="utf-8") as fh:
            last = json.load(fh)
        if last.get("signature") == signature and time.time() - last.get("ts", 0) < COOLDOWN:
            sys.exit(0)
    except Exception:
        pass
    os.makedirs(os.path.dirname(marker), exist_ok=True)
    with open(marker, "w", encoding="utf-8") as fh:
        json.dump({"signature": signature, "ts": time.time()}, fh)

    reason = ("Гейт качества не пропускает завершение. Незакрытые пункты:\n" +
              "\n".join("  · " + p for p in problems) +
              "\nЛибо закройте их, либо скажите сэру прямым текстом, что осталось "
              "невыполненным, — но не объявляйте работу законченной.")
    H.log("gate-block", {"guard": "gate-quality", "problems": problems})
    print(json.dumps({"decision": "block", "reason": reason}, ensure_ascii=False))
    sys.exit(0)

main()
