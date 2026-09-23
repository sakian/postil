export type FileStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'type_changed';

/** What the file is, which decides how the UI can render it. */
export type FileKind = 'text' | 'binary' | 'symlink' | 'submodule';

export interface FileChange {
  status: FileStatus;
  kind: FileKind;
  /** Display path: the new path, or the old path for a deletion. */
  path: string;
  old_path: string | null;
  new_path: string | null;
  /** Object ids. For a submodule these are commit ids, not blobs. */
  old_blob: string | null;
  new_blob: string | null;
  old_mode: string | null;
  new_mode: string | null;
  /** Rename similarity in percent. */
  similarity: number | null;
  /** Null for binary files and submodules. */
  additions: number | null;
  deletions: number | null;
}

export type LineKind = 'context' | 'add' | 'del';

export interface DiffLine {
  kind: LineKind;
  old_no: number | null;
  new_no: number | null;
  text: string;
  /** Set when git reported "\ No newline at end of file" for this line. */
  no_eol?: true;
}

export interface Hunk {
  old_start: number;
  old_lines: number;
  new_start: number;
  new_lines: number;
  /** The function-context text git prints after the second @@. */
  header: string;
  lines: DiffLine[];
}

export interface Commit {
  sha: string;
  parents: string[];
  subject: string;
  author_name: string;
  author_email: string;
  authored_at: string;
}
