import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import type { FileDiff, Hunk } from '../../src/core/api-types.ts';
import { Postil } from '../../src/core/postil.ts';
import { add, normalize, partition, removeOverlapping } from '../../web/src/lib/ranges.ts';
import { buildRows, gaps, oldToNewInGaps, toSplit, type Row } from '../../web/src/lib/rows.ts';
import { isSelected, splitSelection, unifiedSelection } from '../../web/src/lib/selection.ts';
import { buildTree, dirPaths, fileOrder, flatten } from '../../web/src/lib/tree.ts';
import { makeFixture, numbered, type Fixture } from '../helpers.ts';

describe('ranges', () => {
  it('normalises by sorting and merging overlapping and adjacent ranges', () => {
    assert.deepEqual(normalize([[10, 12], [1, 3], [4, 5], [11, 20], [30, 29]]), [[1, 5], [10, 20]]);
  });
  it('adds and removes whole overlapping blocks', () => {
    const r = add(add([], [1, 5]), [20, 25]);
    assert.deepEqual(removeOverlapping(r, [3, 3]), [[20, 25]]);
  });
  it('partitions a span into covered and uncovered parts', () => {
    assert.deepEqual(partition([1, 10], [[3, 4], [8, 20]]), [
      { covered: false, range: [1, 2] },
      { covered: true, range: [3, 4] },
      { covered: false, range: [5, 7] },
      { covered: true, range: [8, 10] },
    ]);
  });
});

describe('diff rows from real git hunks', () => {
  let fx: Fixture;
  let postil: Postil;
  let diff: FileDiff;
  let newLines: string[];
  before(async () => {
    fx = makeFixture();
    fx.write('f.txt', numbered(40));
    fx.commit('base');
    postil = await Postil.open(fx.dir);
    fx.write('f.txt', numbered(40, { 5: 'five', 30: 'thirty' }));
    const s = await postil.resolveScope({ kind: 'all' });
    const file = (await postil.files(s.from.tree, s.to.tree))[0]!;
    diff = await postil.fileDiff(file.old_blob, file.new_blob);
    newLines = (await postil.lines(file.new_blob!, 1, 40)).lines;
  });
  after(() => { postil.close(); fx.cleanup(); });

  const kinds = (rows: Row[]) => rows.map((r) => (r.type === 'line' ? r.kind[0] : r.type[0])).join('');

  it('finds the context gaps before, between and after the hunks', () => {
    assert.deepEqual(gaps(diff).map((g) => [g.position, g.start, g.end, g.offset]), [
      ['top', 1, 1, 0], ['middle', 9, 26, 0], ['bottom', 34, 40, 0],
    ]);
  });

  it('collapses every gap by default, with the right expand directions', () => {
    const rows = buildRows(diff, { revealed: [], newLines });
    const expanders = rows.filter((r) => r.type === 'expander');
    assert.deepEqual(expanders.map((e) => [e.start, e.end, e.canDown, e.canUp, e.header !== null]), [
      [1, 1, false, true, true], // file top: nothing above to expand down from
      [9, 26, true, true, true],
      [34, 40, true, false, false], // file bottom: nothing below
    ]);
    assert.match(expanders[1]!.header!, /^@@ -27,7 \+27,7 @@/);
  });

  it('reveals part of a gap with a recollapse control, keeping the rest collapsed', () => {
    const rows = buildRows(diff, { revealed: [[9, 12]], newLines });
    const i = rows.findIndex((r) => r.type === 'collapse');
    assert.deepEqual(rows[i], { type: 'collapse', key: 'c9', start: 9, end: 12, count: 4 });
    const revealed = rows.slice(i + 1, i + 5);
    assert.deepEqual(revealed.map((r) => r.type === 'line' && [r.oldNo, r.newNo, r.text, r.expanded]), [
      [9, 9, 'line 9', true], [10, 10, 'line 10', true], [11, 11, 'line 11', true], [12, 12, 'line 12', true],
    ]);
    const after = rows[i + 5];
    assert.equal(after?.type, 'expander');
    if (after?.type === 'expander') assert.deepEqual([after.start, after.end], [13, 26]);
  });

  it('joins hunks when the gap between them is fully revealed', () => {
    const rows = buildRows(diff, { revealed: [[1, 40]], newLines });
    assert.equal(rows.filter((r) => r.type === 'expander').length, 0);
    assert.equal(rows.filter((r) => r.type === 'line').length, 42, '40 lines plus the two deletions');
  });

  it('keeps gaps collapsed until the file content has loaded', () => {
    assert.deepEqual(kinds(buildRows(diff, { revealed: [[9, 26]], newLines: null })), kinds(buildRows(diff, { revealed: [], newLines })));
  });

  it('reveals forced lines without offering to collapse them', () => {
    const rows = buildRows(diff, { revealed: [], forced: [[15, 15]], newLines });
    assert.equal(rows.filter((r) => r.type === 'collapse').length, 0);
    assert.ok(rows.some((r) => r.type === 'line' && r.newNo === 15 && r.expanded));
  });

  it('pairs deletions with additions in the split view, keeping every line', () => {
    const rows = buildRows(diff, { revealed: [], newLines });
    const split = toSplit(rows);
    const changed = split.filter((r) => r.type === 'pair' && (r.left?.kind === 'del' || r.right?.kind === 'add'));
    assert.deepEqual(changed.map((r) => r.type === 'pair' && [r.left?.no, r.left?.text, r.right?.no, r.right?.text]), [
      [5, 'line 5', 5, 'five'], [30, 'line 30', 30, 'thirty'],
    ]);
    const lefts = split.flatMap((r) => (r.type === 'pair' && r.left ? [r.left.no] : []));
    const unifiedOld = rows.flatMap((r) => (r.type === 'line' && r.oldNo !== null ? [r.oldNo] : []));
    assert.deepEqual(lefts, unifiedOld);
  });

  it('maps old-side lines in gaps to new-side coordinates', async () => {
    fx.write('g.txt', numbered(40));
    fx.commit('g');
    fx.write('g.txt', numbered(40).replace('line 3\n', '')); // shifts everything after line 3 by one
    const s = await postil.resolveScope({ kind: 'uncommitted' });
    const file = (await postil.files(s.from.tree, s.to.tree)).find((f) => f.path === 'g.txt')!;
    const d = await postil.fileDiff(file.old_blob, file.new_blob);
    const g = gaps(d);
    assert.equal(g.find((x) => x.position === 'bottom')?.offset, 1);
    assert.equal(oldToNewInGaps(g, 20), 19);
    assert.equal(oldToNewInGaps(g, 3), null, 'the deleted line is not in a gap');
  });
});

