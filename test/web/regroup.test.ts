import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import type { DiffLine, Hunk } from '../../src/core/api-types.ts';
import { regroup, trivial } from '../../web/src/lib/regroup.ts';

/** A hunk from unified-diff body lines (' ', '-', '+' prefixes), numbered from line 1. */
function hunk(body: string[]): Hunk {
  let o = 1;
  let n = 1;
  const lines = body.map((b): DiffLine => {
    const text = b.slice(1);
    if (b[0] === '-') return { kind: 'del', old_no: o++, new_no: null, text };
    if (b[0] === '+') return { kind: 'add', old_no: null, new_no: n++, text };
    return { kind: 'context', old_no: o++, new_no: n++, text };
  });
  return { old_start: 1, old_lines: o - 1, new_start: 1, new_lines: n - 1, header: '', lines };
}

const render = (h: Hunk) => h.lines.map((l) => `${l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : ' '}${l.text}`);
const block = (prefix: string, name: string, count: number) => Array.from({ length: count }, (_, i) => `${prefix}${name}${i}`);

describe('trivial', () => {
  it('counts punctuation and lone short keywords as trivial', () => {
    for (const t of ['', '   ', '}', '});', 'return;', '} else {', '*/', '</div>']) assert.ok(trivial(t), t);
  });
  it('counts real code as not trivial', () => {
    for (const t of ['const x = 1;', 'return value;', 'initializeEverything();']) assert.ok(!trivial(t), t);
  });
});

describe('regroup', () => {
  it('merges a rewrite split up by shared braces and blank lines', () => {
    const h = hunk([
      ' keep',
      ...block('-', 'old', 4), ...block('+', 'new', 4),
      ' }',
      ' ',
      ...block('-', 'oldB', 4), ...block('+', 'newB', 5),
      ' tail',
    ]);
    assert.deepEqual(render(regroup([h])[0]!), [
      ' keep',
      ...block('-', 'old', 4), '-}', '-', ...block('-', 'oldB', 4),
      ...block('+', 'new', 4), '+}', '+', ...block('+', 'newB', 5),
      ' tail',
    ]);
  });

  it('keeps line numbers of absorbed lines on the side they now belong to', () => {
    const h = hunk([...block('-', 'a', 3), ...block('+', 'b', 3), ' }', ...block('-', 'c', 3), ...block('+', 'd', 3)]);
    const lines = regroup([h])[0]!.lines;
    const del = lines.find((l) => l.kind === 'del' && l.text === '}')!;
    const add = lines.find((l) => l.kind === 'add' && l.text === '}')!;
    assert.deepEqual([del.old_no, del.new_no], [4, null]);
    assert.deepEqual([add.old_no, add.new_no], [null, 4]);
  });

  it('cascades across several runs', () => {
    const h = hunk([
      ...block('-', 'a', 2), ...block('+', 'b', 2), ' }',
      ...block('-', 'c', 2), ...block('+', 'd', 2), ' }',
      ...block('-', 'e', 2), ...block('+', 'f', 2),
    ]);
    const out = render(regroup([h])[0]!);
    assert.ok(out.every((l) => l[0] !== ' '), 'no unchanged line left between the runs');
    assert.equal(out.findIndex((l) => l[0] === '+'), 8, 'every removed line comes first');
  });

  it('leaves small edits separated by code alone', () => {
    const h = hunk(['-a = 1', '+a = 2', ' b = 3', '-c = 4', '+c = 5']);
    assert.equal(regroup([h])[0], h);
  });

  it('leaves small edits separated by a brace alone', () => {
    const h = hunk(['-a = 1', '+a = 2', ' }', '-c = 4', '+c = 5']);
    assert.equal(regroup([h])[0], h);
  });

  it('keeps a long unchanged run between big changes', () => {
    const h = hunk([...block('-', 'a', 30), ...block('+', 'b', 30), ...block(' ', 'shared = value', 4), ...block('-', 'c', 30), ...block('+', 'd', 30)]);
    assert.equal(regroup([h])[0], h);
  });

  it('leaves a kept line between pure insertions alone', () => {
    const h = hunk([...block('+', 'a', 10), ' function run() {', ...block('+', 'b', 10)]);
    assert.equal(regroup([h])[0], h);
  });

  it('never touches context at the edges of a hunk', () => {
    const h = hunk([' }', ...block('-', 'a', 5), ...block('+', 'b', 5), ' }']);
    assert.equal(regroup([h])[0], h);
  });
});
