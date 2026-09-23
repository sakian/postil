import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import type { Channel } from '../core/events.ts';
import { agentHint, type Postil } from '../core/postil.ts';
import { VERSION } from '../core/version.ts';
import { tokenMatches } from './app.ts';

export interface EventsOptions {
  token: string;
  allowedHosts: () => readonly string[];
  heartbeatMs?: number;
}

export interface EventsHandle {
  clientCount(channel?: Channel): number;
  close(): void;
}

function reject(socket: Duplex, status: number, reason: string): void {
  socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

/**
 * The event feed at /events. `?channel=agent` is Claude's doorbell and carries only events
 * that need Claude to act; `?channel=ui` (the default) carries everything.
 */
export function attachEvents(server: Server, postil: Postil, opts: EventsOptions): EventsHandle {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  const channelOf = new WeakMap<WebSocket, Channel>();
  const alive = new WeakMap<WebSocket, boolean>();

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const host = req.headers.host ?? '';
    if (!opts.allowedHosts().includes(host)) return reject(socket, 403, 'Forbidden');
    const url = new URL(req.url ?? '/', `http://${host}`);
    if (url.pathname !== '/events') return reject(socket, 404, 'Not Found');
    if (!tokenMatches(url.searchParams.get('token'), opts.token)) return reject(socket, 401, 'Unauthorized');
    // Browsers always send Origin; a page from another site must not open our feed.
    const origin = req.headers.origin;
    if (origin !== undefined && !opts.allowedHosts().some((h) => origin === `http://${h}`)) {
      return reject(socket, 403, 'Forbidden');
    }
    const channel = url.searchParams.get('channel') ?? 'ui';
    if (channel !== 'ui' && channel !== 'agent') return reject(socket, 400, 'Bad Request');
    // Claude's monitor names its session, which marks the session as listening while connected.
    const session = channel === 'agent' ? url.searchParams.get('session') : null;
    if (session !== null && !/^[\w-]{1,128}$/.test(session)) return reject(socket, 400, 'Bad Request');

    wss.handleUpgrade(req, socket, head, (ws) => {
      channelOf.set(ws, channel);
      alive.set(ws, true);
      if (session) {
        postil.agentConnected(session);
        ws.on('close', () => postil.agentDisconnected(session));
      }
      ws.on('pong', () => alive.set(ws, true));
      ws.on('message', () => { /* the feed is one-way */ });
      const pending = postil.pendingReviews().map((r) => r.id);
      ws.send(JSON.stringify({
        type: 'hello',
        channel,
        version: VERSION,
        pending_reviews: pending,
        ...(channel === 'agent' && pending.length > 0 && { hint: agentHint(pending) }),
      }));
    });
  });

  const unsubscribe = postil.bus.subscribe((event, channels) => {
    const frame = JSON.stringify(event);
    for (const ws of wss.clients) {
      const channel = channelOf.get(ws);
      if (channel && channels.includes(channel) && ws.readyState === WebSocket.OPEN) ws.send(frame);
    }
  });

  // Browser tabs can vanish without closing the socket (sleep, network change).
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!alive.get(ws)) {
        ws.terminate();
        continue;
      }
      alive.set(ws, false);
      ws.ping();
    }
  }, opts.heartbeatMs ?? 30_000);
  heartbeat.unref();

  return {
    clientCount(channel) {
      let n = 0;
      for (const ws of wss.clients) if (!channel || channelOf.get(ws) === channel) n++;
      return n;
    },
    close() {
      clearInterval(heartbeat);
      unsubscribe();
      for (const ws of wss.clients) ws.close(1001, 'server shutting down');
      wss.close();
    },
  };
}
