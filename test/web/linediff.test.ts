import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { lineDiff } from '../../web/src/lib/linediff.ts';

const render = (ops: ReturnType<typeof lineDiff>) => ops.map((o) => `${o.kind === 'add' ? '+' : o.kind === 'del' ? '-' : ' '}${o.text}`);

describe('lineDiff', () => {
  it('keeps common lines and marks the rest', () => {
    assert.deepEqual(render(lineDiff(['a', 'b', 'c'], ['a', 'B', 'c', 'd'])), [' a', '-b', '+B', ' c', '+d']);
  });
  it('handles empty sides', () => {
    assert.deepEqual(render(lineDiff([], ['x'])), ['+x']);
    assert.deepEqual(render(lineDiff(['x'], [])), ['-x']);
  });
  it('falls back to remove-then-add past the size limit', () => {
    assert.deepEqual(render(lineDiff(['a', 'b'], ['a', 'c'], 1)), ['-a', '-b', '+a', '+c']);
  });
});
