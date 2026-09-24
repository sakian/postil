/**
 * Renamed files: the old side of the diff has a different path from the new side. Comments and
 * "done" marks on removed lines, and the sidebar's conversation count, must all use the right one.
 *   npm run build && node --test e2e/rename.e2e.ts
 */
import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright';
import { startServer, type RunningServer } from '../src/server/server.ts';
import { makeFixture, numbered, type Fixture } from '../test/helpers.ts';

describe('a renamed and edited file', { timeout: 90_000 }, () => {
  let fx: Fixture;
  let server: RunningServer;
  let browser: Browser;
  let page: Page;
  const errors: string[] = [];
  const file = () => page.locator('[id="file-src_2Fnew-name.ts"]');

  before(async () => {
    fx = makeFixture();
    fx.write('src/old-name.ts', numbered(30));
    fx.commit('base');
    fx.git('mv', 'src/old-name.ts', 'src/new-name.ts');
    fx.write('src/new-name.ts', numbered(30).replace('line 5\n', '').replace('line 20\n', 'line twenty\n'));
    server = await startServer({ cwd: fx.dir, port: 0 });
    browser = await chromium.launch();
    page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(server.uiUrl);
    await file().locator('table.diff').waitFor();
  });
  after(async () => {
    await browser?.close();
    await server?.close();
    fx?.cleanup();
  });

  it('is shown as a rename', async () => {
    assert.match(await file().locator('.file-path').innerText(), /src\/old-name\.ts → src\/new-name\.ts/);
  });

  it('accepts a comment on a removed line', async () => {
    const removed = file().locator('tr.line.del:has(td.num:nth-child(1)[data-no="5"])');
    await removed.locator('td.num').first().click();
    const composer = file().locator('.thread-new');
    await composer.waitFor();
    assert.match(await composer.innerText(), /removed line 5/);
    await composer.locator('textarea').fill('Why was this removed?');
    await composer.getByRole('button', { name: 'Add review comment' }).click();
    // The saved thread, not the composer (whose textarea holds the same text).
    await file().locator('.thread:not(.thread-new)', { hasText: 'Why was this removed?' }).waitFor();
    assert.equal(await page.locator('.toast', { hasText: /not a file/ }).count(), 0, 'no "not a file on the old side" error');
    const res = await fetch(`${server.info.url}/api/threads`, { headers: { authorization: `Bearer ${server.info.token}` } });
    const body = (await res.json()) as { threads?: Array<{ path: string; side: string; start_line: number }> };
    const thread = body.threads?.[0];
    assert.ok(thread, `the server has the thread (got ${res.status} ${JSON.stringify(body).slice(0, 200)})`);
    assert.deepEqual([thread.path, thread.side, thread.start_line], ['src/old-name.ts', 'old', 5]);
  });

  it('counts the conversation against the renamed file in the sidebar', async () => {
    const row = page.locator('.tree-file', { hasText: 'new-name.ts' });
    await row.locator('.tree-badge', { hasText: '1' }).waitFor();
  });

  it('marks the section with the removed line done, and it stays done', async () => {
    const toggle = file().locator('.done-toggle').first();
    await toggle.click();
    await file().locator('.done-toggle.on').first().waitFor();
    await page.reload();
    await file().locator('.done-row').first().waitFor();
    assert.match(await file().locator('.chip-sections').innerText(), /1\/2 sections done/);
  });

  it('raised no errors in the page', () => {
    assert.deepEqual(errors, []);
  });
});
