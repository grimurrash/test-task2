#!/usr/bin/env python3
"""PreToolUse (Bash): защита истории и защищённых веток.

Правила сэра из ~/.claude/CLAUDE.md переведены из текста в механизм:
force-push в master/main/develop запрещён, чужие коммиты не переписываем,
ветки без спроса не заводим.

issue #20: правило «в main только через pull request» держалось на тексте
команды — искало буквальное имя защищённой ветки после `git push`. Голый
`git push` (и его формы без явного адресата — `git push origin HEAD`,
`git push --all`, `git push -u origin @`) ветку не называют вовсе: она берётся
из HEAD и upstream, а не из текста. Хук такие формы не ловил, и коммит ушёл
в origin/main мимо PR. Текстовые формы принципиально не закрываются
перечислением — за день их обошли одиннадцать раз в обе стороны. Ниже
добавлена вторая проверка: не по тексту, а по факту — `git rev-parse
--abbrev-ref HEAD` в директории, где реально выполнится команда. Проверка по
имени ветки в тексте не убрана — она одна ловит `git push origin
<чужая-ветка>:main`, где push не с HEAD.
"""
import os
import re
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _hooklib as H

PROTECTED = r"(?:master|main|develop|release/[\w.\-/]+)"
PROTECTED_NAME = re.compile(r"^" + PROTECTED + r"$")

# Позиция имеет значение — тот же приём, что в guard-protected-files и
# scan-untrusted (issue #6): команда должна стоять на месте запуска (начало
# строки или после `; & | \n`), а не быть просто упомянутой в тексте. Без
# этого якоря `git commit -m "баг: голый git push уходит в main"` получал бы
# отказ за собственное описание — ровно то, что сегодня и случилось.
CMD_POS = r"(?:^\s*|[;&|\n]\s*)"

# Текст, а не команда: `cat > file <<'EOF' ... EOF` пишет данные в файл, а то,
# что внутри, может дословно совпасть с формой настоящего push (issue #20 —
# хук уже отказал команде, которая просто описывала этот баг в файле). Тело
# heredoc вырезается перед любой проверкой этого хука — иначе якорь по `\n`
# выше сам стал бы источником той же ложной тревоги: строка heredoc-тела тоже
# начинается «после \n».
#
# Понимает одиночный `<<DELIM` / `<<-DELIM` / `<<'DELIM'` / `<<"DELIM"` на
# строку. Несколько heredoc-документов в одной команде и вложенные heredoc —
# не разбирает; в таком случае текст просто не вырезается, как и раньше.
HEREDOC_OPEN = re.compile(r"<<-?\s*(['\"]?)([A-Za-z_][A-Za-z0-9_]*)\1")

def strip_heredocs(cmd):
    if "<<" not in cmd:
        return cmd
    lines = cmd.split("\n")
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
        while i < len(lines) and lines[i].strip() != delim:
            i += 1
        i += 1  # пропустить и строку с самим delim, если она нашлась
    return "\n".join(out)

DENY = [
    (r"\bgit\s+push\b[^|;&]*\s(?:--force\b|-f\b)(?![\w-])", "force-push"),
    (r"\bgit\s+push\b[^|;&]*--force-with-lease\b[^|;&]*\s" + PROTECTED, "force-with-lease в защищённую ветку"),
    (r"\bgit\s+push\b[^|;&]*\s\+[\w./-]*" + PROTECTED, "push с перезаписью (refspec с +)"),
    (r"\bgit\s+push\b[^|;&]*--mirror\b", "push --mirror переписывает всё"),
    (r"\bgit\s+filter-branch\b", "переписывание истории"),
    (r"\bgit\s+filter-repo\b", "переписывание истории"),
    (r"\bgit\s+reflog\s+expire\b", "уничтожение reflog"),
    (r"\bgit\s+update-ref\s+-d\b", "удаление ссылки напрямую"),
    (r"\bgit\s+(?:commit|push|merge)\b[^|;&]*--no-verify\b", "обход собственных проверок"),
    (r"\bgit\s+branch\s+(?:-D|--delete\s+--force)\s+" + PROTECTED, "удаление защищённой ветки"),
    (r"\bgit\s+config\b[^|;&]*\bcore\.hooksPath\b", "подмена пути хуков git"),
]

