"""Общая обвязка для хуков проекта.

Читает вход хука из stdin, пишет журнал попыток в .claude/logs/guard.jsonl
и формирует решения в формате, который понимает Claude Code.

Журнал — не декорация: отказ, записанный в файл, это и есть доказательство
того, что механизм сработал. Словесный запрет доказать нечем.
"""
import json
import os
import re
import subprocess
import sys
import time

try:
    import fcntl
except ImportError:  # POSIX-only механизм; проект и так держится на bash и git
    fcntl = None

def project_dir():
    return os.environ.get("CLAUDE_PROJECT_DIR") or os.getcwd()

def update_json_state(path, mutate):
    """Читает JSON-состояние (или {} при отсутствии/повреждении), даёт
    mutate(dict) изменить его на месте и пишет обратно под эксклюзивной
    блокировкой (issue #33).

    Несколько ролевых сессий, читающих-меняющих-пишущих один файл
    состояния параллельно (например, .claude/state/verify.json), без
    блокировки теряют чужие правки — классический lost update: обе
    прочитали одно и то же, обе дописали своё, вторая запись стирает
    первую. Сама запись идёт во временный файл рядом и переименовывается
    (`os.replace`, атомарно на POSIX в пределах одной файловой системы) —
    поэтому читающему без блокировки никогда не достанется недописанный
    JSON, и лочить чтение не требуется.

    Общий помощник, не привязан к конкретному файлу состояния — годится
    и для будущих случаев того же класса. Сегодня используется только
    для verify.json; unlock.json, guard.jsonl и untrusted.jsonl этим не
    переведены сознательно (issue #33: там общее состояние может быть
    замыслом, не поломкой, и это отдельное решение).
    """
    os.makedirs(os.path.dirname(path), exist_ok=True)
    lock_fh = None
    try:
        lock_fh = open(path + ".lock", "a+")
        if fcntl:
            fcntl.flock(lock_fh, fcntl.LOCK_EX)
    except OSError:
        lock_fh = None
    try:
        state = {}
        try:
            with open(path, encoding="utf-8") as fh:
                state = json.load(fh)
        except Exception:
            state = {}
        mutate(state)
        tmp_path = "%s.tmp-%d" % (path, os.getpid())
        with open(tmp_path, "w", encoding="utf-8") as fh:
            json.dump(state, fh, ensure_ascii=False, indent=1)
        os.replace(tmp_path, path)
    finally:
        if lock_fh:
            if fcntl:
                try:
                    fcntl.flock(lock_fh, fcntl.LOCK_UN)
                except OSError:
                    pass
            lock_fh.close()

def repo_root(cwd=None):
    """Корень ОСНОВНОЙ копии репозитория — общий для неё и для всех linked
    worktree (issue #24). `git rev-parse --git-common-dir` возвращает путь
    к `.git` основной копии независимо от того, откуда его спросили: внутри
    `.worktrees/<роль>` `.git` — файл-указатель на приватный gitdir, а не
    папка, и всё, что раньше проверяло «это корень» через `project_dir()`
    (`CLAUDE_PROJECT_DIR` или `os.getcwd()`), могло получить границей сам
    worktree — `../сосед` относительно него формально остаётся «внутри».

    В живой сессии `CLAUDE_PROJECT_DIR` эмпирически не меняется при `cd`
    агента в worktree — проверено отладочным прогоном на двух параллельных
    ролях сразу. Но полагаться на то, что так будет всегда, — держать границу
    на допущении о поведении обвязки, а не на факте о репозитории; здесь
    вместо допущения — прямой вопрос git.

    Сбой (не репозиторий, git не найден, таймаут) — откат к `project_dir()`:
    без общего корня разговора нет, но и молчать не резон.
    """
    base = cwd or project_dir()
    try:
        proc = subprocess.run(
            ["git", "rev-parse", "--git-common-dir"],
            cwd=base, capture_output=True, text=True, timeout=5,
        )
    except Exception:
        return os.path.realpath(base)
    if proc.returncode != 0:
        return os.path.realpath(base)
    common_dir = proc.stdout.strip()
    if not common_dir:
        return os.path.realpath(base)
    if not os.path.isabs(common_dir):
        common_dir = os.path.join(base, common_dir)
    return os.path.dirname(os.path.realpath(common_dir))

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

UNLOCK_PATH = (".claude", "state", "unlock.json")

def unlock_active(zone):
    """Действующий пропуск для зоны или None.

    Решение «ask» зависит от того, покажет ли среда диалог. В неинтерактивной
    сессии диалога нет, и «ask» молча пропускает команду — проверено 2026-08-25:
    правка защищённого хука и создание ветки прошли, оставив в журнале только след.
    Поэтому подтверждение здесь не спрашивается, а выдаётся заранее и с истечением:
    сэр открывает зону командой scripts/unlock.sh, хук её видит.
    """
    path = os.path.join(project_dir(), *UNLOCK_PATH)
    try:
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
    except Exception:
        return None
    rec = data.get(zone)
    if not isinstance(rec, dict):
        return None
    try:
        if float(rec.get("until", 0)) < time.time():
            return None
    except (TypeError, ValueError):
        return None
    return rec

def confirm(zone, reason, guard=""):
    """Действие, которое раньше спрашивало подтверждения: пропуск или отказ.

    Пропускает молча, если зона открыта, и записывает факт использования:
    открытая зона без следа в журнале — это дыра, а не удобство.
    """
    rec = unlock_active(zone)
    if rec:
        log("unlock-used", {"guard": guard, "zone": zone,
                            "reason": reason.split("\n")[0],
                            "unlock_reason": rec.get("reason", ""),
                            "until": rec.get("human_until", "")})
        sys.exit(0)
    decide(
        "deny",
        "%s\n\nПодтверждение здесь не спрашивается: решение «ask» в неинтерактивной "
        "сессии пропускает команду, оставляя лишь запись в журнале. Барьером остаётся "
        "только отказ.\n\nЕсли это осознанно, сэр открывает зону в своём терминале:\n"
        "    bash scripts/unlock.sh %s 15 \"зачем\"\n"
        "Пропуск действует указанное число минут, привязан к зоне «%s» и каждое "
        "его использование попадает в .claude/logs/guard.jsonl." % (reason, zone, zone),
        guard=guard,
    )

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
