/** Character offsets [start, end) within a line. */
export type Span = readonly [number, number];

/** Tokens past which a line pair is not compared: the table grows with the product of the two. */
const MAX_TOKENS = 400;
/** Below this share of unchanged text the lines are rewrites, not edits, and get no highlights. */
const MIN_SIMILARITY = 0.5;

function tokenize(s: string): string[] {
  return s.match(/\w+|\s+|[^\w\s]/g) ?? [];
}

/**
 * The words that differ between a removed line and the added line paired with it, for
 * highlighting. Null when the lines have too little in common for highlights to help.
 */
export function wordDiff(a: string, b: string): { old: Span[]; new: Span[] } | null {
  if (a === b) return null;
  const x = tokenize(a);
  const y = tokenize(b);
  if (x.length > MAX_TOKENS || y.length > MAX_TOKENS) return null;

  // lcs[i][j] = length of the LCS of x[i..] and y[j..], counted in tokens.
  const lcs = Array.from({ length: x.length + 1 }, () => new Uint16Array(y.length + 1));
  for (let i = x.length - 1; i >= 0; i--) {
    for (let j = y.length - 1; j >= 0; j--) {
      lcs[i]![j] = x[i] === y[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }

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
  while (i < x.length || j < y.length) {
    if (i < x.length && j < y.length && x[i] === y[j]) {
      common += x[i]!.length;
      pa += x[i++]!.length;
      pb += y[j++]!.length;
    } else if (j >= y.length || (i < x.length && lcs[i + 1]![j]! >= lcs[i]![j + 1]!)) {
      mark(oldSpans, pa, pa + x[i]!.length);
      pa += x[i++]!.length;
    } else {
      mark(newSpans, pb, pb + y[j]!.length);
      pb += y[j++]!.length;
    }
  }
  if ((2 * common) / (a.length + b.length) < MIN_SIMILARITY) return null;
  return { old: oldSpans, new: newSpans };
}

interface PairLine {
  kind: 'context' | 'add' | 'del';
  oldNo: number | null;
  newNo: number | null;
  text: string;
  hunk: number | null;
}

/**
 * Word highlights for a file's rows, keyed `old:<line>` and `new:<line>`. Each run of removed
 * lines is paired, in order, with the run of added lines right after it.
 */
export function wordHighlights(rows: readonly ({ type: string } & Partial<PairLine>)[]): Map<string, Span[]> {
  const out = new Map<string, Span[]>();
  let dels: PairLine[] = [];
  let adds: PairLine[] = [];
  const flush = () => {
    for (let k = 0; k < Math.min(dels.length, adds.length); k++) {
      const d = dels[k]!;
      const a = adds[k]!;
      const w = wordDiff(d.text, a.text);
      if (!w) continue;
      if (w.old.length) out.set(`old:${d.oldNo}`, w.old);
      if (w.new.length) out.set(`new:${a.newNo}`, w.new);
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
