"""Общая обвязка для хуков проекта.

Читает вход хука из stdin, пишет журнал попыток в .claude/logs/guard.jsonl
и формирует решения в формате, который понимает Claude Code.

Журнал — не декорация: отказ, записанный в файл, это и есть доказательство
того, что механизм сработал. Словесный запрет доказать нечем.
"""
import json
import os
import re
import sys
import time

def project_dir():
    return os.environ.get("CLAUDE_PROJECT_DIR") or os.getcwd()

def read_input():
    try:
        return json.load(sys.stdin)
    except Exception:
        return {}

def log(event, payload):
    path = os.path.join(project_dir(), ".claude", "logs", "guard.jsonl")
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        rec = {"ts": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "event": event}
        rec.update(payload)
        with open(path, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(rec, ensure_ascii=False) + "\n")
    except Exception:
        pass

def allowlist():
    """Регулярки из .claude/guard-allow.txt снимают запрет без правки кода."""
    path = os.path.join(project_dir(), ".claude", "guard-allow.txt")
    out = []
    try:
        with open(path, encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if line and not line.startswith("#"):
                    out.append(re.compile(line, re.I))
    except FileNotFoundError:
        pass
    except re.error:
        pass
    return out

def allowed(text):
    return any(rx.search(text) for rx in allowlist())

def decide(decision, reason, guard=""):
    """deny — заблокировать, ask — спросить у сэра, allow — пропустить молча."""
    if decision in ("deny", "ask"):
        log(decision, {"guard": guard, "reason": reason})
    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": decision,
            "permissionDecisionReason": reason,
        }
    }, ensure_ascii=False))
    sys.exit(0)

def ok():
    sys.exit(0)

def targets(data):
    """Строки, которые имеет смысл проверять: команда или путь к файлу."""
    ti = data.get("tool_input") or {}
    out = []
    for key in ("command", "file_path", "notebook_path", "path", "pattern", "glob"):
        val = ti.get(key)
        if isinstance(val, str) and val:
            out.append(val)
    for key in ("edits",):
        val = ti.get(key)
        if isinstance(val, list):
            for item in val:
                if isinstance(item, dict) and isinstance(item.get("file_path"), str):
                    out.append(item["file_path"])
    return out
