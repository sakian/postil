import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { FileDiff } from '../../src/core/api-types.ts';
import { Postil } from '../../src/core/postil.ts';
import { blockChanges, blockHolds, blockSelected, isMarkdown, newSideChanges, rehypeBlocks, type Block } from '../../web/src/lib/mdblocks.ts';
import { makeFixture, type Fixture } from '../helpers.ts';

/** The blocks react-markdown renders for `source`, read back from their wrappers' attributes. */
function blocks(source: string): Block[] {
  const html = renderToStaticMarkup(createElement(ReactMarkdown, { remarkPlugins: [remarkGfm], rehypePlugins: [rehypeBlocks] }, source));
  const tags = html.match(/<div class="md-block"[^>]*>/g) ?? [];
  return tags.map((t) => {
    const n = (k: string) => /data-[\w-]+="(\d*)"/.exec(t.slice(t.indexOf(`data-${k}=`)))?.[1];
    const until = n('until');
    return { start: Number(n('start')), end: Number(n('end')), from: Number(n('from')), until: until ? Number(until) : null, prevEnd: Number(n('prev-end')) };
  });
}

describe('rendered markdown blocks', () => {
  const doc = [
    '# Title', //            1
    '', //                   2
    'A paragraph', //        3
    'over two lines.', //    4
    '', //                   5
    '- one', //              6
    '- two', //              7
    '  - nested', //         8
    '', //                   9
    '```js', //              10
    'code()', //             11
    '```', //                12
    '', //                   13
    '[ref]: https://example.com', // 14
  ].join('\n');

  it('maps each block, and each top-level list item, to its source lines', () => {
    assert.deepEqual(blocks(doc).map((b) => [b.start, b.end]), [[1, 1], [3, 4], [6, 6], [7, 8], [10, 12]]);
  });

  it('gives every line of the file to exactly one block', () => {
    const bs = blocks(doc);
    for (let line = 1; line <= 14; line++) assert.equal(bs.filter((b) => blockHolds(b, line)).length, 1, `line ${line}`);
    assert.ok(blockHolds(bs[1]!, 5), 'a blank line belongs to the block above it');
    assert.ok(blockHolds(bs.at(-1)!, 14), 'trailing link definitions belong to the last block');
    assert.equal(bs[2]!.prevEnd, 4);
  });

  it('gives a document without blocks one, so its comments still have a place', () => {
    assert.deepEqual(blocks('[ref]: https://example.com\n'), [{ start: 1, end: 1, from: 1, until: null, prevEnd: 0 }]);
  });

  it('makes raw HTML a block of its own', () => {
    assert.deepEqual(blocks('para\n\n<div>\nhi\n</div>\n').map((b) => [b.start, b.end]), [[1, 1], [3, 5]]);
  });

  it('selects every block a line range touches', () => {
    const [, para, one] = blocks(doc);
    assert.ok(blockSelected(para!, { start: 4, end: 6 }));
    assert.ok(blockSelected(one!, { start: 4, end: 6 }));
    assert.ok(!blockSelected(one!, { start: 3, end: 5 }));
    assert.ok(!blockSelected(one!, null));
  });

  it('recognises Markdown files', () => {
    assert.ok(isMarkdown('docs/README.md'));
    assert.ok(isMarkdown('notes.Markdown'));
    assert.ok(!isMarkdown('src/md.ts'));
  });
});

describe('what a diff changed in rendered blocks', () => {
  let fx: Fixture;
  let postil: Postil;
  const before_ = ['# Title', '', 'Intro.', '', 'Gone paragraph.', '', 'Kept.', '', 'Edited here.', '', 'Tail.'].join('\n') + '\n';
  const after_ = ['# Title', '', 'Intro.', '', 'Kept.', '', 'Edited there.', '', 'New one.'].join('\n') + '\n';
  let diff: FileDiff;
  before(async () => {
    fx = makeFixture();
    fx.write('doc.md', before_);
    fx.commit('base');
    postil = await Postil.open(fx.dir);
    fx.write('doc.md', after_);
    const s = await postil.resolveScope({ kind: 'all' });
    const file = (await postil.files(s.from.tree, s.to.tree))[0]!;
    diff = await postil.fileDiff(file.old_blob, file.new_blob);
  });
  after(() => { postil.close(); fx.cleanup(); });

  it('marks changed blocks and counts lines removed between them', () => {
    const c = newSideChanges(diff.hunks);
    const result = blocks(after_).map((b) => [b.start, blockChanges(b, c)]);
    assert.deepEqual(result, [
      [1, { changed: false, removedBefore: 0, removedAfter: 0 }],
      [3, { changed: false, removedBefore: 0, removedAfter: 0 }],
      [5, { changed: false, removedBefore: 2, removedAfter: 0 }], // "Gone paragraph." and its blank line
      [7, { changed: true, removedBefore: 0, removedAfter: 0 }],
      [9, { changed: true, removedBefore: 0, removedAfter: 0 }],
    ]);
  });

  it('counts lines removed from the end of the file on the last block', () => {
    const c = newSideChanges([{ old_start: 1, old_lines: 3, new_start: 1, new_lines: 1, header: '', lines: [
      { kind: 'context', old_no: 1, new_no: 1, text: 'a' },
      { kind: 'del', old_no: 2, new_no: null, text: '' },
      { kind: 'del', old_no: 3, new_no: null, text: 'b' },
    ] }]);
    assert.deepEqual(blockChanges(blocks('a\n')[0]!, c), { changed: false, removedBefore: 0, removedAfter: 2 });
  });
});
