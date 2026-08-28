import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const runtimeModules = '/Users/rashit/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules';
const { marked } = require(path.join(runtimeModules, 'marked'));
const { chromium } = require(path.join(runtimeModules, 'playwright'));

const root = path.resolve(import.meta.dirname, '../..');
const sourcePath = path.join(root, 'REPORT.md');
const htmlPath = path.join(import.meta.dirname, 'project-report.html');
const pdfPath = path.join(import.meta.dirname, 'project-report.pdf');

const raw = fs.readFileSync(sourcePath, 'utf8');
const firstSection = raw.indexOf('## 1. ');
if (firstSection < 0) throw new Error('REPORT.md: first numbered section not found');
const bodyMarkdown = raw.slice(firstSection);

const headings = [...bodyMarkdown.matchAll(/^(#{2,3})\s+(.+)$/gm)].map((match, index) => ({
  level: match[1].length,
  title: match[2],
  id: `section-${index + 1}`,
}));
let headingIndex = 0;
const annotated = bodyMarkdown.replace(/^(#{2,3})\s+(.+)$/gm, (full, marks, title) => {
  const heading = headings[headingIndex++];
  return `<h${marks.length} id="${heading.id}">${title}</h${marks.length}>`;
});

marked.setOptions({ gfm: true, breaks: false });
const body = marked.parse(annotated);
const sectionPages = new Map([
  ['1. Что это и как запустить', 3],
  ['2. Обязательная часть', 4],
  ['3. Необязательная часть (бонусы)', 6],
  ['4. Что не сработало', 7],
  ['5. Цифры и хронология', 20],
  ['6. Что заберём после курса', 21],
  ['6а. Что заберём — из продуктового потока', 22],
  ['7. Журнал задач', 23],
]);
const toc = headings
  .filter((h) => h.level === 2)
  .map((h) => `<li><a href="#${h.id}"><span>${h.title}</span><span class="toc-page">${sectionPages.get(h.title) ?? ''}</span></a></li>`)
  .join('\n');

const css = `
  :root { --accent: #175a73; --ink: #17232b; --muted: #5e6b73; --rule: #cbd5da; --paper: #fff; }
  @page { size: A4; margin: 19mm 18mm 21mm 20mm; }
  * { box-sizing: border-box; }
  html { font-family: Inter, "Helvetica Neue", Arial, sans-serif; color: var(--ink); font-size: 9.6pt; line-height: 1.46; }
  body { margin: 0; background: var(--paper); }
  .cover { height: 249mm; display: flex; flex-direction: column; justify-content: space-between; page-break-after: always; padding: 17mm 10mm 11mm; border-top: 4mm solid var(--accent); }
  .cover-kicker { color: var(--accent); font-weight: 700; letter-spacing: .12em; text-transform: uppercase; font-size: 9pt; }
  .cover h1 { margin: 25mm 0 5mm; max-width: 145mm; font-size: 30pt; line-height: 1.08; letter-spacing: -.025em; }
  .cover .subtitle { max-width: 135mm; color: var(--muted); font-size: 13pt; line-height: 1.45; }
  .cover-meta { border-top: 1px solid var(--rule); padding-top: 7mm; display: grid; grid-template-columns: 1fr 1fr; gap: 8mm; }
  .label { display: block; color: var(--muted); font-size: 7.7pt; text-transform: uppercase; letter-spacing: .08em; margin-bottom: 1.5mm; }
  .value { font-size: 11pt; font-weight: 650; }
  .frontmatter { page-break-after: always; }
  .summary { border-left: 3px solid var(--accent); padding: 2mm 0 2mm 7mm; margin: 6mm 0 12mm; }
  .summary p { font-size: 10.5pt; line-height: 1.55; }
  h1, h2, h3, h4 { color: var(--ink); page-break-after: avoid; }
  h1 { font-size: 23pt; margin: 0 0 8mm; }
  h2 { font-size: 18pt; line-height: 1.16; margin: 13mm 0 5mm; padding-top: 3mm; border-top: 2px solid var(--accent); break-before: page; }
  h3 { font-size: 13.5pt; line-height: 1.25; margin: 9mm 0 3mm; color: var(--accent); }
  h4 { font-size: 11pt; margin: 7mm 0 2.5mm; }
  p { margin: 0 0 3.4mm; orphans: 3; widows: 3; }
  strong { font-weight: 720; }
  a { color: var(--accent); text-decoration: none; }
  hr { border: 0; border-top: 1px solid var(--rule); margin: 8mm 0; }
  ul, ol { margin: 2mm 0 4mm; padding-left: 6mm; }
  li { margin: 1.2mm 0; }
  blockquote { margin: 4mm 0; padding: 3mm 5mm; border-left: 2px solid var(--accent); background: #f2f6f7; color: #31434d; break-inside: avoid; }
  blockquote p:last-child { margin-bottom: 0; }
  code { font-family: "SFMono-Regular", Consolas, monospace; font-size: 8.5pt; background: #eef2f4; padding: .2mm .8mm; border-radius: 2px; }
  pre { background: #16252d; color: #f5f7f8; padding: 4mm; border-radius: 3px; overflow-wrap: anywhere; white-space: pre-wrap; break-inside: avoid; }
  pre code { color: inherit; background: transparent; padding: 0; }
  table { width: 100%; border-collapse: collapse; margin: 4mm 0 6mm; font-size: 8.1pt; line-height: 1.35; break-inside: auto; }
  thead { display: table-header-group; }
  tr { break-inside: avoid; }
  th { color: #fff; background: var(--accent); font-weight: 680; text-align: left; }
  th, td { padding: 2.2mm 2.5mm; border: 1px solid #c8d2d7; vertical-align: top; }
  tbody tr:nth-child(even) { background: #f4f7f8; }
  .toc { list-style: none; padding: 0; margin: 5mm 0 0; }
  .toc li { margin: 0; border-bottom: 1px solid #dbe2e5; }
  .toc a { display: flex; justify-content: space-between; gap: 8mm; padding: 3.2mm 0; color: var(--ink); }
  .toc-page { min-width: 8mm; text-align: right; color: var(--accent); font-weight: 700; }
  .source-note { color: var(--muted); font-size: 8.5pt; margin-top: 10mm; }
  body > h2:first-of-type { margin-top: 0; }
`;

