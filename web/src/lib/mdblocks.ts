import type { Element, ElementContent, Root, RootContent } from 'hast';
import type { Hunk } from '../../../src/core/api-types.ts';

/**
 * A commentable unit of a rendered Markdown file: a top-level block, or one item of a top-level
 * list. `start`..`end` are the source lines it was rendered from. `from`..`until` is the span of
 * source lines it stands for, which also takes in the blank lines and link definitions after it,
 * so that every line of the file belongs to exactly one block; `until` is null for the last block.
 * `prevEnd` is the last source line of the block before it, or 0.
 */
export interface Block {
  start: number;
  end: number;
  from: number;
  until: number | null;
  prevEnd: number;
}

export const BLOCK_CLASS = 'md-block';

const LISTS = new Set(['ul', 'ol']);

function wrapper(children: ElementContent[], start: number, end: number): Element {
  return { type: 'element', tagName: 'div', properties: { className: [BLOCK_CLASS], dataStart: start, dataEnd: end }, children };
}

/**
 * A rehype plugin that wraps each block of the document in a `div.md-block` carrying its source
 * lines (see `blockOf`). Items of a top-level list are wrapped one by one, inside their `<li>`, so
 * the list keeps its markup. A document with no blocks, such as one holding only link definitions,
 * gets one empty block so its comments still have a place.
 */
export function rehypeBlocks() {
  return (tree: Root) => {
    const blocks: Element[] = [];
    const wrap = (children: ElementContent[], start: number, end: number) => {
      const w = wrapper(children, start, end);
      blocks.push(w);
      return w;
    };
    tree.children = tree.children.flatMap((child): RootContent[] => {
      if (!child.position) return [child];
      // Raw HTML, which react-markdown later shows as text, is a block of its own.
      if (child.type === 'raw') return [wrap([child as unknown as ElementContent], child.position.start.line, child.position.end.line)];
      if (child.type !== 'element') return [child];
      if (LISTS.has(child.tagName)) {
        for (const li of child.children) {
          if (li.type === 'element' && li.tagName === 'li' && li.position) li.children = [wrap(li.children, li.position.start.line, li.position.end.line)];
        }
        return [child];
      }
      return [wrap([child], child.position.start.line, child.position.end.line)];
    });
    if (blocks.length === 0) tree.children.push(wrap([], 1, 1));
    blocks.forEach((b, i) => {
      const next = blocks[i + 1];
      const prev = blocks[i - 1];
      b.properties.dataFrom = i === 0 ? 1 : Number(b.properties.dataStart);
      b.properties.dataUntil = next ? Number(next.properties.dataStart) - 1 : null;
      b.properties.dataPrevEnd = prev ? Number(prev.properties.dataEnd) : 0;
    });
  };
}

/** The block a wrapper element stands for, or null when the element is not one of `rehypeBlocks`'s. */
export function blockOf(el: Pick<Element, 'properties'> | undefined): Block | null {
  const p = el?.properties;
  const cls = p?.className;
  if (!p || !(Array.isArray(cls) && cls.includes(BLOCK_CLASS)) || typeof p.dataStart !== 'number') return null;
  return {
    start: p.dataStart,
    end: Number(p.dataEnd),
    from: Number(p.dataFrom),
    until: p.dataUntil == null ? null : Number(p.dataUntil),
    prevEnd: Number(p.dataPrevEnd),
  };
}

/** Whether `line` belongs to the block, for placing comments. */
export function blockHolds(b: Block, line: number): boolean {
  return line >= b.from && (b.until === null || line <= b.until);
}

/**
 * What a diff changed on the new side: the lines it added, and where it removed lines. Removed
 * lines that were replaced by added ones count only as those added lines.
 */
export interface NewSideChanges {
  added: ReadonlySet<number>;
  /** Removed lines by the new-side line they stood just before (one past the end for the file's tail). */
  removed: ReadonlyMap<number, number>;
}

export function newSideChanges(hunks: readonly Hunk[]): NewSideChanges {
  const added = new Set<number>();
  const removed = new Map<number, number>();
  for (const h of hunks) {
    let next = h.new_lines === 0 ? h.new_start + 1 : h.new_start; // git numbers a hunk with no new lines from the line before it
    let run = 0;
    for (const l of h.lines) {
      if (l.kind === 'del') {
        run++;
        continue;
      }
      if (run > 0 && l.kind !== 'add') removed.set(next, (removed.get(next) ?? 0) + run);
      run = 0;
      if (l.kind === 'add') added.add(l.new_no ?? next);
      next = (l.new_no ?? next) + 1;
    }
    if (run > 0) removed.set(next, (removed.get(next) ?? 0) + run);
  }
  return { added, removed };
}

/**
 * How the diff touched a block. It is `changed` when any of its lines were added, or lines were
 * removed from inside it. Lines removed between it and the block before it count as `removedBefore`;
 * `removedAfter` is for the last block, which also takes the lines removed after it.
 */
export function blockChanges(b: Block, c: NewSideChanges): { changed: boolean; removedBefore: number; removedAfter: number } {
  let changed = false;
  for (let n = b.start; n <= b.end && !changed; n++) changed = c.added.has(n);
  let removedBefore = 0;
  let removedAfter = 0;
  for (const [at, count] of c.removed) {
    if (at > b.start && at <= b.end) changed = true;
    else if (at > b.prevEnd && at <= b.start) removedBefore += count;
    else if (b.until === null && at > b.end) removedAfter += count;
  }
  return { changed, removedBefore, removedAfter };
}

/** Whether a selected range of lines touches the block. */
export function blockSelected(b: Block, sel: { start: number; end: number } | null): boolean {
  return sel !== null && sel.start <= b.end && sel.end >= b.start;
}

/** Markdown files, which can be reviewed rendered. */
export function isMarkdown(path: string): boolean {
  return /\.(md|markdown|mdown|mkd)$/i.test(path);
}
