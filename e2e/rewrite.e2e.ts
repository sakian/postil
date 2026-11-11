/**
 * Rewritten code: a block replaced by unrelated code shows its new code on its own, with the
 * removed lines folded to one row until asked for, and an extended sentence still gets its
 * added words highlighted.
 *   npm run build && node --test e2e/rewrite.e2e.ts
 */
import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright';
import { startServer, type RunningServer } from '../src/server/server.ts';
import { makeFixture, type Fixture } from '../test/helpers.ts';

const oldCode = Array.from({ length: 10 }, (_, i) => `const legacy${i} = computeOld(${i}, cache);`);
const newCode = Array.from({ length: 12 }, (_, i) => `export function handler${i}(req: Request) { return route(req); }`);

describe('a rewritten block', { timeout: 90_000 }, () => {
  let fx: Fixture;
  let server: RunningServer;
  let browser: Browser;
  let page: Page;
  const errors: string[] = [];
  const code = () => page.locator('[id="file-src_2Fcode.ts"]');
  const notes = () => page.locator('[id="file-notes.txt"]');

  before(async () => {
    fx = makeFixture();
    fx.write('src/code.ts', ['// top', ...oldCode, '// bottom', ''].join('\n'));
    fx.write('notes.txt', 'Intro.\nThis is an example.\nOutro.\n');
    fx.commit('base');
    fx.write('src/code.ts', ['// top', ...newCode, '// bottom', ''].join('\n'));
    fx.write('notes.txt', 'Intro.\nThis is an example, and this is another example that keeps on going for quite a while longer.\nOutro.\n');
    server = await startServer({ cwd: fx.dir, port: 0 });
    browser = await chromium.launch();
    page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(server.uiUrl);
    await code().locator('table.diff').waitFor();
  });
  after(async () => {
    await browser?.close();
    await server?.close();
    fx?.cleanup();
  });

  it('folds the removed lines and keeps the new code', async () => {
    await code().locator('tr.removed-row', { hasText: '10 removed lines hidden' }).waitFor();
    assert.equal(await code().locator('tr.line.del').count(), 0);
    assert.equal(await code().locator('tr.line.add').count(), 12);
    assert.equal(await code().locator('tr.removed-row .section-check').count(), 1, 'the section checkbox moves to the folded row');
  });

  it('shows and hides them again', async () => {
    await code().locator('tr.removed-row').getByRole('button', { name: 'Show' }).click();
    await code().locator('tr.line.del').first().waitFor();
    assert.equal(await code().locator('tr.line.del').count(), 10);
    await code().locator('tr.removed-row').getByRole('button', { name: /Hide 10 removed lines/ }).click();
    await code().locator('tr.removed-row', { hasText: 'hidden' }).waitFor();
    assert.equal(await code().locator('tr.line.del').count(), 0);
  });

  it('keeps every line in the split view', async () => {
    await page.getByRole('button', { name: 'Split', exact: true }).click();
    await code().locator('table.diff-split').waitFor();
    assert.equal(await code().locator('td.code.del').count(), 10);
    assert.equal(await code().locator('tr.removed-row').count(), 0);
    await page.getByRole('button', { name: 'Unified', exact: true }).click();
    await code().locator('table.diff-unified').waitFor();
  });

  it('highlights the words added to an extended sentence', async () => {
    await notes().locator('table.diff').waitFor();
    const added = notes().locator('tr.line.add .code-text');
    await until(async () => (await added.locator('.wd').count()) > 0, 'the added words to be highlighted');
    assert.equal(errors.length, 0, errors.join('\n'));
  });
});

async function until(check: () => Promise<boolean>, what: string, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.fail(`timed out waiting for ${what}`);
}
