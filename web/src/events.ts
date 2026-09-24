export interface ServerEvent {
  type: string;
  [key: string]: unknown;
}

/** Subscribe to the UI event feed, reconnecting with backoff. Returns a function that stops it. */
export function subscribe(
  token: string,
  onEvent: (e: ServerEvent) => void,
  onStatus: (connected: boolean) => void,
): () => void {
  let ws: WebSocket | null = null;
  let stopped = false;
  let delay = 500;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const connect = () => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/events?channel=ui&token=${encodeURIComponent(token)}`);
    ws.onopen = () => {
      delay = 500;
      onStatus(true);
    };
    ws.onmessage = (m) => {
      try {
        onEvent(JSON.parse(String(m.data)) as ServerEvent);
      } catch {
        /* ignore malformed frames */
      }
    };
    ws.onclose = () => {
      onStatus(false);
      if (stopped) return;
      timer = setTimeout(connect, delay);
      delay = Math.min(delay * 2, 10_000);
    };
  };
  connect();

  return () => {
    stopped = true;
    clearTimeout(timer);
    ws?.close();
  };
}
