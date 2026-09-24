export interface DirNode<F> {
  type: 'dir';
  /** Display name; single-child directory chains are merged, e.g. "src/core". */
  name: string;
  path: string;
  children: TreeNode<F>[];
}

export interface FileNode<F> {
  type: 'file';
  name: string;
  path: string;
  file: F;
}

export type TreeNode<F> = DirNode<F> | FileNode<F>;

export function buildTree<F extends { path: string }>(files: readonly F[]): TreeNode<F>[] {
  const root: DirNode<F> = { type: 'dir', name: '', path: '', children: [] };
  for (const file of files) {
    const parts = file.path.split('/');
    let dir = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const path = parts.slice(0, i + 1).join('/');
      let next = dir.children.find((c): c is DirNode<F> => c.type === 'dir' && c.path === path);
      if (!next) {
        next = { type: 'dir', name: parts[i]!, path, children: [] };
        dir.children.push(next);
      }
      dir = next;
    }
    dir.children.push({ type: 'file', name: parts.at(-1)!, path: file.path, file });
  }
  return sortAndCompress(root.children);
}

function sortAndCompress<F>(nodes: TreeNode<F>[]): TreeNode<F>[] {
  return nodes
    .map((n): TreeNode<F> => {
      if (n.type === 'file') return n;
      let dir = n;
      while (dir.children.length === 1 && dir.children[0]!.type === 'dir') {
        const only = dir.children[0] as DirNode<F>;
        dir = { ...only, name: `${dir.name}/${only.name}` };
      }
      return { ...dir, children: sortAndCompress(dir.children) };
    })
    .sort((a, b) => (a.type !== b.type ? (a.type === 'dir' ? -1 : 1) : a.name.localeCompare(b.name)));
}

export interface FlatNode<F> {
  node: TreeNode<F>;
  depth: number;
}

/** Visible nodes in display order, skipping the contents of collapsed directories. */
export function flatten<F>(nodes: readonly TreeNode<F>[], collapsed: ReadonlySet<string>, depth = 0): FlatNode<F>[] {
  const out: FlatNode<F>[] = [];
  for (const node of nodes) {
    out.push({ node, depth });
    if (node.type === 'dir' && !collapsed.has(node.path)) out.push(...flatten(node.children, collapsed, depth + 1));
  }
  return out;
}

export function dirPaths<F>(nodes: readonly TreeNode<F>[]): string[] {
  return nodes.flatMap((n) => (n.type === 'dir' ? [n.path, ...dirPaths(n.children)] : []));
}

/** Files in tree display order, so the diff pane matches the sidebar. */
export function fileOrder<F>(nodes: readonly TreeNode<F>[]): F[] {
  return nodes.flatMap((n) => (n.type === 'file' ? [n.file] : fileOrder(n.children)));
}
