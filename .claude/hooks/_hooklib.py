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
import traceback

try:
    import fcntl
except ImportError:  # POSIX-only механизм; проект и так держится на bash и git
    fcntl = None

def project_dir():
    # os.getcwd() бросает FileNotFoundError, если каталог удалён из-под процесса.
    # Раньше это был код 1, то есть тихий пропуск; теперь любое исключение —
    # отказ (issue #156), и незакрытое место остановило бы работу целиком.
    # Отсюда откат на корень репозитория по расположению самой библиотеки.
    env = os.environ.get("CLAUDE_PROJECT_DIR")
    if env:
        return env
    try:
        return os.getcwd()
    except OSError:
        return os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

STATE_DIR_ENV = "CLAUDE_HOOK_STATE_DIR"

def state_base(default=None):
    """Корень, от которого считаются СОБСТВЕННЫЕ файлы хуков: выданные
    пропуски, отметки о прогонах, журналы (issue #54).

    Отделён от project_dir() намеренно. `project_dir()` — это то, что хук
    ПРОВЕРЯЕТ: от него считается граница «внутри/снаружи» и список защищённых
    путей. Здесь — то, куда хук ПИШЕТ. Пока это одно и то же место, разница
    незаметна; она нужна там, где механику пропусков надо проверить, не трогая
    боевые пропуска.

    Прежде набор тестов решал ту же задачу иначе: удалял боевой unlock.json
    на время прогона и возвращал снимком. Из-за этого задача и заведена —
    пока идут тесты, действующего пропуска не существует ни для кого, а пропуск,
    выданный во время прогона, затирается восстановлением. Снимок аккуратнее
    гонку не убирает, только сужает окно; убирает перенаправление.

    Переменную задаёт тот, кто запускает хук. Сессии агента она недоступна:
    хук запускается обвязкой, а не Bash-инструментом, и окружение команды агента
    в него не наследуется. Полагаться на это одно было бы рассуждением, поэтому
    команда, пытающаяся её задать, отклоняется guard-protected-files — там же,
    где запрещена выдача пропуска себе: переменная, указывающая, где лежит
    unlock.json, указывает, откуда читаются разрешения.
    """
    return os.environ.get(STATE_DIR_ENV) or default or project_dir()

def state_path(name, base=None):
    """Путь к собственному файлу состояния хуков (.claude/state/<name>)."""
    return os.path.join(state_base(base), ".claude", "state", name)

def log_path(name, base=None):
    """Путь к собственному журналу хуков (.claude/logs/<name>)."""
    return os.path.join(state_base(base), ".claude", "logs", name)

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

def as_text(value):
    """Чужую форму значения — в строку, на которой сработают проверки.

    Не json.dumps: он ставит между элементами запятую и кавычки, а все боевые
    шаблоны склеены через \\s+ — `["git", "push", "origin", "main"]` не совпал бы
    ни с одним из них, и «проверяется как текст» осталось бы словами. Замерено
    ревью результата: список проходил там, где та же команда строкой отклонялась.
    Элементы соединяются пробелом — так получается ровно то, чем эта форма
    и является: командой и её аргументами.
    """
    if isinstance(value, str):
        return value
    if isinstance(value, (list, tuple)):
        return " ".join(as_text(v) for v in value)
    if isinstance(value, dict):
        return " ".join(as_text(v) for v in value.values())
    if value is None:
        return ""
    try:
        return str(value)
    except Exception:
        return repr(value)[:2000]

def read_input():
    """Вход хука, приведённый к форме, на которой хуки не падают (issue #156).

    Форму события задаёт обвязка, а не проект: новый инструмент или новая
    версия Claude Code может прислать `tool_input` списком, `cwd` числом,
    `command` объектом. Все пять хуков на таком входе бросали AttributeError
    или TypeError — замерено. Пока падение означало код 1, ценой был тихий
    пропуск; теперь это отказ, и незакрытое место остановило бы работу
    на каждом вызове.

    Приведение сделано в пользу проверки, а не в пользу тишины: непонятная
    команда не выбрасывается, а превращается в текст и проверяется как текст.
    Вход, который не разобрался вовсе, для вооружённого хука становится
    отказом — там проверка не состоялась ни в каком виде.
    """
    try:
        data = json.load(sys.stdin)
        if not isinstance(data, dict):
            raise ValueError("вход хука — не объект, а %s" % type(data).__name__)
    except Exception as exc:
        # Вход не разобран — значит хук не увидел, что именно он судит.
        # Для вооружённого хука это тот же класс, что и любой другой сбой
        # разбора: проверка не состоялась, а несостоявшаяся проверка
        # разрешением не является. Исключение поднимается наружу и становится
        # отказом с причиной там же, где и все остальные (issue #156,
        # находка внешнего ревьюера).
        if ARMED[0]:
            raise ValueError("вход хука не разобран: %s: %s"
                             % (type(exc).__name__, exc))
        return {}
    ti = data.get("tool_input")
    if not isinstance(ti, dict):
        # Не выбрасывается, а превращается в текст и проверяется как текст:
        # выброшенное поле — это тихий пропуск, ровно то, что здесь чинится.
        data["tool_input"] = {"command": as_text(ti)}
    elif ti.get("command") is not None and not isinstance(ti.get("command"), str):
        ti["command"] = as_text(ti["command"])
    if data.get("cwd") is not None and not isinstance(data.get("cwd"), str):
        data.pop("cwd", None)
    return data

