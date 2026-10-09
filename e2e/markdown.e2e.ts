/**
 * Reviewing a Markdown file rendered: commenting on its blocks, and those comments in the diff.
 *
 *   npm run build && npm run test:e2e
 */
import { strict as assert } from 'node:assert';
import { mkdirSync } from 'node:fs';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Locator, type Page } from 'playwright';
import type { ThreadView } from '../src/core/api-types.ts';
import { startServer, type RunningServer } from '../src/server/server.ts';
import { makeFixture, type Fixture } from '../test/helpers.ts';

const SHOTS = fileURLToPath(new URL('./screenshots/', import.meta.url));

const before_ = `# Setup guide

Install the tool with npm.

## Usage

Deprecated note.

- Run \`postil\` in a repository.
- Open the page it prints.

Old closing words.
`;
const after_ = `# Setup guide

Install the tool with npm, then link it.

## Usage

- Run \`postil\` in a repository.
- Open the page it prints.
- Leave comments.

| Key | Action |
| --- | ------ |
| j   | Next   |
`;

describe('rendered Markdown review', { timeout: 120_000 }, () => {
  let fx: Fixture;
  let server: RunningServer;
  let browser: Browser;
  let page: Page;
  const pageErrors: string[] = [];
  const file = (): Locator => page.locator('section.file[data-path="docs/guide.md"]');

  before(async () => {
    mkdirSync(SHOTS, { recursive: true });
    fx = makeFixture();
    fx.write('docs/guide.md', before_);
    fx.commit('base');
    fx.write('docs/guide.md', after_);
    server = await startServer({ cwd: fx.dir, port: 0, pollMs: 200 });
    browser = await chromium.launch();
    page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    page.on('pageerror', (e) => pageErrors.push(String(e)));
    page.on('console', (m) => m.type() === 'error' && pageErrors.push(m.text()));
  });

  after(async () => {
    await browser?.close();
    await server?.close();
    fx?.cleanup();
  });

  it('renders the file with its changed blocks marked', async () => {
    await page.goto(server.uiUrl);
    await file().locator('table.diff').waitFor();
    await file().locator('[data-action="rendered"]').click();
    const blocks = file().locator('.md-block');
    await blocks.first().waitFor();
    assert.equal(await file().locator('table.diff').count(), 0, 'the diff is replaced');
    assert.equal(await file().locator('h1').textContent(), 'Setup guide');
    assert.deepEqual(await blocks.evaluateAll((els) => els.map((e) => `${e.getAttribute('data-start')}-${e.getAttribute('data-end')}`)),
      ['1-1', '3-3', '5-5', '7-7', '8-8', '9-9', '11-13']);
    assert.deepEqual(await file().locator('.md-block.changed').evaluateAll((els) => els.map((e) => e.getAttribute('data-start'))), ['3', '9', '11']);
    assert.equal(await file().locator('.md-block.removed-before').getAttribute('data-start'), '7');
    assert.match((await file().locator('.md-removed').getAttribute('title')) ?? '', /2 lines removed above/);
    await page.screenshot({ path: `${SHOTS}markdown-rendered.png` });
  });

  it('comments on a range of blocks, as a comment on their source lines', async () => {
    const item = file().locator('.md-block[data-start="8"]');
    await item.hover();
    await item.locator('.md-add-comment').click();
    const next = file().locator('.md-block[data-start="9"]');
    await next.hover();
    await next.locator('.md-add-comment').click({ modifiers: ['Shift'] });
    assert.equal(await file().locator('.md-block.selected').count(), 2);
    const composer = file().locator('.thread-new');
    await composer.locator('textarea').waitFor();
    assert.match((await composer.locator('.thread-head').textContent()) ?? '', /lines 8–9/);
    await composer.locator('textarea').fill('Say where the comments go.');
    await composer.getByRole('button', { name: 'Add review comment' }).click();
    const thread = file().locator('.md-attach .thread[id^="thread-"]');
    await thread.waitFor();
    assert.ok(await file().locator('.md-block[data-start="9"] + .md-attach').count(), 'shown under the last block');
    await page.screenshot({ path: `${SHOTS}markdown-comment.png` });

    const res = await fetch(`${server.info.url}/api/threads`, { headers: { authorization: `Bearer ${server.info.token}` } });
    const { threads } = (await res.json()) as { threads: ThreadView[] };
    assert.deepEqual(threads.map((t) => [t.path, t.side, t.start_line, t.end_line]), [['docs/guide.md', 'new', 8, 9]]);
  });

  it('shows the same comment in the source diff', async () => {
    await file().locator('[data-action="rendered"]').click();
    await file().locator('table.diff').waitFor();
    await file().locator('tr.attach-row .thread[id^="thread-"]').waitFor();
    assert.deepEqual(pageErrors, []);
  });
});
