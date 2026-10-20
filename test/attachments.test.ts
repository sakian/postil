import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import { attachmentBlob, attachmentMarkdown, attachmentRefs, cleanName, cleanType, MAX_ATTACHMENT_BYTES } from '../src/core/attachments.ts';
import { Postil } from '../src/core/postil.ts';
import { startServer, type RunningServer } from '../src/server/server.ts';
import { insertBlock } from '../web/src/lib/text.ts';
import { makeFixture, numbered, type Fixture } from './helpers.ts';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
const OID = 'a'.repeat(40);

describe('attachment references', () => {
  it('finds each attachment a body names, once', () => {
    const b = 'b'.repeat(40);
    assert.deepEqual(attachmentRefs(`![x](attachment:${OID}) and [y](attachment:${b}) and again attachment:${OID}`), [OID, b]);
    assert.deepEqual(attachmentRefs('attachment:abc and attachment:' + 'g'.repeat(40)), []);
    assert.equal(attachmentBlob(`attachment:${OID}`), OID);
    assert.equal(attachmentBlob(`attachment:${OID}/../x`), null);
    assert.equal(attachmentBlob('https://example.com/a.png'), null);
  });

  it('embeds images as images and anything else as a link, escaping the label', () => {
    assert.equal(attachmentMarkdown({ blob: OID, name: 'shot [1].png', type: 'image/png' }), `![shot \\[1\\].png](attachment:${OID})`);
    assert.equal(attachmentMarkdown({ blob: OID, name: 'log.txt', type: 'text/plain' }), `[log.txt](attachment:${OID})`);
  });

  it('cleans names and types from the browser', () => {
    assert.equal(cleanName('C:\\Users\\me\\shot.png'), 'shot.png');
    assert.equal(cleanName('../../etc/passwd'), 'passwd');
    assert.equal(cleanName('..'), 'attachment');
    assert.equal(cleanName('a<b>:"c|?*\u0007.txt'), 'abc.txt');
    assert.equal(cleanName(''), 'attachment');
    assert.equal(cleanType('Image/PNG; charset=x'), 'image/png');
    assert.equal(cleanType(''), 'application/octet-stream');
    assert.equal(cleanType('not a type'), 'application/octet-stream');
  });

  it('inserts on lines of its own at the cursor, or at the end', () => {
    assert.equal(insertBlock('', null, 'X'), 'X\n');
    assert.equal(insertBlock('look', null, 'X'), 'look\nX\n');
    assert.equal(insertBlock('look here', [4, 4], 'X'), 'look\nX\n here');
    assert.equal(insertBlock('a\nb', [2, 2], 'X'), 'a\nX\nb');
    assert.equal(insertBlock('replace me', [0, 10], 'X'), 'X\n');
    assert.equal(insertBlock('short', [50, 60], 'X'), 'short\nX\n', 'a stale selection falls back to the end');
  });
});