describe('diff rows from synthetic hunks', () => {
  const hunk = (old_start: number, old_lines: number, new_start: number, new_lines: number, lines: Hunk['lines']): Hunk =>
    ({ old_start, old_lines, new_start, new_lines, header: '', lines });

  it('shows a plain header between hunks that abut each other', () => {
    const h1 = hunk(1, 1, 1, 1, [{ kind: 'del', old_no: 1, new_no: null, text: 'a' }, { kind: 'add', old_no: null, new_no: 1, text: 'A' }]);
    const h2 = hunk(2, 1, 2, 1, [{ kind: 'del', old_no: 2, new_no: null, text: 'b' }, { kind: 'add', old_no: null, new_no: 2, text: 'B' }]);
    const rows = buildRows({ hunks: [h1, h2], new_lines: 2 }, { revealed: [], newLines: ['A', 'B'] });
    assert.deepEqual(rows.map((r) => r.type), ['hunk', 'line', 'line', 'hunk', 'line', 'line']);
  });

  it('handles a file emptied of all content', () => {
    const h = hunk(1, 2, 0, 0, [{ kind: 'del', old_no: 1, new_no: null, text: 'a' }, { kind: 'del', old_no: 2, new_no: null, text: 'b' }]);
    assert.deepEqual(gaps({ hunks: [h], new_lines: 0 }), []);
    assert.equal(buildRows({ hunks: [h], new_lines: 0 }, { revealed: [], newLines: [] }).filter((r) => r.type === 'line').length, 2);
  });

  it('has no rows for a file with no hunks, such as a pure rename', () => {
    assert.deepEqual(buildRows({ hunks: [], new_lines: 10 }, { revealed: [[1, 10]], newLines: [] }), []);
  });
});

describe('selection', () => {
  const line = (key: string, kind: 'context' | 'add' | 'del', oldNo: number | null, newNo: number | null): Row =>
    ({ type: 'line', key, kind, oldNo, newNo, text: '', noEol: false, expanded: false });
  const rows: Row[] = [
    line('a', 'context', 1, 1), line('b', 'del', 2, null), line('c', 'del', 3, null),
    line('d', 'add', null, 2), line('e', 'context', 4, 3),
  ];

  it('targets the old side only when every selected line is a deletion', () => {
    assert.deepEqual(unifiedSelection(rows, 1, 2), { side: 'old', start: 2, end: 3 });
    assert.deepEqual(unifiedSelection(rows, 2, 4), { side: 'new', start: 2, end: 3 });
    assert.deepEqual(unifiedSelection(rows, 4, 0), { side: 'new', start: 1, end: 3 }, 'backwards drags work');
  });

  it('uses the clicked column in the split view', () => {
    const split = toSplit(rows);
    assert.deepEqual(splitSelection(split, 0, split.length - 1, 'old'), { side: 'old', start: 1, end: 4 });
    assert.deepEqual(splitSelection(split, 1, 2, 'new'), { side: 'new', start: 2, end: 2 });
  });

  it('highlights only lines on the selected side', () => {
    const sel = { side: 'new' as const, start: 2, end: 3 };
    assert.equal(isSelected(sel, 'new', 2), true);
    assert.equal(isSelected(sel, 'old', 2), false);
    assert.equal(isSelected(sel, 'new', null), false);
  });
});

describe('file tree', () => {
  const files = ['src/core/a.ts', 'src/core/b.ts', 'src/web/x/y.tsx', 'README.md', 'docs/PLAN.md'].map((path) => ({ path }));

  it('merges single-child directory chains and sorts directories first', () => {
    const tree = buildTree(files);
    const flat = flatten(tree, new Set());
    assert.deepEqual(flat.map((f) => `${'  '.repeat(f.depth)}${f.node.name}`), [
      'docs', '  PLAN.md', 'src', '  core', '    a.ts', '    b.ts', '  web/x', '    y.tsx', 'README.md',
    ]);
  });

  it('hides collapsed directories and lists every directory for collapse-all', () => {
    const tree = buildTree(files);
    assert.deepEqual(flatten(tree, new Set(['src'])).map((f) => f.node.name), ['docs', 'PLAN.md', 'src', 'README.md']);
    assert.deepEqual(dirPaths(tree), ['docs', 'src', 'src/core', 'src/web/x']);
  });

  it('orders files as the tree shows them', () => {
    assert.deepEqual(fileOrder(buildTree(files)).map((f) => f.path), ['docs/PLAN.md', 'src/core/a.ts', 'src/core/b.ts', 'src/web/x/y.tsx', 'README.md']);
  });
});