const html = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Отчёт по проекту</title><style>${css}</style></head><body>
  <section class="cover">
    <div><div class="cover-kicker">Итоговый проектный отчёт</div><h1>Идемпотентный платёжный сервис</h1><div class="subtitle">Результаты разработки, качество проверок, ограничения процесса и выводы для дальнейшей работы</div></div>
    <div class="cover-meta"><div><span class="label">Автор</span><span class="value">Рашит</span></div><div><span class="label">Дата</span><span class="value">28 августа 2026</span></div></div>
  </section>
  <section class="frontmatter">
    <h1>Краткое резюме</h1>
    <div class="summary">
      <p>Проект доведён до работающего результата: идемпотентный платёжный API, браузерная песочница и документация запускаются одной командой. Все 56 требований подтверждены прогоном; шесть прежних хвостов закрыты задачей #180. Повторяемая приёмка на чистом клоне зафиксировала 293 успешных теста бэкенда, 21 проверку без расхождений и работоспособность всех трёх сервисов.</p>
      <p>Главный результат проекта шире продукта. В ходе независимых проверок выявился повторяющийся системный риск: проверка может давать корректный ответ не на тот вопрос. Зафиксированы случаи, когда тесты, защитные хуки, журналы и ревью подтверждали соседнее свойство, другую версию кода или лишь упоминание признака. Внешняя проверка оказалась особенно ценной: на одной задаче она обнаружила восемь проблем против двух, найденных внутренней приёмкой, включая блокирующее снятие защиты с корня файловой системы.</p>
      <p>Рекомендации для следующего цикла: закреплять каждое требование тестом, который действительно краснеет при нарушении; привязывать вердикт к конкретному коммиту; разделять рабочие копии для всех, кто запускает команды; вводить внешнюю линзу на изменения защиты; измерять проверяемое свойство напрямую и фиксировать границы механизмов в том же изменении, где они вводятся.</p>
    </div>
    <h1>Оглавление</h1><ol class="toc">${toc}</ol>
  </section>
  ${body}
</body></html>`;

fs.writeFileSync(htmlPath, html);
const browser = await chromium.launch({
  headless: true,
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
});
const page = await browser.newPage();
await page.goto(`file://${htmlPath}`, { waitUntil: 'load' });
await page.pdf({
  path: pdfPath,
  format: 'A4',
  printBackground: true,
  displayHeaderFooter: true,
  headerTemplate: '<div style="width:100%;font:8px Arial;color:#63727a;padding:0 18mm 0 20mm;display:flex;justify-content:space-between"><span>Идемпотентный платёжный сервис</span><span>Итоговый проектный отчёт</span></div>',
  footerTemplate: '<div style="width:100%;font:8px Arial;color:#63727a;padding:0 18mm 0 20mm;display:flex;justify-content:space-between"><span>28 августа 2026</span><span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>',
  margin: { top: '19mm', right: '18mm', bottom: '21mm', left: '20mm' },
});
await browser.close();
console.log(pdfPath);