# Операции, которые раньше спрашивали подтверждения. Теперь каждая привязана
# к зоне пропуска: «ask» в неинтерактивной сессии пропускает команду, поэтому
# барьером служит отказ, а разрешение выдаётся заранее через scripts/unlock.sh.
CONFIRM = [
    # Явное имя защищённой ветки в тексте — и как отдельный аргумент
    # (`git push origin main`), и как адресат refspec через двоеточие
    # (`git push origin рабочая-ветка:main`, `git push origin <sha>:main`).
    # Раньше распознавался только первый вариант: `\s` перед именем ветки
    # не совпадал с двоеточием, и push чужого коммита в main проходил.
    (r"%sgit\s+push\b[^;&|\n]*[\s:](?:origin\s+)?%s\b" % (CMD_POS, PROTECTED),
     "прямой push в защищённую ветку (обычно нужен PR)", "git-push-main"),
    (r"\bgit\s+reset\s+--hard\b",
     "git reset --hard выбрасывает несохранённую работу", "git-history"),
    (r"\bgit\s+clean\s+-[\w]*f",
     "git clean -f удаляет неотслеживаемые файлы", "git-history"),
    (r"\bgit\s+checkout\s+-b\b|\bgit\s+switch\s+-c\b",
     "создание новой ветки", "git-branch"),
    (r"\bgit\s+worktree\s+(?:add|remove)\b",
     "операция с worktree", "git-worktree"),
]

# Голый push и его формы без явного адресата — issue #20. Захватывает всё
# после `git push` до конца той же логической команды, чтобы разобрать
# аргументы отдельно (push_is_ambiguous), а не гадать регуляркой на все формы
# сразу.
PUSH_SEGMENT = re.compile(CMD_POS + r"git\s+push\b(?P<rest>[^;&|\n]*)", re.I)

def push_is_ambiguous(rest):
    """True, если `git push <rest>` не называет ветку явно и, по семантике
    `git push [<repository>] [<refspec>...]`, реально толкает текущую ветку —
    HEAD. Без аргументов, только remote, либо буквальные `HEAD`/`@` вторым
    аргументом — ветка нигде не написана, отвечает HEAD. Явный refspec —
    с двоеточием или простым именем — не этот случай: если адресат защищён,
    его ловит проверка по имени ветки выше; если нет, команда легитимна
    независимо от того, где сейчас HEAD.
    """
    args = [tok for tok in rest.split() if not tok.startswith("-")]
    if not args:
        return True
    if len(args) == 1:
        return True
    if len(args) == 2 and args[1] in ("HEAD", "@"):
        return True
    return False

def current_branch(cwd):
    """Ветка HEAD рабочего дерева, где реально выполнится команда — факт,
    а не текст. `cwd` берётся из события хука: несколько ролей одновременно
    работают в разных `.worktrees/*`, и у каждой свой HEAD.

    detached HEAD или сбой git (чужой cwd, не репозиторий, git не найден) —
    None. Здесь это не блокирует push: проверка по факту — дополнение
    к проверке по имени ветки, а не замена, и на сбое молчит, оставляя
    решение той, текстовой проверке.
    """
    try:
        proc = subprocess.run(
            ["git", "rev-parse", "--abbrev-ref", "HEAD"],
            cwd=cwd, capture_output=True, text=True, timeout=5,
        )
    except Exception:
        return None
    if proc.returncode != 0:
        return None
    name = (proc.stdout or "").strip()
    return name if name and name != "HEAD" else None

def main():
    data = H.read_input()
    cmd = (data.get("tool_input") or {}).get("command") or ""
    if not cmd or H.allowed(cmd):
        H.ok()

    cmd_clean = strip_heredocs(cmd)

    for pattern, human in DENY:
        if re.search(pattern, cmd_clean, re.I):
            H.decide(
                "deny",
                "Заблокировано хуком guard-git: %s.\nКоманда: %s\n"
                "Правило сэра: force-push в master/main/develop и перезапись чужих "
                "коммитов запрещены во всех режимах." % (human, cmd[:300]),
                guard="guard-git",
            )

    # Голый/неоднозначный push — проверка по факту (issue #20). Дороже текстовой
    # (реальный вызов git), поэтому запускается только когда в команде вообще
    # есть push без явно названной ветки — не на каждый Bash-вызов подряд.
    if any(push_is_ambiguous(m.group("rest")) for m in PUSH_SEGMENT.finditer(cmd_clean)):
        branch = current_branch(data.get("cwd") or H.project_dir())
        if branch and PROTECTED_NAME.match(branch):
            H.confirm(
                "git-push-main",
                "Заблокировано хуком guard-git: push без явного имени ветки "
                "при HEAD рабочего дерева на защищённой ветке «%s» (обычно нужен PR).\n"
                "Команда: %s" % (branch, cmd[:300]),
                guard="guard-git",
            )

    for pattern, human, zone in CONFIRM:
        if re.search(pattern, cmd_clean, re.I):
            H.confirm(
                zone,
                "Заблокировано хуком guard-git: %s.\nКоманда: %s" % (human, cmd[:300]),
                guard="guard-git",
            )
    H.ok()

main()
