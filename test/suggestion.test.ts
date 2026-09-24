import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { extractSuggestion, replaceLines } from '../src/core/suggestion.ts';

describe('suggestion parsing', () => {
  it('finds the block, including longer and tilde fences', () => {
    assert.equal(extractSuggestion('before\n```suggestion\nnew line\n```\nafter'), 'new line');
    assert.equal(extractSuggestion('````suggestion\ncode with ``` inside\n````'), 'code with ``` inside');
    assert.equal(extractSuggestion('~~~suggestion\nx\n~~~'), 'x');
    assert.equal(extractSuggestion('```suggestion\n```'), '');
    assert.equal(extractSuggestion('```ts\nnot a suggestion\n```'), null);
  });
  it('rejects several blocks', () => {
    assert.throws(() => extractSuggestion('```suggestion\na\n```\n```suggestion\nb\n```'), /more than one/);
  });
});

describe('replacing lines', () => {
  it('keeps a missing final newline missing', () => {
    assert.equal(replaceLines('a\nb\nc', 3, 3, 'C'), 'a\nb\nC');
  });
  it('can empty a file', () => {
    assert.equal(replaceLines('a\n', 1, 1, ''), '');
  });
});
