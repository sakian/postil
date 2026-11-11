import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import type { DiffLine, Hunk } from '../../src/core/api-types.ts';
import { buildRows, foldRemoved } from '../../web/src/lib/rows.ts';
import { fileSections, rewrittenSections } from '../../web/src/lib/sections.ts';
import { wordPairs } from '../../web/src/lib/worddiff.ts';

/** A hunk of `removed` lines replaced by `added` ones, between two unchanged lines. */
function hunk(removed: string[], added: string[]): Hunk {
  const lines: DiffLine[] = [
    { kind: 'context', old_no: 1, new_no: 1, text: 'before' },
    ...removed.map((text, i): DiffLine => ({ kind: 'del', old_no: 2 + i, new_no: null, text })),
    ...added.map((text, i): DiffLine => ({ kind: 'add', old_no: null, new_no: 2 + i, text })),
    { kind: 'context', old_no: 2 + removed.length, new_no: 2 + added.length, text: 'after' },
  ];
  return { old_start: 1, old_lines: removed.length + 2, new_start: 1, new_lines: added.length + 2, header: '', lines };
}

function rewritten(h: Hunk) {
  const rows = buildRows({ hunks: [h], new_lines: h.new_lines }, { revealed: [], newLines: null });
  const sections = fileSections([h]);
  return { rows, found: rewrittenSections(sections, new Set(wordPairs(rows).map((p) => p.oldNo))) };
}

const oldCode = Array.from({ length: 10 }, (_, i) => `const legacy${i} = computeOld(${i}, cache);`);
const newCode = Array.from({ length: 12 }, (_, i) => `export function handler${i}(req: Request) { return route(req); }`);

describe('rewritten sections', () => {
  it('finds a block replaced by unrelated code', () => {
    assert.deepEqual([...rewritten(hunk(oldCode, newCode)).found], [[0, 10]]);
  });

  it('leaves a block of edited lines alone', () => {
    const edited = oldCode.map((l) => l.replace('cache', 'store'));
    assert.equal(rewritten(hunk(oldCode, edited)).found.size, 0);
  });

  it('leaves small rewrites and pure deletions alone', () => {
    assert.equal(rewritten(hunk(oldCode.slice(0, 5), newCode)).found.size, 0);
    assert.equal(rewritten(hunk(oldCode, [])).found.size, 0);
  });
});

describe('foldRemoved', () => {
  const { rows, found } = rewritten(hunk(oldCode, newCode));
  const shape = (out: ReturnType<typeof foldRemoved>) =>
    out.filter((r) => r.type !== 'expander' && r.type !== 'hunk').map((r) => (r.type === 'line' ? r.kind : `${r.type}${'shown' in r && r.shown ? '+' : ''}`));

  it('folds the removed lines to one row and keeps the added lines', () => {
    assert.deepEqual(shape(foldRemoved(rows, found, new Set())), ['context', 'removed', ...newCode.map(() => 'add'), 'context']);
  });

  it('keeps the removed lines under a control when shown', () => {
    assert.deepEqual(shape(foldRemoved(rows, found, new Set([0]))), ['context', 'removed+', ...oldCode.map(() => 'del'), ...newCode.map(() => 'add'), 'context']);
  });
});
