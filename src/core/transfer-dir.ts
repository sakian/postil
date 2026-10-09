import { createHash } from 'node:crypto';
import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

/**
 * The transfer folder: a folder synced between computers, named by POSTIL_TRANSFER_DIR, where
 * exports go by default and imports look for them. Each export is a bundle with a small JSON
 * file beside it, so the folder can be listed without opening any bundle.
 */

export function transferDir(): string | null {
  const dir = process.env.POSTIL_TRANSFER_DIR?.trim();
  return dir ? resolve(dir) : null;
}

/** Exports of one repository share a tag in their names, so an import finds its own among others'. */
export function repoTag(identity: string | null): string {
  return createHash('sha256').update(identity ?? 'no identity').digest('hex').slice(0, 10);
}

const EXPORT_NAME = /-([0-9a-f]{10})-(\d{8}-\d{6})\.bundle$/;

export function exportName(root: string, identity: string | null, at = new Date()): string {
  const stamp = at.toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-');
  const name = root.split(/[\\/]/).filter(Boolean).pop() ?? 'repo';
  return `postil-${name.replace(/[^\w.-]/g, '_')}-${repoTag(identity)}-${stamp}.bundle`;
}

/** Where a session stood when it was exported, to tell exports apart in a list. */
export interface ExportSummary {
  open_threads: number;
  /** Reviews the user submitted that Claude has not completed. */
  waiting_reviews: number;
  /** Comments saved but not yet submitted. */
  drafts: number;
  last_review: { id: number; status: string } | null;
}

/** The JSON file beside a bundle in the transfer folder. */
export interface ExportInfo {
  exported_at: string;
  host: string;
  branch: string | null;
  head: string | null;
  claude_session: string | null;
  summary: ExportSummary | null;
}

export interface ExportEntry {
  file: string;
  info: ExportInfo | null;
}

const infoPath = (bundle: string) => bundle.replace(/\.bundle$/, '.json');

export async function writeExportInfo(bundle: string, info: ExportInfo): Promise<void> {
  await writeFile(infoPath(bundle), `${JSON.stringify(info, null, 2)}\n`);
}

/** This repository's exports in the transfer folder, newest first. */
export async function listExports(identity: string | null): Promise<ExportEntry[]> {
  const dir = transferDir();
  if (!dir) return [];
  const tag = repoTag(identity);
  const names = (await readdir(dir).catch(() => [] as string[]))
    .map((name) => ({ name, m: EXPORT_NAME.exec(name) }))
    .filter((e) => e.m?.[1] === tag)
    .sort((x, y) => (x.m![2]! < y.m![2]! ? 1 : -1));
  return Promise.all(names.map(async ({ name }) => {
    const file = join(dir, name);
    const info = await readFile(infoPath(file), 'utf8').then((t) => JSON.parse(t) as ExportInfo, () => null);
    return { file, info };
  }));
}

export async function removeExport(bundle: string): Promise<void> {
  await rm(bundle, { force: true });
  await rm(infoPath(bundle), { force: true });
}

/**
 * Remove this repository's exports of a branch: once a newer export replaces them, or once the
 * session on that branch is finished, so a stale one is never imported by mistake. Exports from
 * before the JSON files existed say nothing of their branch and are left alone.
 */
export async function pruneExports(identity: string | null, branch: string | null, keep?: string): Promise<number> {
  let removed = 0;
  for (const e of await listExports(identity)) {
    if (e.file === keep || !e.info || e.info.branch !== branch) continue;
    await removeExport(e.file);
    removed++;
  }
  return removed;
}
