/**
 * Drives the built UI in headless Chromium against a real server and a real repository.
 * Claude is simulated through the same agent API its Phase 3 tools will call.
 *
 *   npm run build && npm run test:e2e
 *
 * Needs Playwright's Chromium and its system libraries: `npx playwright install --with-deps chromium`.
 * Screenshots of each step land in e2e/screenshots/.
 */
import { strict as assert } from 'node:assert';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Locator, type Page } from 'playwright';
import { startServer, type RunningServer } from '../src/server/server.ts';
import type { Fixture } from '../test/helpers.ts';
import { makeDemoRepo } from './fixture.ts';

const SHOTS = fileURLToPath(new URL('./screenshots/', import.meta.url));

const fileId = (path: string) => `[id="file-${encodeURIComponent(path).replace(/%/g, '_')}"]`;

async function until(check: () => Promise<boolean> | boolean, what: string, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.fail(`timed out waiting for ${what}`);
}

describe('postil UI', { timeout: 120_000 }, () => {
  let fx: Fixture;
  let server: RunningServer;
  let browser: Browser;
  let page: Page;
  const pageErrors: string[] = [];

  const agent = async <T = Record<string, unknown>>(method: string, path: string, body?: unknown): Promise<T> => {
    const res = await fetch(`${server.info.url}${path}`, {
      method,
      headers: { authorization: `Bearer ${server.info.token}`, ...(body !== undefined && { 'content-type': 'application/json' }) },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    const json = (await res.json()) as T;
    assert.ok(res.ok, `${method} ${path} failed: ${JSON.stringify(json)}`);
    return json;
  };
  const shot = (name: string) => page.screenshot({ path: `${SHOTS}${name}.png`, fullPage: false });
  const file = (path: string): Locator => page.locator(fileId(path));
  /** A unified-view row by its new-file line number. */
  const newLine = (path: string, no: number) => file(path).locator(`tr.line:has(td.num:nth-child(2)[data-no="${no}"])`);

  before(async () => {
    mkdirSync(SHOTS, { recursive: true });
    fx = makeDemoRepo();
    server = await startServer({ cwd: fx.dir, port: 0, pollMs: 200 });
    try {
      browser = await chromium.launch();
    } catch (e) {
      throw new Error(`Chromium failed to start. Install it with \`npx playwright install --with-deps chromium\`.\n${e}`);
    }
    page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    page.on('pageerror', (e) => pageErrors.push(String(e)));
    page.on('requestfailed', (r) => pageErrors.push(`request failed: ${r.url()} ${r.failure()?.errorText}`));
    page.on('console', (m) => m.type() === 'error' && pageErrors.push(m.text()));
  });

  after(async () => {
    await browser?.close();
    await server?.close();
    fx?.cleanup();
  });

  it('loads every changed file and scrubs the token from the address bar', async () => {
    await page.goto(server.uiUrl);
    await page.locator('section.file').first().waitFor();
    assert.equal(await page.locator('section.file').count(), 6);
    assert.equal(new URL(page.url()).hash, '', 'token removed from the URL');
    assert.ok(await page.evaluate(() => localStorage.getItem('postil.token')), 'token kept for this origin');
    assert.match(await page.locator('.diff-summary').innerText(), /6 files changed/);
    await shot('01-loaded');
  });

  it('expands hidden context and recollapses it', async () => {
    const retry = file('src/retry.ts');
    await retry.scrollIntoViewIfNeeded();
    await retry.locator('tr.expander-row').first().waitFor();
    const middle = retry.locator('tr.expander-row', { hasText: 'Show all' }).first();
    const hiddenBefore = await retry.locator('tr.line').count();
    await middle.getByRole('button', { name: /Show all/ }).click();
    await retry.locator('tr.collapse-row').first().waitFor();
    const revealed = await retry.locator('tr.line.revealed').count();
    assert.ok(revealed >= 20, `revealed ${revealed} lines`);
    await shot('02-expanded');

    await retry.locator('tr.collapse-row button').first().click();
    await until(async () => (await retry.locator('tr.line').count()) === hiddenBefore, 'lines to collapse again');
    assert.equal(await retry.locator('tr.collapse-row').count(), 0);
  });

  it('expands a whole file and collapses it again from the file header', async () => {
    const retry = file('src/retry.ts');
    await retry.getByRole('button', { name: 'Expand all' }).click();
    await until(async () => (await retry.locator('tr.expander-row').count()) === 0, 'no expanders left');
    await retry.getByRole('button', { name: 'Collapse all' }).click();
    await until(async () => (await retry.locator('tr.expander-row').count()) > 0, 'expanders to return');
  });

  it('comments on a range selected by dragging the line numbers', async () => {
    const db = file('src/db.ts');
    await db.scrollIntoViewIfNeeded();
    const from = await newLine('src/db.ts', 5).locator('td.num').nth(1).boundingBox();
    const to = await newLine('src/db.ts', 9).locator('td.num').nth(1).boundingBox();
    assert.ok(from && to);
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 5 });
    await page.mouse.up();

    const composer = db.locator('.thread-new');
    await composer.waitFor();
    assert.match(await composer.innerText(), /lines 5–9/);
    assert.equal(await db.locator('tr.line.selected').count(), 5);
    await composer.locator('textarea').fill('Should `close()` failures be swallowed here?');
    await shot('03-composer');
    await composer.getByRole('button', { name: 'Add review comment' }).click();

    const thread = db.locator('.thread:not(.thread-new)');
    await thread.waitFor();
    assert.match(await thread.innerText(), /Pending/);
    assert.match(await thread.innerText(), /close\(\)/);
    await until(async () => /Finish review\s*1/.test(await page.locator('.topbar').innerText()), 'pending count in the header');
  });

  it('proposes a suggested change and renders it as a diff', async () => {
    const retry = file('src/retry.ts');
    await retry.scrollIntoViewIfNeeded();
    const row = newLine('src/retry.ts', 6);
    await row.hover();
    await row.locator('.add-comment').dispatchEvent('mousedown', { button: 0 });
    await page.mouse.up();
    const composer = retry.locator('.thread-new');
    await composer.waitFor();
    await composer.getByRole('button', { name: 'Suggest change' }).click();
    const textarea = composer.locator('textarea');
    const seeded = await textarea.inputValue();
    assert.match(seeded, /```suggestion\n {2}baseDelayMs\?: number;\n```/);
    await textarea.fill(seeded.replace('baseDelayMs?: number;', 'baseDelayMs?: number; // default 100'));
    await composer.getByRole('button', { name: 'Preview' }).click();
    await composer.locator('.suggestion').waitFor();
    await composer.getByRole('button', { name: 'Add review comment' }).click();
    const suggestion = retry.locator('.thread:not(.thread-new) .suggestion');
    await suggestion.waitFor();
    assert.equal(await suggestion.locator('tr.del').count(), 1);
    assert.match(await suggestion.locator('tr.add').innerText(), /default 100/);
    await shot('04-suggestion');
  });

  it('submits the review, and shows it waiting for Claude', async () => {
    await page.getByRole('button', { name: /Finish review/ }).click();
    const panel = page.locator('.review-panel');
    await panel.waitFor();
    assert.match(await panel.innerText(), /2 pending comments/);
    await panel.locator('textarea').fill('Nice work. Two questions.');
    await shot('05-review-panel');
    await panel.getByRole('button', { name: 'Submit review' }).click();
    await page.locator('.claude-status.waiting').waitFor();
    assert.match(await page.locator('.claude-status').innerText(), /Waiting for Claude: #1/);
    assert.equal(await page.locator('.chip-pending').count(), 0, 'nothing is pending after submit');
  });

  it('follows Claude live as it picks up, replies to and completes the review', async () => {
    const review = await agent<{ threads: Array<{ id: number; path: string }> }>('GET', '/api/agent/reviews/1');
    await page.locator('.claude-status.working').waitFor();
    await shot('06-claude-working');

    const dbThread = review.threads.find((t) => t.path === 'src/db.ts')!;
    const retryThread = review.threads.find((t) => t.path === 'src/retry.ts')!;
    await agent('POST', `/api/agent/threads/${dbThread.id}/reply`, { body: 'No: errors from `close()` now propagate. Want them logged instead?', needs_decision: true });
    await agent('POST', `/api/agent/threads/${retryThread.id}/reply`, { body: 'Applied the suggestion.' });
    await agent('POST', '/api/agent/reviews/1/complete', { summary: 'Answered both threads; one needs your call.' });

    // A finished review stays announced until dismissed, with a way to see what Claude changed.
    const finished = page.locator('.banner-done', { hasText: 'Claude finished review #1' });
    await finished.waitFor();
    assert.equal(await finished.getByRole('button', { name: 'Show changes since review #1' }).count(), 1);
    const db = file('src/db.ts');
    await until(async () => /now propagate/.test(await db.innerText()), "Claude's reply in the db.ts thread");
    assert.match(await db.locator('.thread').innerText(), /Needs your decision/);
    assert.match(await page.locator('.claude-status').innerText(), /not listening/, 'no Claude session is connected in this test');
    await shot('07-claude-replied');
    await finished.getByTitle('Dismiss').click();
    await until(async () => (await finished.count()) === 0, 'the banner to go');
  });

  it('notices files changing on disk and keeps outdated comments visible in the diff', async () => {
    fx.write('src/db.ts', `import { open } from './driver.ts';\n\nexport const query = async (sql: string) => (await open()).all(sql);\n`);
    await page.locator('.banner', { hasText: 'Files changed on disk' }).waitFor();
    await page.locator('.banner').getByRole('button', { name: 'Refresh' }).click();
    const db = file('src/db.ts');
    // The comment stays inline, re-anchored to where its code now is, and can show what changed.
    const thread = db.locator('.thread', { hasText: 'close()' });
    await thread.locator('.chip-outdated').waitFor();
    await thread.getByRole('button', { name: 'Show what changed' }).click();
    const changed = thread.locator('.what-changed');
    await changed.waitFor();
    assert.match((await changed.locator('tr.del').allInnerTexts()).join('\n'), /try \{/, 'the original lines are shown as removed');
    await thread.scrollIntoViewIfNeeded();
    await shot('08-outdated');
  });

  it('narrows the view to changes since the last review', async () => {
    await page.locator('.scope-picker select').selectOption('since_review:latest');
    await until(async () => (await page.locator('section.file').count()) === 1, 'only files changed since review #1');
    assert.equal(await page.locator('section.file .file-path').innerText(), 'src/db.ts');
    await page.locator('.scope-picker select').selectOption('all');
    await until(async () => (await page.locator('section.file').count()) === 6, 'all files again');
  });

  it('marks a file viewed, folding it and counting it in the sidebar', async () => {
    const readme = file('README.md');
    await readme.scrollIntoViewIfNeeded();
    await readme.getByLabel('Viewed').check();
    await until(async () => (await readme.locator('.file-body').count()) === 0, 'README to fold');
    assert.match(await page.locator('.sidebar-head').innerText(), /1\/6 viewed/);
    assert.equal(await page.locator('.tree-file.is-viewed').count(), 1);
  });

  it('collapses and expands every folder in the tree', async () => {
    const rowsBefore = await page.locator('.tree-row').count();
    await page.getByTitle('Collapse all folders').click();
    await until(async () => (await page.locator('.tree-row').count()) < rowsBefore, 'the tree to collapse');
    assert.deepEqual(await page.locator('.tree-row .tree-name').allInnerTexts(), ['src', 'README.md']);
    await shot('09-tree-collapsed');
    await page.getByTitle('Expand all folders').click();
    await until(async () => (await page.locator('.tree-row').count()) === rowsBefore, 'the tree to expand');
  });

  it('lists conversations, filters them, and resolves one', async () => {
    await page.getByRole('button', { name: /Conversations/ }).click();
    const panel = page.locator('.side-panel');
    await panel.locator('.panel-filters').getByRole('button', { name: /Your turn/ }).click();
    await until(async () => (await panel.locator('.panel-item').count()) === 2, 'two threads awaiting me');
    // Collapsed, every conversation is the same two lines: where, then the latest comment.
    assert.equal(await panel.locator('.thread.is-collapsed .thread-peek').count(), 2);
    const thread = panel.locator('.panel-item', { hasText: 'src/retry.ts' }).locator('.thread');
    await thread.locator('.thread-head').click();
    await thread.locator('.thread-body').waitFor();
    // The code it was written on, in the diff of the time.
    await thread.getByRole('button', { name: 'Original diff' }).click();
    await until(async () => (await thread.locator('.thread-diff tr.line.selected').count()) > 0, 'the commented lines in the original diff');
    await shot('10-conversations');
    await thread.getByRole('button', { name: 'Resolve conversation' }).click();
    await until(async () => (await panel.locator('.panel-item').count()) === 1, 'the resolved thread to leave "Your turn"');
    await panel.locator('.panel-filters').getByRole('button', { name: /^Resolved/ }).click();
    await until(async () => (await panel.locator('.panel-item').count()) === 1, 'it to appear under Resolved');
    await page.keyboard.press('Escape');
  });

  it('toggles the layout with one key and restores state after a reload', async () => {
    await page.locator('body').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('s');
    await page.locator('table.diff-split').first().waitFor();
    await until(async () => (await agent<{ value: unknown }>('GET', '/api/ui-state/view')).value === 'split', 'the layout to be saved');
    await page.goto(server.info.url + '/');
    await page.locator('table.diff-split').first().waitFor({ timeout: 8000 });
    assert.equal(await page.locator('table.diff-unified:not(.suggestion-diff)').count(), 0, 'split view restored everywhere');
    assert.equal(await page.locator('.tree-file.is-viewed').count(), 1, 'viewed mark restored');
    await shot('11-split-after-reload');
  });

  it('keeps a comment with its code when lines are added above it', async () => {
    await page.locator('.scope-picker select').selectOption('all');
    const scope = await agent<{ from: { tree: string }; to: { tree: string } }>('POST', '/api/diff/resolve', { scope: { kind: 'all' } });
    await agent('POST', '/api/threads', {
      from_tree: scope.from.tree, to_tree: scope.to.tree, path: 'src/text/strings.ts', side: 'new', start_line: 3,
      body: 'Is `lower` used anywhere?',
    });
    fx.write('src/text/strings.ts', '// String helpers.\n\nexport const trim = (s: string) => s.trim();\nexport const upper = (s: string) => s.toUpperCase();\nexport const lower = (s: string) => s.toLowerCase();\n');
    await page.locator('.banner', { hasText: 'Files changed on disk' }).waitFor();
    await page.locator('.banner').getByRole('button', { name: 'Refresh' }).click();
    const thread = file('src/text/strings.ts').locator('.thread', { hasText: 'lower' });
    await until(async () => /L5 \(moved\)/.test(await thread.innerText()), 'the comment to follow its line to L5');
    assert.equal(await thread.locator('.chip-outdated').count(), 0, 'moved, not outdated: the code itself is unchanged');
  });

  it('applies a suggestion from the UI', async () => {
    const scope = await agent<{ from: { tree: string }; to: { tree: string } }>('POST', '/api/diff/resolve', { scope: { kind: 'all' } });
    await agent('POST', '/api/threads', {
      from_tree: scope.from.tree, to_tree: scope.to.tree, path: 'src/time.ts', side: 'new', start_line: 1,
      body: 'Name the resolver:\n```suggestion\nexport const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));\n```',
    });
    const time = file('src/time.ts');
    await time.scrollIntoViewIfNeeded();
    const apply = time.getByRole('button', { name: 'Apply suggestion' });
    await apply.waitFor();
    await shot('12-suggestion-apply');
    await apply.click();
    await page.locator('.toast', { hasText: 'Suggestion applied to src/time.ts' }).waitFor();
    await time.locator('.suggestion .chip-resolved', { hasText: 'Applied' }).waitFor();
    assert.match(readFileSync(join(fx.dir, 'src/time.ts'), 'utf8'), /\(resolve\) => setTimeout\(resolve, ms\)/);
  });

  it('marks files that changed since the last review', async () => {
    await page.locator('.banner').getByRole('button', { name: 'Refresh' }).click().catch(() => undefined);
    await until(async () => (await file('src/db.ts').locator('.chip-updated').count()) === 1, 'db.ts to be marked updated');
    assert.equal(await file('README.md').locator('.chip-updated').count(), 0, 'README has not changed since the review');
    assert.ok((await page.locator('.tree-file', { hasText: 'db.ts' }).locator('.tree-updated').count()) === 1);
  });

  it('picks a range of commits', async () => {
    fx.git('add', 'README.md');
    fx.git('commit', '-q', '-m', 'Document the backoff');
    fx.git('add', 'src/time.ts');
    fx.git('commit', '-q', '-m', 'Add sleep');
    await page.locator('.scope-picker select').selectOption('pick');
    const picker = page.locator('.commit-picker');
    await picker.locator('.commit-row').nth(2).waitFor();
    assert.deepEqual(
      (await picker.locator('.commit-subject').allInnerTexts()).map((t) => t.trim()),
      ['Uncommitted changes', 'Add sleep', 'Document the backoff'],
    );
    await picker.locator('.commit-row', { hasText: 'Add sleep' }).click();
    await shot('13-commit-picker');
    await picker.getByRole('button', { name: 'Show changes' }).click();
    await until(async () => (await page.locator('section.file').count()) === 1, 'one file in the newest commit');
    assert.equal(await page.locator('section.file .file-path').innerText(), 'src/time.ts');

    await page.locator('.scope-picker select').selectOption('pick');
    await picker.locator('.commit-row', { hasText: 'Add sleep' }).click();
    await picker.locator('.commit-row', { hasText: 'Document the backoff' }).click({ modifiers: ['Shift'] });
    await picker.getByRole('button', { name: 'Show changes' }).click();
    await until(async () => (await page.locator('section.file').count()) === 2, 'both commits');
    assert.match(await page.locator('.scope-picker select').inputValue(), /commits/);
    await page.locator('.scope-picker select').selectOption('all');
  });

  it('measures all changes from a branch chosen in the header', async () => {
    const original = await agent<{ commit: string }>('GET', '/api/base');
    fx.git('branch', 'develop', 'HEAD~1');
    const picker = page.locator('.base-picker select');
    await picker.focus(); // reloads the branch list
    await until(async () => (await picker.locator('option', { hasText: 'develop' }).count()) === 1, 'develop in the list');
    await picker.selectOption('develop');
    // Measured from develop, the README commit is no longer part of "all changes".
    await until(async () => (await page.locator('section.file').count()) === 5, 'five files since develop');
    assert.equal(await page.locator(fileId('README.md')).count(), 0);
    assert.equal(await picker.inputValue(), 'develop');
    assert.equal(await page.locator('.banner').count(), 0, 'a change made here does not ask for a refresh');
    await shot('13b-base-picker');

    await agent('PUT', '/api/base', { rev: original.commit });
    await until(async () => (await page.locator('.banner').count()) === 1, 'a change made elsewhere offers a refresh');
    await page.locator('.banner button').click();
    await until(async () => (await page.locator('section.file').count()) === 6, 'back to six files');
  });

  it('marks sections done, folds them, and keeps them done through edits elsewhere', async () => {
    await page.locator('body').click({ position: { x: 5, y: 5 } });
    if (await page.locator('table.diff-split').count()) await page.keyboard.press('s'); // back to unified
    const retry = file('src/retry.ts');
    await retry.scrollIntoViewIfNeeded();
    await retry.locator('.done-toggle').first().waitFor();
    const sections = await retry.locator('.done-toggle').count();
    assert.ok(sections >= 3, `retry.ts has ${sections} sections`);

    await retry.locator('.done-toggle').first().click();
    await retry.locator('.done-row').first().waitFor();
    assert.match(await retry.locator('.chip-sections').innerText(), new RegExp(`1/${sections} sections done`));
    await shot('14-section-done');

    await retry.locator('.done-row').getByRole('button', { name: 'Show' }).click();
    await until(async () => (await retry.locator('.done-row').count()) === 0, 'the section to unfold');
    await retry.getByRole('button', { name: 'Fold' }).first().click();
    await retry.locator('.done-row').first().waitFor();

    // Claude edits the end of the file: the first section is untouched and stays done.
    fx.write('src/retry.ts', readFileSync(join(fx.dir, 'src/retry.ts'), 'utf8') + 'export const EXTRA = 1;\n');
    await page.locator('.banner', { hasText: 'Files changed on disk' }).waitFor();
    await page.locator('.banner').getByRole('button', { name: 'Refresh' }).click();
    await until(async () => (await page.locator('.banner').count()) === 0, 'the refresh to finish');
    await until(async () => /1\/\d+ sections done/.test(await retry.locator('.chip-sections').innerText().catch(() => '')), 'the mark to survive the edit');
    assert.equal(await retry.locator('.done-row').count(), 1);

    // Finishing the last section finishes the file.
    const viewedBefore = await page.locator('.tree-file.is-viewed').count();
    for (let left = await retry.locator('.done-toggle:not(.on)').count(); left > 0; left--) {
      await retry.locator('.done-toggle:not(.on)').first().click();
      // Wait for this mark to land (or for the file to fold, after the last one) before the next.
      await until(async () => (await retry.locator('.done-toggle:not(.on)').count()) < left, 'the section to be marked');
    }
    await until(async () => (await page.locator('.tree-file.is-viewed').count()) === viewedBefore + 1, 'retry.ts to be marked viewed');
  });

  it('colours code by language', async () => {
    const db = file('src/db.ts');
    await db.scrollIntoViewIfNeeded();
    await until(async () => (await db.locator('.tk').count()) > 0, 'syntax colours in db.ts');
    const colour = await db.locator('.tk').first().evaluate((el) => getComputedStyle(el).color);
    assert.notEqual(colour, '', 'tokens carry a colour');
  });

  it('holds back a huge diff until asked', async () => {
    fx.write('src/generated.ts', Array.from({ length: 1600 }, (_, i) => `export const g${i} = ${i};`).join('\n') + '\n');
    await page.locator('.banner', { hasText: 'Files changed on disk' }).waitFor();
    await page.locator('.banner').getByRole('button', { name: 'Refresh' }).click();
    const big = file('src/generated.ts');
    await big.scrollIntoViewIfNeeded();
    await big.getByText(/Large diff: 1,600 changed lines/).waitFor();
    assert.equal(await big.locator('table.diff').count(), 0);
    await big.getByRole('button', { name: 'Load diff' }).click();
    await big.locator('table.diff').waitFor();
  });

  it('answers the keyboard', async () => {
    await page.locator('body').click({ position: { x: 5, y: 5 } });
    await page.evaluate(() => document.querySelector('main.main')!.scrollTo(0, 0));
    const currentIndex = () =>
      page.evaluate(() => {
        const top = document.querySelector('main.main')!.getBoundingClientRect().top + 40;
        return [...document.querySelectorAll('section.file')].findIndex((f) => f.getBoundingClientRect().bottom > top);
      });
    const start = await currentIndex();
    await page.keyboard.press('j');
    await until(async () => (await currentIndex()) === start + 1, 'j to move to the next file');
    await page.keyboard.press('k');
    await until(async () => (await currentIndex()) === start, 'k to move back');
    await page.keyboard.press('?');
    await page.getByRole('dialog', { name: 'Keyboard shortcuts' }).waitFor();
    await shot('15-keyboard-help');
    await page.keyboard.press('Escape');
    await until(async () => (await page.getByRole('dialog', { name: 'Keyboard shortcuts' }).count()) === 0, 'help to close');
  });

  it('archives resolved conversations, keeping them findable', async () => {
    await page.getByRole('button', { name: /Conversations/ }).click();
    const panel = page.locator('.side-panel');
    await panel.locator('.panel-filters').getByRole('button', { name: /^Resolved/ }).click();
    const archive = panel.getByRole('button', { name: /Archive resolved/ });
    await archive.waitFor();
    await archive.click();
    await page.locator('.toast', { hasText: /Archived 1 conversation/ }).waitFor();
    await until(async () => (await panel.locator('.panel-item').count()) === 0, 'resolved list to empty');
    await panel.locator('.panel-filters').getByRole('button', { name: 'Archived' }).click();
    await until(async () => (await panel.locator('.panel-item').count()) === 1, 'the archived conversation to be listed');
    await page.keyboard.press('Escape');
  });

  it('explains what to do when opened without a token', async () => {
    const stranger = await browser.newPage();
    await stranger.goto(server.info.url + '/');
    await stranger.getByText('postil url').waitFor();
    await stranger.close();
  });

  it('raised no errors in the page', () => {
    assert.deepEqual(pageErrors, []);
  });
});
