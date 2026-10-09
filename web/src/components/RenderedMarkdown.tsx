import { Children, createContext, isValidElement, useContext, useEffect, useMemo, useRef, useState, type MouseEvent, type ReactElement, type ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { FileChange, FileDiff, ThreadView } from '../../../src/core/api-types.ts';
import { currentLines, sidePath } from '../format.ts';
import { api } from '../api.ts';
import { blockChanges, blockHolds, blockOf, blockSelected, newSideChanges, rehypeBlocks, repoPath, type Block, type NewSideChanges } from '../lib/mdblocks.ts';
import { useStore, type Target } from '../store.ts';
import { Icon } from './icons.tsx';
import { Code } from './Markdown.tsx';
import { NewThreadComposer, ThreadWidget } from './Thread.tsx';

interface Props {
  file: FileChange;
  diff: FileDiff;
  /** Threads anchored to lines of this diff. */
  threads: ThreadView[];
}

const REHYPE = [rehypeBlocks];
const REMARK = [remarkGfm];
const EXTERNAL = /^(https?:|mailto:)/i;

/** Lines removed just above or below a block, marked on its edge so a list keeps its shape. */
function Removed({ count, where }: { count: number; where: 'before' | 'after' }) {
  return (
    <span className={`md-removed ${where}`} title={`${count} line${count === 1 ? '' : 's'} removed ${where === 'before' ? 'above' : 'below'} this. Switch to the source to see them.`}>
      −{count} line{count === 1 ? '' : 's'}
    </span>
  );
}

/**
 * A Markdown file rendered as a document, for reviewing prose. Each block (a paragraph, a heading,
 * a list item, a table, a code block) maps back to the source lines it came from, so comments made
 * here are ordinary comments on those lines: they show in the diff too, and Claude sees the source.
 * Blocks with added or changed lines are marked in the margin.
 */
export function RenderedMarkdown({ file, diff, threads }: Props) {
  const blob = file.new_blob;
  const linesState = useStore((s) => (blob ? s.lines[blob] : undefined));
  const selection = useStore((s) => (s.selection?.path === file.path && s.selection.side === 'new' ? s.selection : null));
  const composer = useStore((s) => (s.composer?.path === file.path && s.composer.side === 'new' ? s.composer : null));
  const tree = useStore((s) => s.resolved?.to.tree ?? null);
  const { loadLines, select, openComposer } = useStore.getState();

  useEffect(() => {
    if (blob && diff.new_lines !== null && !linesState) void loadLines(blob, diff.new_lines);
  }, [blob, diff.new_lines, linesState, loadLines]);
  const lines = linesState?.state === 'ready' ? linesState.value : null;
  const source = useMemo(() => lines?.join('\n') ?? null, [lines]);
  const changes = useMemo(() => newSideChanges(diff.hunks), [diff]);

  // Comments on removed lines have no place in the new text; they are listed above it.
  const { onNew, onOld } = useMemo(() => {
    const onNew: ThreadView[] = [];
    const onOld: ThreadView[] = [];
    for (const t of threads) (t.side === 'new' && currentLines(t).end !== null ? onNew : onOld).push(t);
    return { onNew, onOld };
  }, [threads]);

  // -------------------------------------------------------------- selecting blocks
  const drag = useRef<Block | null>(null);
  const lastAnchor = useRef<Block | null>(null);
  const toTarget = (a: Block, b: Block): Target => ({
    path: file.path, sidePath: sidePath(file, 'new'), side: 'new', start: Math.min(a.start, b.start), end: Math.max(a.end, b.end),
  });
  const onDown = (e: MouseEvent, b: Block) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const anchor = e.shiftKey && lastAnchor.current ? lastAnchor.current : b;
    drag.current = anchor;
    lastAnchor.current = anchor;
    select(toTarget(anchor, b));
  };
  const onEnter = (b: Block) => {
    if (drag.current) select(toTarget(drag.current, b));
  };
  useEffect(() => {
    const up = () => {
      if (!drag.current) return;
      drag.current = null;
      const sel = useStore.getState().selection;
      if (sel?.path === file.path) openComposer(sel);
    };
    window.addEventListener('mouseup', up);
    return () => window.removeEventListener('mouseup', up);
  }, [file.path, openComposer]);

  /** The source of the selected lines, to seed a suggestion. */
  const seed = (t: Target): string | null => (lines && t.end <= lines.length ? lines.slice(t.start - 1, t.end).join('\n') : null);

  /** Images in the repository load from the snapshot under review; the page's policy blocks the rest. */
  const image = (src: string): string | null => {
    const path = tree && repoPath(src, file.path);
    return path ? api.treeRawUrl(tree, path) : null;
  };

  const ctx: BlockContext = { changes, onNew, selection, composer, onDown, onEnter, seed, image };
  // Rendered once per content: selecting and commenting only re-render the blocks, through the context.
  const doc = useMemo(
    () => source === null ? null : <ReactMarkdown remarkPlugins={REMARK} rehypePlugins={REHYPE} components={COMPONENTS}>{source}</ReactMarkdown>,
    [source],
  );

  if (!blob || diff.new_lines === 0) return <div className="file-note muted">Empty file.</div>;
  if (linesState?.state === 'error') return <div className="file-note error">Could not load this file: {linesState.message}</div>;
  if (source === null) return <div className="file-note muted">Loading…</div>;
  return (
    <div className="md-rendered">
      {onOld.length > 0 && (
        <div className="file-threads outdated">
          <div className="file-threads-title">Comments on removed lines</div>
          {onOld.map((t) => <ThreadWidget key={t.id} thread={t} />)}
        </div>
      )}
      <div className="markdown md-doc">
        <Ctx.Provider value={ctx}>{doc}</Ctx.Provider>
      </div>
    </div>
  );
}

