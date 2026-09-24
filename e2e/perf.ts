/**
 * Load and scroll a large synthetic review in headless Chromium and report how the page holds up.
 * Run by hand after `npm run build`:  node e2e/perf.ts
 *
 * FILES=2000          review size (default 300)
 * PROFILE=1           print the functions with the most self time during the scroll
 * POSTIL_WEB_ROOT=... serve another UI build, e.g. one built with --minify false for profiling
 * EXTRA_CSS=...       inject CSS, to test a hypothesis about rendering cost
 * MAX_STEPS=150       stop scrolling early
 */
import { chromium } from 'playwright';
import { startServer } from '../src/server/server.ts';
import { makeFixture, numbered } from '../test/helpers.ts';

const FILES = Number(process.env.FILES ?? 300);
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
page.on('pageerror', (e) => console.log('PAGE ERROR:', (e.stack ?? String(e)).slice(0, 900)));
if (process.env.EXTRA_CSS) {
  const css = process.env.EXTRA_CSS;
  await page.addInitScript((text) => {
    document.addEventListener('DOMContentLoaded', () => {
      const style = document.createElement('style');
      style.textContent = text;
      document.head.append(style);
    });
  }, css);
}
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

let profiler: import('playwright').CDPSession | null = null;
if (process.env.PROFILE) {
  profiler = await page.context().newCDPSession(page);
  await profiler.send('Profiler.enable');
  await profiler.send('Profiler.start');
}
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
  if (atEnd || steps > Number(process.env.MAX_STEPS ?? 10_000)) break;
}
const scrollMs = Date.now() - t1;
const reachedEnd = await page.evaluate(() => {
  const m = document.querySelector('main.main')!;
  return m.scrollTop + m.clientHeight >= m.scrollHeight - 2;
});
if (profiler) {
  const { profile } = (await profiler.send('Profiler.stop')) as { profile: { nodes: Array<{ id: number; callFrame: { functionName: string; url: string; lineNumber: number } }>; samples: number[]; timeDeltas: number[] } };
  const self = new Map<number, number>();
  profile.samples.forEach((id, i) => self.set(id, (self.get(id) ?? 0) + (profile.timeDeltas[i] ?? 0)));
  const byFn = new Map<string, number>();
  for (const n of profile.nodes) {
    const f = n.callFrame;
    const key = `${f.functionName || '(anonymous)'}  ${f.url.split('/').pop()}:${f.lineNumber + 1}`;
    byFn.set(key, (byFn.get(key) ?? 0) + (self.get(n.id) ?? 0) / 1000);
  }
  console.log('top self time during scroll (ms):');
  for (const [k, v] of [...byFn].sort((a, b) => b[1] - a[1]).slice(0, 18)) console.log(`${Math.round(v).toString().padStart(8)}  ${k}`);
}
await page.waitForTimeout(1000);
const longDuringScroll = await page.evaluate(() => (window as unknown as { __long: number[] }).__long.splice(0));
const stats = await page.evaluate(() => ({
  nodes: document.getElementsByTagName('*').length,
  files: Number(/(\d+)\s*files? changed/.exec(document.querySelector('.diff-summary')?.textContent ?? '')?.[1] ?? 0),
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
  'scroll through all, steps / ms': `${steps} / ${scrollMs}${reachedEnd ? '' : ' (did not reach the end)'}`,
  'blocking during scroll, total / worst (ms)': `${sum(longDuringScroll)} / ${max(longDuringScroll)}`,
  'diffs mounted at the end': stats.loaded,
  'huge files deferred': stats.deferred,
  'syntax colours present': stats.coloured,
  'DOM elements at the end': stats.nodes,
});
await browser.close();
await server.close();
fx.cleanup();
