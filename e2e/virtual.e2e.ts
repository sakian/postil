/**
 * A review too large to render at once: only files near the viewport are mounted.
 *   npm run build && node --test e2e/virtual.e2e.ts
 */
import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright';
import { startServer, type RunningServer } from '../src/server/server.ts';
import { makeFixture, numbered, type Fixture } from '../test/helpers.ts';

const FILES = 200;
const id = (path: string) => `[id="file-${encodeURIComponent(path).replace(/%/g, '_')}"]`;

async function until(check: () => Promise<boolean>, what: string, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.fail(`timed out waiting for ${what}`);
}

describe('a 200-file review', { timeout: 120_000 }, () => {
  let fx: Fixture;
  let server: RunningServer;
  let browser: Browser;
  let page: Page;
  const path = (i: number) => `src/m${String(i).padStart(3, '0')}.ts`;

  before(async () => {
    fx = makeFixture();
    for (let i = 0; i < FILES; i++) fx.write(path(i), numbered(40));
    fx.commit('base');
    for (let i = 0; i < FILES; i++) fx.write(path(i), numbered(40, { 5: `changed ${i}`, 30: `also ${i}` }));
    server = await startServer({ cwd: fx.dir, port: 0 });
    browser = await chromium.launch();
    page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    await page.goto(server.uiUrl);
    await page.locator('section.file table.diff').first().waitFor();
  });
  after(async () => {
    await browser?.close();
    await server?.close();
    fx?.cleanup();
  });

  it('mounts only the files near the viewport', async () => {
    assert.match(await page.locator('.diff-summary').innerText(), /200 files changed/);
    const mounted = await page.locator('section.file').count();
    assert.ok(mounted > 0 && mounted < 60, `${mounted} of ${FILES} mounted`);
    assert.equal(await page.locator('.tree-file').count(), FILES, 'the sidebar still lists every file');
  });

  it('reveals an unmounted file from the sidebar', async () => {
    const last = path(FILES - 1);
    assert.equal(await page.locator(id(last)).count(), 0);
    await page.locator('.tree-file', { hasText: 'm199.ts' }).click();
    await page.locator(id(last)).locator('table.diff').waitFor();
    // The last file cannot reach the top (nothing below it fills the view), but it must be on screen.
    const lastTop = await page.locator(id(last)).evaluate((el) => el.getBoundingClientRect().top);
    assert.ok(lastTop > 0 && lastTop < 900, `the last file is on screen (top=${lastTop})`);
    assert.equal(await page.locator(id(path(0))).count(), 0, 'the first file was unmounted');

    const middle = path(120);
    await page.locator('.tree-file', { hasText: 'm120.ts' }).click();
    await page.locator(id(middle)).locator('table.diff').waitFor();
    await page.waitForTimeout(600); // let neighbouring heights settle
    const top = await page.locator(id(middle)).evaluate((el) => el.getBoundingClientRect().top);
    assert.ok(top > 0 && top < 120, `a file mid-list lands at the top of the view (top=${top})`);
  });

  it('keeps an unsent comment when its file scrolls out and back', async () => {
    await page.locator('.tree-file', { hasText: 'm000.ts' }).click();
    const first = page.locator(id(path(0)));
    await first.locator('table.diff').waitFor();
    const row = first.locator('tr.line:has(td.num:nth-child(2)[data-no="5"])');
    await row.hover();
    await row.locator('.add-comment').dispatchEvent('mousedown', { button: 0 });
    await page.mouse.up();
    await first.locator('.thread-new textarea').fill('half-written thought');

    await page.locator('.tree-file', { hasText: 'm150.ts' }).click();
    await until(async () => (await page.locator(id(path(0))).count()) === 0, 'the first file to unmount');
    await page.locator('.tree-file', { hasText: 'm000.ts' }).click();
    const box = page.locator(id(path(0))).locator('.thread-new textarea');
    await box.waitFor();
    assert.equal(await box.inputValue(), 'half-written thought');
  });
});
