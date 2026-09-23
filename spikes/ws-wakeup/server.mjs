// Phase 0 spike: minimal postil-shaped server.
// Proves: browser "Submit review" -> ws frame -> Claude Code Monitor tool wakes the session.
import http from 'node:http';
import { WebSocketServer } from 'ws';
import fs from 'node:fs';

const PORT = 7717;
const TOKEN = 'spike-token-abc123';
const LOG = new URL('./events.log', import.meta.url).pathname;
const log = (m) => { const l = `[${new Date().toISOString()}] ${m}`; console.log(l); fs.appendFileSync(LOG, l + '\n'); };

// in-memory "reviews", shaped like the real thing
const reviews = new Map();
let nextId = 1;
const clients = new Set();

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const send = (code, obj) => { res.writeHead(code, {'content-type':'application/json'}); res.end(JSON.stringify(obj, null, 2)); };

  if (url.pathname === '/submit' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      const payload = body ? JSON.parse(body) : {};
      const id = nextId++;
      const review = { id, status: 'pending', threads: payload.threads ?? [
        { thread_id: `t${id}a`, path: 'src/auth.ts', lines: '42-45', body: 'This retry loop has no backoff.', replies: [] },
      ]};
      reviews.set(id, review);
      const frame = JSON.stringify({ type: 'review.submitted', review_id: id, thread_count: review.threads.length });
      log(`SUBMIT review ${id}; broadcasting to ${clients.size} ws client(s)`);
      for (const ws of clients) ws.send(frame);
      send(200, { ok: true, review_id: id, ws_clients: clients.size });
    });
    return;
  }
  if (url.pathname.startsWith('/review/')) {
    const r = reviews.get(Number(url.pathname.split('/')[2]));
    log(`GET ${url.pathname} -> ${r ? 'found' : '404'}`);
    return r ? send(200, r) : send(404, { error: 'no such review' });
  }
  if (url.pathname === '/reply' && req.method === 'POST') {
    let body = ''; req.on('data', c => body += c);
    req.on('end', () => {
      const p = JSON.parse(body);
      let found = false;
      for (const rev of reviews.values())
        for (const t of rev.threads)
          if (t.thread_id === p.thread_id) { t.replies.push({ from: 'claude', body: p.body }); found = true; }
      log(`REPLY to ${p.thread_id}: ${found ? 'recorded' : 'NO SUCH THREAD'} — ${p.body?.slice(0,50)}`);
      send(found ? 200 : 404, { ok: found });
    });
    return;
  }
  if (url.pathname === '/status') return send(200, { ws_clients: clients.size, reviews: [...reviews.values()] });
  send(404, { error: 'not found' });
});

const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  if (url.pathname !== '/events' || url.searchParams.get('token') !== TOKEN) {
    log(`REJECTED upgrade ${url.pathname} (bad path or token)`);
    socket.destroy(); return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    clients.add(ws);
    log(`WS CONNECTED (total ${clients.size})`);
    ws.send(JSON.stringify({ type: 'hello', msg: 'postil spike connected' }));
    ws.on('close', () => { clients.delete(ws); log(`WS CLOSED (total ${clients.size})`); });
  });
});

server.listen(PORT, '127.0.0.1', () => log(`listening on http://127.0.0.1:${PORT}`));
