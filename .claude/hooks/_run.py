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
import json
import os
import runpy
import sys
import tempfile

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
    # Труба может быть открыта не в UTF-8 (LC_ALL=C и подобное). Тогда print()
    # падает на кириллице раньше, чем решение дойдёт до трубы: барьер устоит
    # на коде 2, но решения в JSON не будет. Стоит первой строкой main(), выше
    # всех вызовов emergency(): аварийный отказ теряет решение точно так же.
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="backslashreplace")
    except BaseException:
        pass

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
        handler = H.arm(guard)
    except BaseException as exc:
        emergency(guard, "не поднялась библиотека хуков: %s: %s"
                  % (type(exc).__name__, exc))

    # Вывод хука перехватывается на уровне дескриптора, а не объекта sys.stdout.
    # Разница не теоретическая: подмена объекта не видит того, что пишет
    # в дескриптор 1 напрямую — дочерний процесс, запущенный без захвата
    # вывода, или os.write. Такой вывод оказался бы на трубе рядом с решением,
    # сделав его неразбираемым, а неразбираемый вывод обвязка считает
    # разрешением. Найдено ревью результата.
    #
    # Решение печатает запускатель — ровно одно и целиком; вывод сломанного
    # хука отбрасывается вместе с буфером.
    captured = tempfile.TemporaryFile()
    saved_fd = os.dup(1)
    os.dup2(captured.fileno(), 1)
    restored = [False]

    def restore():
        if restored[0]:
            return
        restored[0] = True
        try:
            sys.stdout.flush()      # буфер обязан уйти в подменённый дескриптор
        except BaseException:
            pass
        try:
            os.dup2(saved_fd, 1)
        except BaseException:
            # Дескриптор не восстановлен: дальше write_all писал бы в буфер,
            # os.write возвращал бы успех, процесс уходил бы с кодом 0 —
            # и на трубе было бы пусто. Проглоченная ошибка в последнем слое
            # и есть молчаливый пропуск. Найдено ревью результата.
            os._exit(2)
        try:
            os.close(saved_fd)
        except BaseException:
            pass          # восстановление уже состоялось, лишний fd не стоит ничего

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
        restore()
        try:
            handler(*sys.exc_info())
        except BaseException as exc:
            # Обработчик тоже может быть сломан — тогда исключение из него
            # ушло бы наружу и дало код 1. Класс закрывается так же, как
            # «сломана библиотека»: аварийным отказом.
            emergency(guard, "перехват сам не отработал: %s: %s"
                      % (type(exc).__name__, exc))
        raise
    finally:
        restore()

    try:
        captured.seek(0)
        data = captured.read()
    except BaseException:
        # «Прочитать не вышло» — это не «хук промолчал»: во втором случае
        # команда пойдёт дальше, а в первом мы просто не знаем решения.
        os._exit(2)
    out = data.strip()

    if H.PRINTED[0] and not out:
        # Хук напечатал решение, а до буфера оно не дошло: кто-то закрыл или
        # перенаправил дескрипторы. Отсюда флаг PRINTED и перестаёт быть
        # рудиментом — он сверяет «решение принято» с «решение на трубе».
        detail = "решение напечатано, но до трубы не дошло"
        note(H, guard, detail, name)
        os._exit(2)
    if code not in (0, 2):
        detail = "хук завершился кодом %s, не выдав решения" % code
        # Библиотека здесь уже поднята — значит след в журнале возможен
        # и обязателен: отказ без записи неотличим от строгости.
        note(H, guard, detail, name)
        emergency(guard, detail)
    if out:
        try:
            json.loads(out.decode("utf-8"))
        except Exception:
            detail = "хук напечатал не решение, а %d Б постороннего вывода" % len(out)
            note(H, guard, detail, name)
            emergency(guard, detail)
    # Байтами, а не через текстовый поток: труба может быть открыта не в UTF-8,
    # и тогда запись решения падала бы на кодировке. Барьер при этом устоял бы
    # (код 2), но причина не дошла бы ни до модели, ни до сэра.
    if out and not write_all(out):
        os._exit(2)
    os._exit(code)

def write_all(data):
    """Отдать решение целиком. Частичная запись в трубу — не отказ, а половина
    решения, то есть тот же неразбираемый вывод."""
    try:
        while data:
            data = data[os.write(1, data):]
        return True
    except BaseException:
        return False

def note(H, guard, detail, where):
    """След в журнале для путей, которые перехват исключений не видит."""
    try:
        H.log(H.HOOK_ERROR, {"guard": guard, "hook_event": "PreToolUse",
                             "error": detail, "where": where})
    except BaseException:
        pass

main()
