import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const runtimeModules = '/Users/rashit/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules';
const { chromium } = require(path.join(runtimeModules, 'playwright'));
const htmlPath = path.join(import.meta.dirname, 'project-presentation.html');
const pdfPath = path.join(import.meta.dirname, 'project-presentation.pdf');

const browser = await chromium.launch({
  headless: true,
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
await page.goto(`file://${htmlPath}`, { waitUntil: 'load' });
await page.pdf({ path: pdfPath, width: '1280px', height: '720px', printBackground: true, margin: { top: 0, right: 0, bottom: 0, left: 0 } });
await browser.close();
console.log(pdfPath);
