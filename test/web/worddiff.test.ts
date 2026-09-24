import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { wordDiff, wordHighlights } from '../../web/src/lib/worddiff.ts';

const pick = (s: string, spans: readonly (readonly [number, number])[]) => spans.map(([a, b]) => s.slice(a, b));

describe('wordDiff', () => {
  it('marks only the words that changed', () => {
    const a = 'const delay = base * 2;';
    const b = 'const delay = base * attempt;';
    const w = wordDiff(a, b)!;
    assert.deepEqual(pick(a, w.old), ['2']);
    assert.deepEqual(pick(b, w.new), ['attempt']);
  });

  it('joins neighbouring changed words into one span', () => {
    const a = 'return await conn.all(sql);';
    const b = 'return await conn.all(sql, params);';
    const w = wordDiff(a, b)!;
    assert.deepEqual(w.old, []);
    assert.deepEqual(pick(b, w.new), [', params']);
  });

  it('gives nothing for lines that were rewritten rather than edited', () => {
    assert.equal(wordDiff('import { open } from "./driver";', 'export const x = 42;'), null);
  });

  it('gives nothing for identical lines', () => {
    assert.equal(wordDiff('same', 'same'), null);
  });
});

describe('wordHighlights', () => {
  const line = (kind: 'context' | 'add' | 'del', oldNo: number | null, newNo: number | null, text: string) =>
    ({ type: 'line', kind, oldNo, newNo, text, hunk: 0 });

  it('pairs each removed line with the added line in the same position of the run after it', () => {
    const rows = [
      line('context', 1, 1, 'a'),
      line('del', 2, null, 'let x = 1;'),
      line('del', 3, null, 'let y = 2;'),
      line('add', null, 2, 'let x = 10;'),
      line('add', null, 3, 'let y = 20;'),
      line('add', null, 4, 'let z = 3;'),
    ];
    const h = wordHighlights(rows);
    assert.deepEqual([...h.keys()].sort(), ['new:2', 'new:3', 'old:2', 'old:3']);
  });

  it('does not pair across a context line', () => {
    const rows = [line('del', 1, null, 'let x = 1;'), line('context', 2, 1, 'b'), line('add', null, 2, 'let x = 2;')];
    assert.equal(wordHighlights(rows).size, 0);
  });
});