def log(event, payload):
    # Вычисление пути стоит внутри try вместе с записью: log_path → state_base
    # → project_dir тоже бросает, а шаг «журнал» обязан быть тем шагом,
    # который не падает никогда (issue #156).
    try:
        path = log_path("guard.jsonl")
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
    except (OSError, UnicodeDecodeError):
        # Права на файл и битая кодировка. Ловятся с тех пор, как падение
        # стало отказом (issue #156): один неверный байт в списке исключений
        # иначе останавливал бы работу целиком.
        pass
    return out

def allowed(text):
    return any(rx.search(text) for rx in allowlist())

def unlock_active(zone):
    """Действующий пропуск для зоны или None.

    Решение «ask» зависит от того, покажет ли среда диалог. В неинтерактивной
    сессии диалога нет, и «ask» молча пропускает команду — проверено 2026-08-25:
    правка защищённого хука и создание ветки прошли, оставив в журнале только след.
    Поэтому подтверждение здесь не спрашивается, а выдаётся заранее и с истечением:
    сэр открывает зону командой scripts/unlock.sh, хук её видит.
    """
    path = state_path("unlock.json")
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

HOOK_ERROR = "hook-error"

# Решение уже напечатано? Обработчик падения не имеет права дописать второй
# JSON в тот же поток: разобрать такой вывод нельзя, а неразбираемый вывод
# обвязка считает разрешением. Список, а не переменная, — чтобы менять его
# из decide() без global.
PRINTED = [False]

# Поставлен ли перехват падений. Пока он не поставлен, нераспознанный вход —
# это прежнее поведение (пустой словарь и молчание): у PostToolUse отказом
# уже ничего не предотвратить, и превращать там сбой разбора в исключение
# значило бы шуметь без пользы.
ARMED = [False]

