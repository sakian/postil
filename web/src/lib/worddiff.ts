/** Character offsets [start, end) within a line. */
export type Span = readonly [number, number];

/**
 * Size of the comparison table past which the middle of a line pair (what's left once the
 * shared start and end are trimmed) is treated as changed as a whole, rather than compared token
 * by token.
 */
const MAX_CELLS = 250_000;
/** Below this share of unchanged text the lines are rewrites, not edits, and get no highlights. */
const MIN_SIMILARITY = 0.5;
/**
 * A line that mostly survives inside a longer one (text added to a sentence, like "This is an
 * example." growing a second clause) is an edit however much was added, as long as the changes
 * are in a few places rather than scattered.
 */
const MIN_CONTAINED = 0.8;
const MAX_CONTAINED_SPANS = 3;
/** How far ahead in a run of added lines to look for the one a removed line became. */
const PAIR_WINDOW = 8;

function tokenize(s: string): string[] {
  return s.match(/\w+|\s+|[^\w\s]/g) ?? [];
}

type Op = 'same' | 'del' | 'add';

/** The token edit script of two token lists, trimming their shared start and end first. */
function tokenOps(x: readonly string[], y: readonly string[]): Op[] {
  let pre = 0;
  while (pre < x.length && pre < y.length && x[pre] === y[pre]) pre++;
  let suf = 0;
  while (suf < x.length - pre && suf < y.length - pre && x[x.length - 1 - suf] === y[y.length - 1 - suf]) suf++;
  const xm = x.slice(pre, x.length - suf);
  const ym = y.slice(pre, y.length - suf);
  const ops: Op[] = Array<Op>(pre).fill('same');

  if (xm.length * ym.length > MAX_CELLS) {
    ops.push(...Array<Op>(xm.length).fill('del'), ...Array<Op>(ym.length).fill('add'));
  } else {
    // lcs[i][j] = length of the LCS of xm[i..] and ym[j..], counted in tokens.
    const lcs = Array.from({ length: xm.length + 1 }, () => new Uint32Array(ym.length + 1));
    for (let i = xm.length - 1; i >= 0; i--) {
      for (let j = ym.length - 1; j >= 0; j--) {
        lcs[i]![j] = xm[i] === ym[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
      }
    }
    let i = 0;
    let j = 0;
    while (i < xm.length || j < ym.length) {
      if (i < xm.length && j < ym.length && xm[i] === ym[j]) {
        ops.push('same');
        i++;
        j++;
      } else if (j >= ym.length || (i < xm.length && lcs[i + 1]![j]! >= lcs[i]![j + 1]!)) {
        ops.push('del');
        i++;
      } else {
        ops.push('add');
        j++;
      }
    }
  }
  ops.push(...Array<Op>(suf).fill('same'));
  return ops;
}

export interface WordDiff {
  old: Span[];
  new: Span[];
  /** Share of the shorter line left unchanged, used to pick the best pairing. */
  score: number;
}

/**
 * The words that differ between a removed line and the added line paired with it, for
 * highlighting. Null when the lines have too little in common for highlights to help.
 */
export function wordDiff(a: string, b: string): WordDiff | null {
  if (a === b) return null;
  const x = tokenize(a);
  const y = tokenize(b);
  const ops = tokenOps(x, y);

  const oldSpans: Span[] = [];
  const newSpans: Span[] = [];
  const mark = (spans: Span[], start: number, end: number) => {
    const last = spans.at(-1);
    if (last && last[1] === start) spans[spans.length - 1] = [last[0], end];
    else spans.push([start, end]);
  };
  let i = 0;
  let j = 0;
  let pa = 0;
  let pb = 0;
  let common = 0;
  for (const op of ops) {
    if (op === 'same') {
      common += x[i]!.length;
      pa += x[i++]!.length;
      pb += y[j++]!.length;
    } else if (op === 'del') {
      mark(oldSpans, pa, pa + x[i]!.length);
      pa += x[i++]!.length;
    } else {
      mark(newSpans, pb, pb + y[j]!.length);
      pb += y[j++]!.length;
    }
  }

  const shorter = Math.min(a.length, b.length);
  const similar = (2 * common) / (a.length + b.length) >= MIN_SIMILARITY;
  const contained = shorter > 0 && common / shorter >= MIN_CONTAINED && oldSpans.length + newSpans.length <= MAX_CONTAINED_SPANS;
  if (!similar && !contained) return null;
  return { old: oldSpans, new: newSpans, score: shorter > 0 ? common / shorter : 0 };
}

interface PairLine {
  kind: 'context' | 'add' | 'del';
  oldNo: number | null;
  newNo: number | null;
  text: string;
  hunk: number | null;
}

export interface WordPair {
  oldNo: number;
  newNo: number;
  diff: WordDiff;
}

/**
 * Pair each removed line with the added line it became, within each run of removed lines and
 * the run of added lines right after it. Pairs keep their order, and a removed line takes the
 * best match among the next few added lines, so a line added or dropped in the middle of a
 * block doesn't shift every pair after it.
 */
export function wordPairs(rows: readonly ({ type: string } & Partial<PairLine>)[]): WordPair[] {
  const out: WordPair[] = [];
  let dels: PairLine[] = [];
  let adds: PairLine[] = [];
  const flush = () => {
    let next = 0;
    for (const d of dels) {
      let best: { at: number; diff: WordDiff } | null = null;
      for (let k = next; k < Math.min(adds.length, next + PAIR_WINDOW); k++) {
        const w = wordDiff(d.text, adds[k]!.text);
        if (w && (!best || w.score > best.diff.score)) best = { at: k, diff: w };
      }
      if (!best) continue;
      out.push({ oldNo: d.oldNo!, newNo: adds[best.at]!.newNo!, diff: best.diff });
      next = best.at + 1;
    }
    dels = [];
    adds = [];
  };
  for (const r of rows) {
    const line = r.type === 'line' ? (r as PairLine) : null;
    if (line?.kind === 'del') {
      if (adds.length) flush();
      dels.push(line);
    } else if (line?.kind === 'add' && dels.length && line.hunk === dels[0]!.hunk) {
      adds.push(line);
    } else {
      flush();
    }
  }
  flush();
  return out;
}

/** Word highlights from line pairs, keyed `old:<line>` and `new:<line>`. */
export function wordHighlights(pairs: readonly WordPair[]): Map<string, Span[]> {
  const out = new Map<string, Span[]>();
  for (const p of pairs) {
    if (p.diff.old.length) out.set(`old:${p.oldNo}`, p.diff.old);
    if (p.diff.new.length) out.set(`new:${p.newNo}`, p.diff.new);
  }
  return out;
}
