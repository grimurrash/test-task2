#!/usr/bin/env python3
"""Запускатель хуков PreToolUse: ставит перехват падений и запускает хук.

Зачем отдельный файл, а не строка в каждом хуке (issue #156).

Барьером Claude Code считает код 2 либо код 0 с решением «deny» в JSON.
Необработанное исключение даёт код 1 — «неблокирующая ошибка», после которой
команда исполняется. Значит хук, сломавшийся на разборе, не отказывает:
он молчит и пропускает.

Перехват, поставленный ИЗНУТРИ файла хука, не покрывает сам этот файл.
Синтаксическая ошибка, обрыв записи, недоступный файл — всё это происходит
на этапе компиляции, до первой исполненной строки, и остаётся кодом 1.
А правятся в этом репозитории именно хуки: самый вероятный сбой — неудачная
правка хука. Поэтому обработчик ставится снаружи, в процессе, который
поднимается раньше: сначала перехват, потом запуск цели через runpy.

Что остаётся непокрытым — названо вслух в docs/HOOKS.md: падение самого
этого файла, отсутствие интерпретатора, убийство хука по таймауту или
сигналом. Регресс где-то обязан закончиться; он заканчивается здесь,
на файле в двадцать строк логики, который меняется реже всех остальных.
"""
import io
import json
import os
import runpy
import sys

HERE = os.path.dirname(os.path.abspath(__file__))

def emergency(guard, detail):
    """Отказ без библиотеки хуков — потому что не поднялась именно она.

    Десять строк, повторяющих _hooklib.arm(). Повтор здесь сознательный:
    единственное место, которому нельзя зависеть от того, что оно защищает.
    """
    reason = ("Заблокировано запускателем хуков: %s не выдал решения (%s).\n"
              "Проверка не состоялась, а несостоявшаяся проверка разрешением "
              "не является. Чинить обвязку из сессии нельзя — остановитесь "
              "и доложите координатору." % (guard, detail))
    try:
        sys.stdout.write(json.dumps({
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "deny",
                "permissionDecisionReason": reason,
            }
        }, ensure_ascii=False) + "\n")
        sys.stdout.flush()
    except BaseException:
        try:
            sys.stderr.write(reason + "\n")
            sys.stderr.flush()
        except BaseException:
            pass
        os._exit(2)      # запасной барьер: код 2 блокирует и без причины
    os._exit(0)

def main():
    name = os.path.basename(sys.argv[1]) if len(sys.argv) > 1 else ""
    if not name.endswith(".py"):
        emergency("запускатель", "не сказано, какой хук запускать")
    guard = name[:-3]

    sys.path.insert(0, HERE)
    try:
        import _hooklib as H
        # arm() внутри того же try, что и импорт: библиотека может подняться,
        # а нужной функции в ней не оказаться — переименование, потерянный
        # при слиянии кусок, старая копия рядом. AttributeError отсюда летел бы
        # мимо ещё не поставленного перехвата и давал код 1, то есть пропуск.
        # Найдено ревью результата.
        handler = H.arm(guard)
    except BaseException as exc:
        emergency(guard, "не поднялась библиотека хуков: %s: %s"
                  % (type(exc).__name__, exc))

    # Вывод хука собирается здесь, а не течёт сразу наружу. Так решение
    # печатает запускатель — ровно одно и целиком, — и хук, напечатавший
    # что-то постороннее, не может сделать вывод неразбираемым: неразбираемый
    # вывод обвязка считает разрешением.
    real_stdout, buffer = sys.stdout, io.StringIO()
    sys.stdout = buffer
    code = 0
    try:
        del sys.argv[1:]          # хук видит свой argv, а не наш
        runpy.run_path(os.path.join(HERE, name), run_name="__main__")
    except SystemExit as exc:
        # sys.excepthook не вызывается для SystemExit — значит sys.exit(1)
        # из хука или из любого поднятого им кода прошёл бы мимо перехвата
        # и дал ровно тот неблокирующий код 1, который здесь и чинится.
        code = exc.code
        if code is None:
            code = 0
        if not isinstance(code, int):
            code = 1
    except BaseException:
        # Перехват зовётся напрямую, а не через sys.excepthook: тот —
        # глобальная переменная процесса, и любой поднятый хуком модуль может
        # её перезаписать. Ссылка на обработчик получена до запуска хука.
        sys.stdout = real_stdout
        handler(*sys.exc_info())
        raise
    finally:
        sys.stdout = real_stdout

    out = buffer.getvalue().strip()
    if code not in (0, 2):
        detail = "хук завершился кодом %s, не выдав решения" % code
        # Библиотека здесь уже поднята — значит след в журнале возможен
        # и обязателен: отказ без записи неотличим от строгости.
        note(H, guard, detail, name)
        emergency(guard, detail)
    if out:
        try:
            json.loads(out)
        except Exception:
            detail = ("хук напечатал не решение, а %d Б постороннего вывода"
                      % len(out.encode("utf-8")))
            note(H, guard, detail, name)
            emergency(guard, detail)
    try:
        real_stdout.write(out)
        real_stdout.flush()
    except BaseException:
        # Решение есть, отдать его некуда. Барьером остаётся код 2.
        os._exit(2)
    os._exit(code)

def note(H, guard, detail, where):
    """След в журнале для путей, которые перехват исключений не видит."""
    try:
        H.log(H.HOOK_ERROR, {"guard": guard, "hook_event": "PreToolUse",
                             "error": detail, "where": where})
    except BaseException:
        pass

main()
