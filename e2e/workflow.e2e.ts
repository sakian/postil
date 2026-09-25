/**
 * The reviewing workflow end to end on a review with enough files to scroll: navigation that
 * stays put, word highlights, sections, whole-file comments, unsent text that survives a slip,
 * and finishing the session.
 *   npm run build && node --test e2e/workflow.e2e.ts
 */
import { strict as assert } from 'node:assert';
import { mkdirSync } from 'node:fs';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Locator, type Page } from 'playwright';
import { WebSocket } from 'ws';
import type { ResolvedDiff, ThreadView } from '../src/core/api-types.ts';
import { startServer, type RunningServer } from '../src/server/server.ts';
import { makeFixture, numbered, type Fixture } from '../test/helpers.ts';

const SHOTS = fileURLToPath(new URL('./screenshots/', import.meta.url));
const FILES = Array.from({ length: 12 }, (_, i) => `pkg/f${String(i + 1).padStart(2, '0')}.ts`);

async function until(check: () => Promise<boolean> | boolean, what: string, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.fail(`timed out waiting for ${what}`);
}

describe('the reviewing workflow', { timeout: 180_000 }, () => {
  let fx: Fixture;
  let server: RunningServer;
  let browser: Browser;
  let page: Page;
  let questionId: number;
  const errors: string[] = [];

  const api = async <T = unknown>(method: string, path: string, body?: unknown): Promise<T> => {
    const res = await fetch(`${server.info.url}${path}`, {
      method,
      headers: { authorization: `Bearer ${server.info.token}`, ...(body !== undefined && { 'content-type': 'application/json' }) },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    const json = (await res.json()) as T;
    assert.ok(res.ok, `${method} ${path} failed: ${JSON.stringify(json)}`);
    return json;
  };
  const file = (path: string): Locator => page.locator(`[id="file-${encodeURIComponent(path).replace(/%/g, '_')}"]`);
  /** Go to a file from the sidebar, as a reader would, and wait for its diff. */
  const show = async (path: string) => {
    await page.locator('.tree-file', { hasText: path.split('/').pop()! }).click();
    await file(path).locator('table.diff').waitFor();
  };
  /** How far a file's top is below the top of the scrolling pane. */
  const offset = async (path: string) =>
    (await file(path).evaluate((el) => el.getBoundingClientRect().top - el.closest('main')!.getBoundingClientRect().top));

  before(async () => {
    mkdirSync(SHOTS, { recursive: true });
    fx = makeFixture();
    for (const f of FILES) fx.write(f, numbered(80));
    fx.commit('base');
    for (const f of FILES) fx.write(f, numbered(80, { 5: 'line five', 60: 'line sixty' }));
    server = await startServer({ cwd: fx.dir, port: 0, pollMs: 200 });

    // A question Claude has answered, so it is the user's turn.
    const diff = await api<ResolvedDiff>('POST', '/api/diff/resolve', { scope: { kind: 'all' } });
    const t = await api<ThreadView>('POST', '/api/threads', {
      from_tree: diff.from.tree, to_tree: diff.to.tree, path: 'pkg/f02.ts', side: 'new', start_line: 5, end_line: 5, body: 'Why "five"?',
    });
    questionId = t.id;
    await api('POST', '/api/reviews/submit', { body: '' });
    await api('GET', '/api/agent/reviews/1');
    await api('POST', `/api/agent/threads/${t.id}/reply`, { body: 'Spelled out for readability. Keep it?' });
    await api('POST', '/api/agent/reviews/1/complete', { summary: 'Answered.' });

    browser = await chromium.launch();
    page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(server.uiUrl);
    await file(FILES[0]!).locator('table.diff').waitFor();
  });
  after(async () => {
    await browser?.close();
    await server?.close();
    fx?.cleanup();
  });

  it('highlights the words that changed within a line', async () => {
    const f = file(FILES[0]!);
    assert.deepEqual(await f.locator('tr.line.del .wd').allInnerTexts(), ['5', '60']);
    assert.deepEqual(await f.locator('tr.line.add .wd').allInnerTexts(), ['five', 'sixty']);
    await page.screenshot({ path: `${SHOTS}21-word-diff.png` });
  });

  it('keeps each section header, with its "Mark done", stuck in view while reading it', async () => {
    const position = await file(FILES[0]!).locator('.sticky-hunk td').first().evaluate((el) => getComputedStyle(el).position);
    assert.equal(position, 'sticky');
  });

  it('goes to a file clicked in the sidebar and stays there as the files around it load', async () => {
    await page.locator('.tree-file', { hasText: 'f10.ts' }).click();
    await page.waitForTimeout(1500);
    assert.ok(Math.abs(await offset('pkg/f10.ts')) < 40, `f10 is at the top (off by ${await offset('pkg/f10.ts')}px)`);
  });

  it('stops asking for your turn once you have replied, even before submitting', async () => {
    await show('pkg/f02.ts');
    const thread = file('pkg/f02.ts').locator('.thread', { hasText: 'Why "five"?' });
    await thread.locator('.chip-you').waitFor();
    await thread.locator('.reply-stub').click();
    await thread.locator('textarea').fill('Yes, keep it.');
    await thread.getByRole('button', { name: 'Add reply' }).click();
    await until(async () => (await thread.locator('.chip-you').count()) === 0, 'the "Your turn" chip to go');
    await page.getByRole('button', { name: /Conversations/ }).click();
    const yours = page.locator('.panel-filters').getByRole('button', { name: /Your turn/ });
    assert.match(await yours.innerText(), /Your turn\s*0/);
    await page.keyboard.press('Escape');
  });

  it('collapses the conversations in a section marked done', async () => {
    const f = file('pkg/f02.ts');
    await f.locator('.done-toggle').first().click();
    await f.locator('.done-row').first().waitFor();
    await f.locator('.done-row + .attach-row .thread.is-collapsed').waitFor();
    await page.screenshot({ path: `${SHOTS}22-done-section.png` });
  });

  it('treats "Viewed" as every section done: hides the count, and unviewing starts the file over', async () => {
    const f = file('pkg/f02.ts');
    await f.locator('.chip-sections', { hasText: '1/2 sections done' }).waitFor();
    await f.locator('[data-action="viewed"]').check();
    await until(async () => (await f.locator('.chip-sections').count()) === 0, 'the section count to go');
    await f.locator('[data-action="viewed"]').uncheck();
    await f.locator('table.diff').waitFor();
    await until(async () => (await f.locator('.done-toggle.on').count()) === 0, 'every section to be not done again');
  });

  it('keeps the page on a file folded from the middle of it', async () => {
    await show('pkg/f04.ts');
    const f = file('pkg/f04.ts');
    await page.mouse.move(800, 500);
    await page.mouse.wheel(0, 600); // well into its body, its header stuck to the top
    await until(async () => (await offset('pkg/f04.ts')) < -500, 'the scroll');
    await f.locator('[data-action="viewed"]').check();
    await page.waitForTimeout(300);
    assert.ok(Math.abs(await offset('pkg/f04.ts')) < 40, `f04 stays at the top (off by ${await offset('pkg/f04.ts')}px)`);
  });

  it('comments on a whole file', async () => {
    await show('pkg/f05.ts');
    const f = file('pkg/f05.ts');
    await f.locator('[data-action="file-comment"]').click();
    const composer = f.locator('.thread-new', { hasText: 'Comment on the whole file' });
    await composer.locator('textarea').fill('Does not follow the naming standard.');
    await composer.getByRole('button', { name: 'Add review comment' }).click();
    const thread = f.locator('.file-threads .thread:not(.thread-new)', { hasText: 'naming standard' });
    await thread.waitFor();
    assert.match(await thread.locator('.thread-head').innerText(), /File/);
  });

  it('can undo discarding an unsent comment', async () => {
    await show('pkg/f06.ts');
    const f = file('pkg/f06.ts');
    await f.locator('tr.line:has(td.num:nth-child(2)[data-no="60"]) td.num').nth(1).click();
    const composer = f.locator('.thread-new');
    await composer.locator('textarea').fill('Half a thought');
    await composer.locator('textarea').press('Escape');
    await until(async () => (await composer.count()) === 0, 'the composer to close');
    await page.locator('.toast', { hasText: 'Discarded' }).getByRole('button', { name: 'Undo' }).click();
    assert.equal(await f.locator('.thread-new textarea').inputValue(), 'Half a thought');
    await f.locator('.thread-new').getByRole('button', { name: 'Add review comment' }).click();
    await f.locator('.thread:not(.thread-new)', { hasText: 'Half a thought' }).waitFor();
  });

  it('shows how many files are left to view in a collapsed folder', async () => {
    await page.locator('.tree-dir', { hasText: 'pkg' }).click();
    const left = await page.locator('.tree-dir .tree-count').innerText();
    await page.screenshot({ path: `${SHOTS}23-folder-count.png`, clip: { x: 0, y: 0, width: 400, height: 300 } });
    assert.equal(left, '11 to view', 'f04 is viewed');
    await page.locator('.tree-dir', { hasText: 'pkg' }).click();
  });

  it('marks every file in a folder viewed at once, and back', async () => {
    const dir = page.locator('.tree-dir', { hasText: 'pkg' });
    const progress = page.locator('.sidebar .progress');
    const before = await progress.innerText();
    await dir.hover();
    await page.screenshot({ path: `${SHOTS}24-folder-viewed.png`, clip: { x: 0, y: 0, width: 400, height: 300 } });
    await dir.getByRole('button', { name: 'Mark pkg viewed' }).click();
    await until(async () => (await page.locator('.tree-file.is-viewed').count()) === 12, 'every file in pkg to be viewed');
    assert.notEqual(await progress.innerText(), before);

    await dir.getByRole('button', { name: 'Mark pkg not viewed' }).click();
    await until(async () => (await page.locator('.tree-file.is-viewed').count()) === 0, 'every file in pkg to be unviewed');
  });

  it('finishes the session once everything is reviewed and resolved', async () => {
    // Claude answers the pending comments, the user resolves everything and views every file.
    const review = await api<{ id: number }>('POST', '/api/reviews/submit', { body: '' });
    const { threads } = await api<{ threads: Array<{ id: number }> }>('GET', `/api/agent/reviews/${review.id}`);
    for (const t of threads) await api('POST', `/api/agent/threads/${t.id}/reply`, { body: 'Done.' });
    await api('POST', `/api/agent/reviews/${review.id}/complete`, { summary: 'All handled.' });
    const all = await api<{ threads: ThreadView[] }>('GET', '/api/threads');
    for (const t of all.threads) await api('POST', `/api/threads/${t.id}/resolve`);
    const diff = await api<ResolvedDiff>('POST', '/api/diff/resolve', { scope: { kind: 'all' } });
    for (const f of diff.files) await api('PUT', '/api/marks/files', { path: f.path, blob: f.new_blob, viewed: true });

    await page.locator('.banner-done', { hasText: 'Claude finished review' }).getByTitle('Dismiss').click();
    const finish = page.locator('.banner-done', { hasText: 'Every file is viewed' });
    await finish.waitFor();
    assert.equal(await finish.locator('.option').count(), 0, 'no commit options without a listening Claude to act on them');
    await finish.getByRole('button', { name: 'Finish session' }).click();
    const done = page.getByRole('dialog', { name: 'Review finished' });
    await done.waitFor();
    await page.screenshot({ path: `${SHOTS}20-finished.png` });
    await done.getByRole('button', { name: 'Done' }).click();
    assert.deepEqual((await api<{ threads: unknown[] }>('GET', '/api/threads')).threads, [], 'everything archived');
    assert.ok(questionId > 0);
  });

  it('raised no errors in the page', () => {
    assert.deepEqual(errors, []);
  });
});

describe('a review with nothing to say', { timeout: 60_000 }, () => {
  let fx: Fixture;
  let server: RunningServer;
  let browser: Browser;
  let claude: WebSocket;
  const heard: Array<Record<string, unknown>> = [];

  before(async () => {
    fx = makeFixture();
    fx.write('a.ts', numbered(10));
    fx.commit('base');
    fx.write('a.ts', numbered(10, { 3: 'line three' }));
    server = await startServer({ cwd: fx.dir, port: 0, pollMs: 200 });
    claude = new WebSocket(`${server.info.url.replace(/^http/, 'ws')}/events?token=${server.info.token}&channel=agent&session=e2e`);
    claude.on('message', (m) => heard.push(JSON.parse(String(m)) as Record<string, unknown>));
    await new Promise((r) => claude.once('open', r));
    browser = await chromium.launch();
  });

  after(async () => {
    claude.close();
    await browser.close();
    await server.close();
    fx.cleanup();
  });

  it('finishes from "Finish review" on the first pass, with the user\'s own instructions for Claude', async () => {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    await page.goto(server.uiUrl);
    await page.locator('table.diff').first().waitFor();
    await page.getByRole('button', { name: 'Finish review' }).click();
    const panel = page.locator('.review-panel');
    await panel.getByText('Nothing to send Claude').waitFor();
    assert.equal(await panel.getByRole('button', { name: 'Submit review' }).count(), 0, 'no dead submit button');
    await panel.locator('.option', { hasText: 'and push' }).click();
    await panel.getByRole('textbox', { name: 'Message to Claude' }).fill('Squash it all into one commit and open a PR');
    assert.ok(await panel.getByRole('checkbox', { name: 'and push' }).isDisabled(), 'the message replaces the options');
    await page.screenshot({ path: `${SHOTS}24-finish-first-pass.png` });

    await panel.getByPlaceholder('Overall comment').fill('One thing');
    await panel.getByRole('button', { name: 'Submit review' }).waitFor();
    await panel.getByPlaceholder('Overall comment').fill('');

    await panel.getByRole('button', { name: 'Finish session' }).click();
    await page.getByRole('dialog', { name: 'Review finished' }).waitFor();
    await until(() => heard.some((e) => e.type === 'session.finished'), 'Claude to hear the session finish');
    assert.deepEqual(heard.find((e) => e.type === 'session.finished'),
      { type: 'session.finished', commit: false, push: false, message: 'Squash it all into one commit and open a PR' });
  });
});
