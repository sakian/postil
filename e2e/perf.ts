/**
 * Load and scroll a large synthetic review in headless Chromium and report how the page holds up.
 * Run by hand after `npm run build`:  node e2e/perf.ts
 */
import { chromium } from 'playwright';
import { startServer } from '../src/server/server.ts';
import { makeFixture, numbered } from '../test/helpers.ts';

const FILES = 300;
const fx = makeFixture();
const body = (i: number, edited: boolean) =>
  Array.from({ length: 200 }, (_, n) =>
    edited && n % 33 === 5 ? `export const value${i}_${n} = compute(${n}, 'changed'); // edited` : `export const value${i}_${n} = compute(${n});`,
  ).join('\n') + '\n';
for (let i = 0; i < FILES; i++) fx.write(`src/mod${i % 20}/file${i}.ts`, body(i, false));
fx.write('src/generated/huge.ts', numbered(4000));
fx.commit('base');
for (let i = 0; i < FILES; i++) fx.write(`src/mod${i % 20}/file${i}.ts`, body(i, true));
fx.write('src/generated/huge.ts', numbered(4000).replace(/line/g, 'LINE'));

const server = await startServer({ cwd: fx.dir, port: 0 });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
if (process.env.NO_CONTENT_VISIBILITY) {
  await page.addInitScript(() => {
    document.addEventListener('DOMContentLoaded', () => {
      const style = document.createElement('style');
      style.textContent = '.file-body { content-visibility: visible !important; }';
      document.head.append(style);
    });
  });
}
await page.addInitScript(() => {
  (window as unknown as { __long: number[] }).__long = [];
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) (window as unknown as { __long: number[] }).__long.push(e.duration);
  }).observe({ type: 'longtask', buffered: true });
});

const t0 = Date.now();
await page.goto(server.uiUrl);
await page.locator('section.file table.diff').first().waitFor({ timeout: 30_000 });
const firstDiff = Date.now() - t0;
await page.waitForTimeout(1500); // let highlighting settle
const longDuringLoad = await page.evaluate(() => (window as unknown as { __long: number[] }).__long.splice(0));

const t1 = Date.now();
let steps = 0;
for (;;) {
  const atEnd = await page.evaluate(() => {
    const m = document.querySelector('main.main')!;
    m.scrollBy(0, m.clientHeight);
    return m.scrollTop + m.clientHeight >= m.scrollHeight - 2;
  });
  steps++;
  await page.waitForTimeout(40);
  if (atEnd || steps > 2000) break;
}
const scrollMs = Date.now() - t1;
await page.waitForTimeout(1000);
const longDuringScroll = await page.evaluate(() => (window as unknown as { __long: number[] }).__long.splice(0));
const stats = await page.evaluate(() => ({
  nodes: document.getElementsByTagName('*').length,
  files: document.querySelectorAll('section.file').length,
  loaded: document.querySelectorAll('section.file table.diff').length,
  deferred: [...document.querySelectorAll('.file-note')].filter((n) => n.textContent?.includes('Large diff')).length,
  coloured: document.querySelectorAll('.tk').length > 0,
}));

const sum = (a: number[]) => Math.round(a.reduce((x, y) => x + y, 0));
const max = (a: number[]) => Math.round(Math.max(0, ...a));
console.table({
  'files in review': stats.files,
  'first diff visible (ms)': firstDiff,
  'blocking during load, total / worst (ms)': `${sum(longDuringLoad)} / ${max(longDuringLoad)}`,
  'scroll through all, steps / ms': `${steps} / ${scrollMs}`,
  'blocking during scroll, total / worst (ms)': `${sum(longDuringScroll)} / ${max(longDuringScroll)}`,
  'diffs rendered after scrolling': stats.loaded,
  'huge files deferred': stats.deferred,
  'syntax colours present': stats.coloured,
  'DOM elements at the end': stats.nodes,
});
await browser.close();
await server.close();
fx.cleanup();
