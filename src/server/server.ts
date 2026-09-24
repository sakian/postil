import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { getRequestListener } from '@hono/node-server';
import {
  acquireLock, lastPort, loadOrCreateToken, rememberPort, removeServerInfo, writeServerInfo, type ServerInfo,
} from '../core/discovery.ts';
import { DEFAULT_WEB_ROOT } from '../core/build-info.ts';
import { EventBus } from '../core/events.ts';
import { Postil } from '../core/postil.ts';
import { nowIso } from '../core/util.ts';
import { VERSION } from '../core/version.ts';
import { createApp } from './app.ts';
import { attachEvents, type EventsHandle } from './ws.ts';

export interface ServeOptions {
  cwd: string;
  /** Explicit port. Without it the last port is reused when free, else any free port. */
  port?: number;
  /** How often to look for working-tree changes while a browser is connected. */
  pollMs?: number;
  heartbeatMs?: number;
  /** Built UI directory. Defaults to web/dist in this checkout. */
  webRoot?: string;
}

export { DEFAULT_WEB_ROOT } from '../core/build-info.ts';

export interface RunningServer {
  info: ServerInfo;
  postil: Postil;
  events: EventsHandle;
  uiUrl: string;
  agentEventsUrl: string;
  close(): Promise<void>;
}

function allowedHostsFor(port: number): string[] {
  return [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`];
}

function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (e: Error) => { server.off('listening', onListening); reject(e); };
    const onListening = () => { server.off('error', onError); resolve((server.address() as AddressInfo).port); };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '127.0.0.1');
  });
}

export async function startServer(opts: ServeOptions): Promise<RunningServer> {
  const postil = await Postil.open(opts.cwd, new EventBus());
  const stateDir = postil.repo.stateDir;
  let release: (() => Promise<void>) | undefined;
  try {
    release = await acquireLock(stateDir);
    const token = await loadOrCreateToken(stateDir);

    let port = 0;
    const app = createApp(postil, { token, webRoot: opts.webRoot ?? DEFAULT_WEB_ROOT, allowedHosts: () => allowedHostsFor(port) });
    const server = createServer(getRequestListener(app.fetch));

    const preferred = opts.port ?? (await lastPort(stateDir));
    try {
      port = await listen(server, preferred ?? 0);
    } catch (e) {
      if (opts.port !== undefined || (e as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw e;
      port = await listen(server, 0);
    }

    const events = attachEvents(server, postil, {
      token,
      allowedHosts: () => allowedHostsFor(port),
      ...(opts.heartbeatMs !== undefined && { heartbeatMs: opts.heartbeatMs }),
    });

    // Establish the baseline so the first real change is announced.
    await postil.liveTree();
    let polling = false;
    const poller = setInterval(async () => {
      if (polling || events.clientCount('ui') === 0) return;
      polling = true;
      try {
        await postil.liveTree();
      } catch (e) {
        console.error('postil: working tree check failed:', (e as Error).message);
      } finally {
        polling = false;
      }
    }, opts.pollMs ?? 1500);
    poller.unref();

    const url = `http://127.0.0.1:${port}`;
    const info: ServerInfo = {
      pid: process.pid, port, url, token, root: postil.repo.root, version: VERSION, started_at: nowIso(),
    };
    await writeServerInfo(stateDir, info);
    await rememberPort(stateDir, port);

    const lockRelease = release;
    let closed = false;
    return {
      info,
      postil,
      events,
      uiUrl: `${url}/#token=${token}`,
      agentEventsUrl: `ws://127.0.0.1:${port}/events?channel=agent&token=${token}`,
      async close() {
        if (closed) return;
        closed = true;
        clearInterval(poller);
        events.close();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await removeServerInfo(stateDir);
        await lockRelease();
        postil.close();
      },
    };
  } catch (e) {
    await release?.();
    postil.close();
    throw e;
  }
}