def arm(guard, event="PreToolUse"):
    """Хук заканчивается решением, а не трассировкой (issue #156).

    Барьером Claude Code считает код 2 либо код 0 с решением «deny» в JSON.
    Необработанное исключение даёт код 1 — «неблокирующая ошибка», после
    которой команда исполняется. То есть хук, сломавшийся на разборе,
    не отказывал: он молчал и пропускал. Цена ошибки несимметрична — ложный
    отказ виден сразу, тихий пропуск не виден никогда.

    Почему sys.excepthook, а не try вокруг main(). try покрывает только
    исполнение функции, а падение на уровне модуля — импорт _paths,
    компиляция регулярок, чтение окружения — происходит раньше и относится
    к тому же классу: код не дошёл до решения. Обработчик ставится
    из _run.py ДО того, как файл хука вообще начнёт исполняться, поэтому
    покрыт и он сам.

    Ставится только на PreToolUse. На Stop и PostToolUse не ставится, и это
    не забывчивость: у PostToolUse инструмент уже отработал, предотвращать
    нечего, а на Stop отказ означает «сессию нельзя закрыть» — падение
    на уровне модуля происходит раньше чтения stop_hook_active, и получился
    бы вечный цикл вместо тихого пропуска. Что при этом остаётся невидимым,
    названо в docs/HOOKS.md.

    Выход через os._exit оставляет невыполненными atexit и finally. Для хуков
    PreToolUse это ничего не стоит: они не пишут состояние. Вооружать хук,
    который пишет (mark-verify), без разбора этой цены нельзя — останутся
    осиротевшие временные файлы.

    Три требования к самому обработчику. Каждое проверено запуском, и каждое
    про то, как отказ снова превращается в разрешение:

      · обработчик не имеет права бросить исключение — CPython печатает
        «Error in sys.excepthook» и выходит с кодом 1;
      · выход через os._exit, а не sys.exit — SystemExit, брошенный внутри
        обработчика, проглатывается молча: код 0 и пустой вывод;
      · os._exit не сбрасывает буферы, а stdout хука — труба. Без явного
        flush() напечатанное решение теряется целиком, и это ровно тот
        дефект, который здесь чинится. flush стоит внутри того же try,
        что и печать, и именно он ловит недоступный stdout: сама печать
        в закрытый поток не падает, падает сброс.
    """
    def say(text):
        try:
            sys.stderr.write(text + "\n")
            sys.stderr.flush()
        except BaseException:
            pass

    def handler(exc_type, exc, tb):
        # Текст исключения несёт данные: UnicodeDecodeError печатает сами
        # байты, KeyError — ключ. Обрезается и он, и трассировка. Локальные
        # переменные не собираются вовсе (никакого capture_locals): среди них
        # при Write/Edit лежит содержимое файла целиком.
        try:
            detail = ("%s: %s" % (getattr(exc_type, "__name__", exc_type), exc))[:500]
        except BaseException:
            detail = "исключение, которое не удалось описать"
        where, trace = "", ""
        try:
            frames = traceback.extract_tb(tb)
            if frames:
                where = "%s:%d" % (os.path.basename(frames[-1][0]), frames[-1][1])
            trace = "".join(traceback.format_exception(exc_type, exc, tb))[-1500:]
        except BaseException:
            pass

        reason = (
            "Заблокировано хуком %s: разбор не завершён.\n"
            "Сбой: %s\nМесто: %s\n"
            "Хук не дошёл до решения, а несостоявшаяся проверка разрешением "
            "не является — поэтому команда отклонена.\n"
            "Это поломка самого механизма, а не запрет по существу: сменой формы "
            "команды она не обходится, и чинить её самому нельзя — каталог хуков "
            "закрыт guard-protected-files. Правильный выход один: остановиться "
            "и доложить координатору, что обвязка сломана и чем именно. Запись "
            "о сбое — в .claude/logs/guard.jsonl, событие «hook-error»."
            % (guard, detail, where or "не определено"))

        # Журнал раньше печати намеренно: событие «hook-error» и есть то, чем
        # поломка отличается от строгости, и терять его нельзя, даже если
        # напечатать решение не удастся. Причина собрана ДО этого места целиком:
        # под MemoryError не выполнится именно форматирование.
        # log() ловит только Exception, поэтому вызов обёрнут ещё раз —
        # BaseException из него дал бы код 1, то есть разрешение.
        try:
            # Ключ намеренно не "event": log() кладёт имя события в поле
            # с этим же именем, и payload затёр бы «hook-error» на «PreToolUse»,
            # то есть ровно ту отличимость, ради которой запись и заводится.
            # Поймано набором, а не чтением.
            log(HOOK_ERROR, {"guard": guard, "hook_event": event, "error": detail,
                             "where": where, "reason": reason, "traceback": trace})
        except BaseException:
            pass

        if not PRINTED[0]:
            try:
                sys.stdout.write(json.dumps({
                    "hookSpecificOutput": {
                        "hookEventName": event,
                        "permissionDecision": "deny",
                        "permissionDecisionReason": reason,
                    }
                }, ensure_ascii=False) + "\n")
                sys.stdout.flush()
            except BaseException:
                # Решение напечатать не вышло. Запасной барьер — код 2:
                # для PreToolUse он блокирует так же, только без причины.
                say(reason)
                os._exit(2)
            os._exit(0)

        # Решение уже в потоке: второй JSON сделал бы вывод неразбираемым,
        # а неразбираемый вывод — это пропуск. Барьером остаётся код 2.
        say(reason)
        os._exit(2)

    sys.excepthook = handler
    ARMED[0] = True
    # Обработчик возвращается наружу: sys.excepthook — глобальная
    # переменная процесса, и любой поднятый хуком модуль может её
    # перезаписать. Запускатель держит прямую ссылку и зовёт её сам.
    return handler

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
    # Сброс и отметка — для перехвата падений (issue #156). Буфер на трубе
    # держит напечатанное до выхода, а обработчик выходит через os._exit,
    # который буфер выбрасывает; отметка говорит ему, что решение уже
    # в потоке и второй JSON туда писать нельзя.
    sys.stdout.flush()
    PRINTED[0] = True
    sys.exit(0)

def ok():
    sys.exit(0)

def targets(data):
    """Строки, которые имеет смысл проверять: команда или путь к файлу."""
    ti = data.get("tool_input")
    if not isinstance(ti, dict):   # issue #156: форму задаёт обвязка, не проект
        ti = {}
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