interface BlockContext {
  changes: NewSideChanges;
  onNew: ThreadView[];
  selection: Target | null;
  composer: Target | null;
  onDown(e: MouseEvent, b: Block): void;
  onEnter(b: Block): void;
  seed(t: Target): string | null;
  /** Where an image's source loads from, or null to show it as a placeholder. */
  image(src: string): string | null;
}

const Ctx = createContext<BlockContext | null>(null);

function BlockView({ block, children }: { block: Block; children: ReactNode }) {
  const ctx = useContext(Ctx)!;
  const { changed, removedBefore, removedAfter } = blockChanges(block, ctx.changes);
  const here = ctx.onNew.filter((t) => blockHolds(block, currentLines(t).end!));
  const composing = ctx.composer !== null && blockHolds(block, ctx.composer.end);
  const selected = blockSelected(block, ctx.selection);
  const label = block.start === block.end ? `line ${block.start}` : `lines ${block.start}–${block.end}`;
  return (
    <>
      <div className={`md-block${changed ? ' changed' : ''}${selected ? ' selected' : ''}${removedBefore ? ' removed-before' : ''}${removedAfter ? ' removed-after' : ''}`} data-start={block.start} data-end={block.end}
        onMouseEnter={() => ctx.onEnter(block)}>
        <button className="md-add-comment" title={`Comment on ${label} (drag or shift-click to select several blocks)`}
          onMouseDown={(e) => ctx.onDown(e, block)}>
          <Icon name="plus" size={12} />
        </button>
        {removedBefore > 0 && <Removed count={removedBefore} where="before" />}
        {removedAfter > 0 && <Removed count={removedAfter} where="after" />}
        {children}
      </div>
      {(here.length > 0 || composing) && (
        <div className="md-attach">
          {here.map((t) => <ThreadWidget key={t.id} thread={t} />)}
          {composing && <NewThreadComposer target={ctx.composer!} seed={ctx.seed(ctx.composer!)} />}
        </div>
      )}
    </>
  );
}

const COMPONENTS: Components = {
  div({ node, children, ...rest }) {
    const block = blockOf(node);
    return block ? <BlockView block={block}>{children}</BlockView> : <div {...rest}>{children}</div>;
  },
  pre({ children }) {
    const child = Children.toArray(children)[0] as ReactNode;
    if (!isValidElement(child)) return <pre className="md-pre">{children}</pre>;
    const props = (child as ReactElement<{ className?: string; children?: ReactNode }>).props;
    const lang = /language-([\w-]+)/.exec(props.className ?? '')?.[1];
    return <Code source={String(props.children ?? '').replace(/\n$/, '')} lang={lang} />;
  },
  // Links into the repository would open this page's server, not the file: show them as text.
  a({ href, children }) {
    return href && EXTERNAL.test(href)
      ? <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>
      : <span className="md-link" title={href}>{children}</span>;
  },
  img({ src, alt }) {
    return <Image src={typeof src === 'string' ? src : ''} alt={alt ?? ''} />;
  },
};

/** An image from the repository, or a placeholder for one that is elsewhere or will not load. */
function Image({ src, alt }: { src: string; alt: string }) {
  const url = useContext(Ctx)!.image(src);
  const [failed, setFailed] = useState<string | null>(null);
  if (url && failed !== url) return <img src={url} alt={alt} onError={() => setFailed(url)} />;
  return <span className="md-image" title={src || undefined}><Icon name="image" size={12} /> {alt || 'image'}</span>;
}