describe('attachments in the service', () => {
  let fx: Fixture;
  let postil: Postil;
  before(async () => {
    fx = makeFixture();
    fx.write('f.txt', numbered(10));
    fx.commit('base');
    fx.write('f.txt', numbered(10, { 5: 'changed' }));
    postil = await Postil.open(fx.dir);
  });
  after(() => {
    postil.close();
    fx.cleanup();
  });

  it('stores the file as a pinned blob, and keeps the first name for the same content', async () => {
    const a = await postil.addAttachment(PNG, 'dir/shot.png', 'image/png');
    assert.equal(a.name, 'shot.png');
    assert.equal(a.markdown, `![shot.png](attachment:${a.blob})`);
    assert.ok((await postil.repo.pinnedBlobs()).includes(a.blob));
    const again = await postil.addAttachment(PNG, 'other.png', 'image/png');
    assert.equal(again.name, 'shot.png');
    const { row, content } = await postil.attachment(a.blob);
    assert.equal(row.type, 'image/png');
    assert.deepEqual(content, PNG);
  });

  it('refuses empty and oversized files, and unknown ids', async () => {
    await assert.rejects(postil.addAttachment(Buffer.alloc(0), 'x', undefined), /empty/);
    await assert.rejects(postil.addAttachment(Buffer.alloc(MAX_ATTACHMENT_BYTES + 1), 'x', undefined), /limited/);
    await assert.rejects(postil.attachment(OID), /no attachment/);
  });

  it('pruning keeps attachments a live comment names, and recent ones, and releases the rest', async () => {
    const used = await postil.addAttachment(Buffer.from('used'), 'used.txt', 'text/plain');
    const unused = await postil.addAttachment(Buffer.from('unused'), 'unused.txt', 'text/plain');
    const s = await postil.resolveScope({ kind: 'all' });
    await postil.createThread({ from_tree: s.from.tree, to_tree: s.to.tree, path: 'f.txt', side: 'new', start_line: 5, body: `see ${used.markdown}` });

    await postil.prune();
    assert.ok((await postil.repo.pinnedBlobs()).includes(unused.blob), 'an upload whose comment is unsaved is kept for a while');

    postil.store.db.prepare("UPDATE attachment SET created_at = '2000-01-01T00:00:00.000Z'").run();
    await postil.prune();
    const pinned = await postil.repo.pinnedBlobs();
    assert.ok(pinned.includes(used.blob));
    assert.equal(pinned.includes(unused.blob), false);
  });
});

describe('attachments over HTTP', () => {
  let fx: Fixture;
  let server: RunningServer;
  const auth = () => ({ authorization: `Bearer ${server.info.token}` });
  before(async () => {
    fx = makeFixture();
    fx.write('a', '1\n');
    fx.commit('base');
    server = await startServer({ cwd: fx.dir, port: 0, pollMs: 50 });
  });
  after(async () => {
    await server.close();
    fx.cleanup();
  });

  const upload = (body: Uint8Array, name: string, type: string) =>
    fetch(`${server.info.url}/api/attachments?name=${encodeURIComponent(name)}`, { method: 'POST', headers: { ...auth(), 'content-type': type }, body });

  it('uploads a raw body and serves images inline, sandboxed, with the token in the query', async () => {
    const res = await upload(PNG, 'shot.png', 'image/png');
    assert.equal(res.status, 201);
    const a = (await res.json()) as { blob: string; markdown: string };
    const served = await fetch(`${server.info.url}/api/attachments/${a.blob}?token=${server.info.token}`);
    assert.equal(served.status, 200);
    assert.equal(served.headers.get('content-type'), 'image/png');
    assert.match(served.headers.get('content-security-policy') ?? '', /sandbox/);
    assert.deepEqual(Buffer.from(await served.arrayBuffer()), PNG);
    assert.equal((await fetch(`${server.info.url}/api/attachments/${a.blob}`)).status, 401);
  });

  it('serves other files as downloads under their name', async () => {
    const a = (await (await upload(Buffer.from('<script>alert(1)</script>'), 'page é.html', 'text/html')).json()) as { blob: string };
    const served = await fetch(`${server.info.url}/api/attachments/${a.blob}`, { headers: auth() });
    assert.equal(served.headers.get('content-type'), 'application/octet-stream');
    assert.equal(served.headers.get('content-disposition'), `attachment; filename*=UTF-8''page%20%C3%A9.html`);
  });

  it('accepts files over the JSON limit, up to the attachment limit', async () => {
    assert.equal((await upload(new Uint8Array(2 * 1024 * 1024).fill(1), 'big.bin', 'application/octet-stream')).status, 201);
    assert.equal((await upload(new Uint8Array(MAX_ATTACHMENT_BYTES + 1), 'huge.bin', 'application/octet-stream')).status, 413);
    const json = await fetch(`${server.info.url}/api/reviews/draft`, {
      method: 'PUT', headers: { ...auth(), 'content-type': 'application/json' }, body: JSON.stringify({ body: 'x'.repeat(2 * 1024 * 1024) }),
    });
    assert.equal(json.status, 413, 'other routes keep the 1 MiB limit');
  });
});
