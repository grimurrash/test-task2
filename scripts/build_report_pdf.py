#!/usr/bin/env python3
"""Собирает REPORT.pdf из REPORT.md — механизм, не разовый экспорт.

Требует: pip install markdown xhtml2pdf. Кириллический шрифт берётся
из DejaVu Sans, которым для собственных нужд пользуется matplotlib
(почти всегда уже стоит в любом Python-окружении с numpy/pandas);
без matplotlib скрипт откажет явно, а не отрисует латиницу вместо кириллицы.

Запуск из корня репозитория:

    python3 scripts/build_report_pdf.py

Пересобирать после каждой содержательной правки REPORT.md — CI генерацию
не проверяет, файл коммитится руками.
"""
import re
import sys

try:
    import markdown
    from xhtml2pdf import pisa
except ImportError as e:
    sys.exit(f"нужен пакет: {e.name}. Установите: pip install markdown xhtml2pdf")

try:
    import matplotlib
except ImportError:
    sys.exit(
        "нужен matplotlib — источник шрифта DejaVu Sans с поддержкой кириллицы.\n"
        "Установите: pip install matplotlib"
    )

FONT_DIR = matplotlib.__file__.rsplit('/matplotlib/', 1)[0] + '/matplotlib/mpl-data/fonts/ttf'
FONT_REGULAR = FONT_DIR + '/DejaVuSans.ttf'
FONT_BOLD = FONT_DIR + '/DejaVuSans-Bold.ttf'
FONT_ITALIC = FONT_DIR + '/DejaVuSans-Oblique.ttf'
FONT_MONO = FONT_DIR + '/DejaVuSansMono.ttf'

with open('REPORT.md', encoding='utf-8') as f:
    src = f.read()

# python-markdown's table extension мисрендерит таблицу с пустым первым
# заголовком (столбцы наезжают друг на друга в выводе xhtml2pdf) — даём имя.
src = src.replace('| | требований | что это значит |', '| оценка | требований | что это значит |')

html_body = markdown.markdown(
    src,
    extensions=['tables', 'fenced_code', 'sane_lists'],
)

# Таблица «Журнал задач» (§7) — семь плотных столбцов, находится по
# заголовку, а не по позиции, чтобы правки выше в файле её не сдвинули.
html_body = re.sub(
    r'(<table>)(\s*<thead>\s*<tr>\s*<th>#</th>\s*<th>Задача</th>)',
    r'<table class="wide-log">\2',
    html_body,
    count=1,
)

css = f"""
@font-face {{ font-family: 'DejaVu'; src: url('{FONT_REGULAR}'); }}
@font-face {{ font-family: 'DejaVu'; src: url('{FONT_BOLD}'); font-weight: bold; }}
@font-face {{ font-family: 'DejaVu'; src: url('{FONT_ITALIC}'); font-style: italic; }}
@font-face {{ font-family: 'DejaVu Mono'; src: url('{FONT_MONO}'); }}

@page {{
  size: A4;
  margin: 2cm 1.8cm;
  @frame footer_frame {{
    -pdf-frame-content: footer_content;
    bottom: 1cm; margin-left: 1.8cm; margin-right: 1.8cm; height: 1cm;
  }}
}}

body {{ font-family: 'DejaVu', sans-serif; font-size: 9.5pt; line-height: 1.45; color: #1a1a1a; }}

h1 {{ font-size: 18pt; margin-top: 0; margin-bottom: 10pt; border-bottom: 2pt solid #333; padding-bottom: 6pt; }}
h2 {{ font-size: 14pt; margin-top: 20pt; margin-bottom: 8pt; border-bottom: 1pt solid #999; padding-bottom: 3pt; -pdf-keep-with-next: true; }}
h3 {{ font-size: 11.5pt; margin-top: 14pt; margin-bottom: 6pt; -pdf-keep-with-next: true; }}
h4 {{ font-size: 10.5pt; margin-top: 10pt; margin-bottom: 5pt; -pdf-keep-with-next: true; }}

p {{ margin: 0 0 7pt 0; text-align: left; }}

table {{ border-collapse: collapse; width: 100%; margin: 8pt 0 12pt 0; font-size: 8.3pt; table-layout: fixed; }}
table, th, td {{ border: 0.5pt solid #999; }}
th, td {{ padding: 4pt 5pt; text-align: left; vertical-align: top; word-wrap: break-word; overflow-wrap: break-word; }}
th {{ background-color: #e8e8e8; font-weight: bold; }}
tr {{ -pdf-keep-in-frame-mode: shrink; }}

table.wide-log {{ font-size: 6.6pt; }}
table.wide-log th, table.wide-log td {{ padding: 3pt 3pt; }}

code {{ font-family: 'DejaVu Mono', monospace; background-color: #f0f0f0; padding: 1pt 3pt; font-size: 8pt; }}
pre {{ font-family: 'DejaVu Mono', monospace; background-color: #f2f2f2; border: 0.5pt solid #ccc;
       padding: 6pt; font-size: 7.6pt; line-height: 1.3; white-space: pre-wrap; word-wrap: break-word;
       margin: 6pt 0; }}
pre code {{ background-color: transparent; padding: 0; }}

blockquote {{ margin: 6pt 0 6pt 4pt; padding: 3pt 10pt; border-left: 2.5pt solid #888;
              background-color: #f7f7f7; font-style: italic; }}

hr {{ border: none; border-top: 0.75pt solid #bbb; margin: 14pt 0; }}

ul, ol {{ margin: 4pt 0 8pt 0; padding-left: 16pt; }}
li {{ margin-bottom: 2pt; }}

a {{ color: #1a1a1a; text-decoration: underline; }}

strong {{ font-weight: bold; }}
em {{ font-style: italic; }}

#footer_content {{ font-size: 7.5pt; color: #888; text-align: center; }}
"""

html_doc = f"""<html><head><meta charset="utf-8"><style>{css}</style></head>
<body>
{html_body}
<div id="footer_content">Идемпотентный платёжный сервис — REPORT.md, PDF-версия. Страница <pdf:pagenumber/> из <pdf:pagecount/>.</div>
</body></html>"""

with open('REPORT.pdf', 'wb') as out:
    result = pisa.CreatePDF(html_doc, dest=out, encoding='utf-8')

if result.err:
    sys.exit(f"xhtml2pdf вернул ошибку: {result.err}")

print("REPORT.pdf собран.")
