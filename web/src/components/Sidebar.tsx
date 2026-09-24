import { useMemo } from 'react';
import { markKey, viewedBlob } from '../format.ts';
import { buildTree, dirPaths, flatten } from '../lib/tree.ts';
import { useStore } from '../store.ts';
import { StatusBadge } from './DiffPane.tsx';
import { Icon } from './icons.tsx';

export function Sidebar() {
  const resolved = useStore((s) => s.resolved);
  const collapsedDirs = useStore((s) => s.collapsedDirs);
  const viewed = useStore((s) => s.viewed);
  const threads = useStore((s) => s.threads);
  const { toggleDir, setCollapsedDirs, revealFile } = useStore.getState();

  const tree = useMemo(() => buildTree(resolved?.files ?? []), [resolved]);
  const allDirs = useMemo(() => dirPaths(tree), [tree]);
  const collapsed = useMemo(() => new Set(collapsedDirs), [collapsedDirs]);
  const rows = useMemo(() => flatten(tree, collapsed), [tree, collapsed]);
  const updated = useStore((s) => (s.scope.kind === 'since_review' ? null : s.resolved?.since_review ?? null));
  const updatedPaths = useMemo(() => new Set(updated?.changed ?? []), [updated]);
  const openByPath = useMemo(() => {
    const m = new Map<string, number>();
    for (const t of threads) if (t.status === 'open') m.set(t.path, (m.get(t.path) ?? 0) + 1);
    return m;
  }, [threads]);

  const files = resolved?.files ?? [];
  const viewedCount = files.filter((f) => {
    const b = viewedBlob(f);
    return b !== null && viewed.has(markKey(f.path, b));
  }).length;
  const anyCollapsed = allDirs.some((d) => collapsed.has(d));

  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <span className="sidebar-title">Files</span>
        <span className="muted progress" title="Files marked as viewed">{viewedCount}/{files.length} viewed</span>
        <span className="spacer" />
        <button className="icon-btn" title="Expand all folders" disabled={!anyCollapsed} onClick={() => setCollapsedDirs([])}>
          <Icon name="unfold" />
        </button>
        <button className="icon-btn" title="Collapse all folders" disabled={allDirs.length === 0} onClick={() => setCollapsedDirs(allDirs)}>
          <Icon name="fold" />
        </button>
      </div>
      <div className="progress-bar"><div style={{ width: files.length ? `${(100 * viewedCount) / files.length}%` : 0 }} /></div>
      <nav className="tree" aria-label="Changed files">
        {rows.map(({ node, depth }) => {
          const pad = { paddingLeft: `${8 + depth * 14}px` };
          if (node.type === 'dir') {
            const isCollapsed = collapsed.has(node.path);
            return (
              <button key={`d:${node.path}`} className="tree-row tree-dir" style={pad} onClick={() => toggleDir(node.path)} aria-expanded={!isCollapsed}>
                <Icon name={isCollapsed ? 'chevronRight' : 'chevronDown'} size={14} />
                <Icon name="folder" size={14} />
                <span className="tree-name">{node.name}</span>
              </button>
            );
          }
          const f = node.file;
          const b = viewedBlob(f);
          const isViewed = b !== null && viewed.has(markKey(f.path, b));
          const open = openByPath.get(f.path) ?? 0;
          return (
            <button key={`f:${node.path}`} className={`tree-row tree-file${isViewed ? ' is-viewed' : ''}`} style={pad}
              onClick={() => revealFile(f.path)} title={f.path}>
              <StatusBadge file={f} />
              <span className="tree-name">{node.name}</span>
              {updatedPaths.has(f.path) && <span className="tree-updated" title={`Changed since you submitted review #${updated?.review_id}`} />}
              {open > 0 && <span className="tree-badge" title={`${open} open conversation(s)`}>{open}</span>}
              {isViewed && <Icon name="check" size={14} title="Viewed" />}
            </button>
          );
        })}
      </nav>
    </aside>
  );
}
