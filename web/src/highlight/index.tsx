import type { CSSProperties, ReactNode } from 'react';
import type { HighlightRequest, HighlightResponse, Token } from './protocol.ts';

export type { Token } from './protocol.ts';

/** Files longer than this stay plain: tokenizing them costs more than the colour is worth. */
export const MAX_HIGHLIGHT_LINES = 5000;

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, (lines: Token[][] | null) => void>();

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<HighlightResponse>) => {
      pending.get(e.data.id)?.(e.data.lines);
      pending.delete(e.data.id);
    };
  }
  return worker;
}

export function highlight(text: string, language: string): Promise<Token[][] | null> {
  if (typeof Worker === 'undefined') return Promise.resolve(null);
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    getWorker().postMessage({ id, text, language } satisfies HighlightRequest);
  });
}

/** Render one line's tokens, or the plain text when they do not match it exactly. */
export function renderTokens(text: string, tokens: Token[] | undefined): ReactNode {
  if (!tokens || tokens.map((t) => t[0]).join('') !== text) return text;
  return tokens.map((t, i) => (
    <span key={i} className="tk" style={{ '--sl': t[1], '--sd': t[2] } as CSSProperties}>{t[0]}</span>
  ));
}

/**
 * Render a line with some character ranges emphasised (the words a paired line changed), keeping
 * its syntax colours: tokens are split at the range edges.
 */
export function renderEmphasis(text: string, tokens: Token[] | undefined, spans: readonly (readonly [number, number])[]): ReactNode {
  const runs: Token[] = tokens && tokens.map((t) => t[0]).join('') === text ? tokens : [[text, '', '']];
  const out: ReactNode[] = [];
  let pos = 0;
  let s = 0;
  for (const [content, light, dark] of runs) {
    let i = 0;
    while (i < content.length) {
      const at = pos + i;
      while (s < spans.length && spans[s]![1] <= at) s++;
      const span = spans[s];
      const inside = span !== undefined && span[0] <= at;
      const stop = Math.min(content.length, (inside ? span[1] : span ? span[0] : Infinity) - pos);
      out.push(
        <span key={out.length} className={`${light ? 'tk' : ''}${inside ? ' wd' : ''}`}
          style={light ? ({ '--sl': light, '--sd': dark } as CSSProperties) : undefined}>
          {content.slice(i, stop)}
        </span>,
      );
      i = stop;
    }
    pos += content.length;
  }
  return out;
}
