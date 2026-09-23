import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { countLines, parseLog, parseNumstatZ, parseRawZ, parseUnifiedDiff, splitLines } from '../src/git/parse.ts';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const Z = '0'.repeat(40);

describe('parseRawZ', () => {
  it('parses add, modify, delete and rename records', () => {
    const raw = [
      `:000000 100644 ${Z} ${A} A`, 'new.txt',
      `:100644 100644 ${A} ${B} M`, 'src/mod.ts',
      `:100644 000000 ${A} ${Z} D`, 'gone.txt',
      `:100644 100644 ${A} ${B} R087`, 'old/name.ts', 'new/name.ts',
      '',
    ].join('\0');
    const files = parseRawZ(raw);
    assert.equal(files.length, 4);
    assert.deepEqual(
      files.map((f) => [f.status, f.old_path, f.new_path, f.old_blob, f.new_blob]),
      [
        ['added', null, 'new.txt', null, A],
        ['modified', 'src/mod.ts', 'src/mod.ts', A, B],
        ['deleted', 'gone.txt', null, A, null],
        ['renamed', 'old/name.ts', 'new/name.ts', A, B],
      ],
    );
    assert.equal(files[3]?.similarity, 87);
    assert.equal(files[2]?.path, 'gone.txt');
    assert.equal(files[2]?.new_mode, null);
  });

  it('classifies symlinks and submodules by mode', () => {
    const raw = [`:000000 120000 ${Z} ${A} A`, 'link', `:160000 160000 ${A} ${B} M`, 'vendor/lib', ''].join('\0');
    assert.deepEqual(parseRawZ(raw).map((f) => f.kind), ['symlink', 'submodule']);
  });

  it('keeps paths containing spaces, tabs and newlines intact', () => {
    const odd = 'dir with space/tab\there\nnewline.txt';
    assert.equal(parseRawZ([`:000000 100644 ${Z} ${A} A`, odd, ''].join('\0'))[0]?.path, odd);
  });
});

describe('parseNumstatZ', () => {
  it('keys renames by new path and marks binary files with nulls', () => {
    const out = ['3\t1\tsrc/a.ts', '2\t0\t', 'old.ts', 'new.ts', '-\t-\timg.png', ''].join('\0');
    const m = parseNumstatZ(out);
    assert.deepEqual(m.get('src/a.ts'), { additions: 3, deletions: 1 });
    assert.deepEqual(m.get('new.ts'), { additions: 2, deletions: 0 });
    assert.equal(m.has('old.ts'), false);
    assert.deepEqual(m.get('img.png'), { additions: null, deletions: null });
  });
});

describe('parseUnifiedDiff', () => {
  it('assigns old and new line numbers across context, deletions and additions', () => {
    const text = [
      'diff --git a/x b/y', 'index 1..2 100644', '--- a/x', '+++ b/y',
      '@@ -2,4 +2,5 @@ function foo() {',
      ' keep', '-old', '+new', '+extra', ' keep2', ' keep3',
    ].join('\n') + '\n';
    const { hunks, binary } = parseUnifiedDiff(text);
    assert.equal(binary, false);
    assert.equal(hunks.length, 1);
    const h = hunks[0]!;
    assert.equal(h.header, 'function foo() {');
    assert.deepEqual(
      h.lines.map((l) => [l.kind, l.old_no, l.new_no, l.text]),
      [
        ['context', 2, 2, 'keep'],
        ['del', 3, null, 'old'],
        ['add', null, 3, 'new'],
        ['add', null, 4, 'extra'],
        ['context', 4, 5, 'keep2'],
        ['context', 5, 6, 'keep3'],
      ],
    );
  });

  it('treats omitted counts as 1 and handles a file created from nothing', () => {
    const { hunks } = parseUnifiedDiff('@@ -0,0 +1 @@\n+only\n');
    assert.deepEqual([hunks[0]?.old_lines, hunks[0]?.new_lines, hunks[0]?.lines[0]?.new_no], [0, 1, 1]);
  });

  it('attaches "no newline at end of file" to the right line', () => {
    const text = '@@ -1,2 +1,2 @@\n a\n-b\n\\ No newline at end of file\n+b\n\\ No newline at end of file\n';
    const lines = parseUnifiedDiff(text).hunks[0]!.lines;
    assert.equal(lines[1]?.kind, 'del');
    assert.equal(lines[1]?.no_eol, true);
    assert.equal(lines[2]?.kind, 'add');
    assert.equal(lines[2]?.no_eol, true);
    assert.equal(lines[0]?.no_eol, undefined);
  });

  it('is not fooled by content that looks like diff syntax', () => {
    const text = '@@ -1,2 +1,2 @@\n-@@ -9,9 +9,9 @@\n+--- a/fake\n  +++ context line\n';
    const lines = parseUnifiedDiff(text).hunks[0]!.lines;
    assert.deepEqual(lines.map((l) => [l.kind, l.text]), [
      ['del', '@@ -9,9 +9,9 @@'],
      ['add', '--- a/fake'],
      ['context', ' +++ context line'],
    ]);
  });

  it('reports binary files', () => {
    assert.equal(parseUnifiedDiff('Binary files a/x and b/x differ\n').binary, true);
  });

  it('parses several hunks', () => {
    const text = '@@ -1 +1 @@\n-a\n+A\n@@ -10 +10 @@\n-j\n+J\n';
    assert.deepEqual(parseUnifiedDiff(text).hunks.map((h) => h.old_start), [1, 10]);
  });

  it('rejects a truncated hunk rather than returning partial data', () => {
    assert.throws(() => parseUnifiedDiff('@@ -1,3 +1,3 @@\n a\n'), /ended inside a hunk/);
  });
});

describe('line helpers', () => {
  it('count and split agree, with and without a trailing newline', () => {
    for (const [text, expected] of [['', []], ['a', ['a']], ['a\n', ['a']], ['a\nb', ['a', 'b']], ['a\n\n', ['a', '']]] as const) {
      const buf = Buffer.from(text);
      assert.deepEqual(splitLines(buf), expected, JSON.stringify(text));
      assert.equal(countLines(buf), expected.length, JSON.stringify(text));
    }
  });
});

describe('parseLog', () => {
  it('parses records separated by control characters', () => {
    const text = `${A}\x1f${B} ${Z}\x1fAnn\x1fann@x.io\x1f2026-01-01T00:00:00Z\x1fMerge: a | b\x1e\n${B}\x1f\x1fBo\x1fbo@x.io\x1f2026-01-02T00:00:00Z\x1froot\x1e\n`;
    const log = parseLog(text);
    assert.equal(log.length, 2);
    assert.deepEqual(log[0]?.parents, [B, Z]);
    assert.equal(log[0]?.subject, 'Merge: a | b');
    assert.deepEqual(log[1]?.parents, []);
  });
});

describe('parseUnifiedDiff tolerance', () => {
  it('reads a bare empty line mid-hunk as a blank context line', () => {
    const lines = parseUnifiedDiff('@@ -1,3 +1,3 @@\n a\n\n-c\n+C\n').hunks[0]!.lines;
    assert.deepEqual(lines.map((l) => [l.kind, l.old_no, l.text]), [
      ['context', 1, 'a'], ['context', 2, ''], ['del', 3, 'c'], ['add', null, 'C'],
    ]);
  });
});
