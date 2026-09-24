import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, unlinkSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export interface Fixture {
  dir: string;
  git(...args: string[]): string;
  write(path: string, content: string | Buffer): void;
  remove(path: string): void;
  symlink(target: string, path: string): void;
  commit(message: string): string;
  cleanup(): void;
}

/** A throwaway repository with deterministic identity and dates. */
export function makeFixture(opts: { initialBranch?: string } = {}): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'postil-test-'));
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com',
    GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  };
  const run = (...args: string[]) => execFileSync('git', args, { cwd: dir, env, encoding: 'utf8' });
  run('init', '-q', `--initial-branch=${opts.initialBranch ?? 'main'}`);

  const fixture: Fixture = {
    dir,
    git: run,
    write(path, content) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), content);
    },
    remove(path) {
      unlinkSync(join(dir, path));
    },
    symlink(target, path) {
      try {
        symlinkSync(target, join(dir, path));
      } catch (e) {
        // Windows without developer mode: store it the way Git for Windows does with
        // core.symlinks=false, as a file holding the target that the index records as a link.
        if ((e as NodeJS.ErrnoException).code !== 'EPERM') throw e;
        writeFileSync(join(dir, path), target);
        const oid = run('hash-object', '-w', '--', path).trim();
        run('update-index', '--add', '--cacheinfo', `120000,${oid},${path}`);
      }
    },
    commit(message) {
      run('add', '-A');
      run('commit', '-q', '--allow-empty', '-m', message);
      return run('rev-parse', 'HEAD').trim();
    },
    cleanup() {
      // Windows can briefly hold a file a just-exited git process had open; retry rather than fail.
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    },
  };
  return fixture;
}

/** Lines 1..n as "line N", each newline-terminated. */
export function numbered(n: number, edits: Record<number, string> = {}): string {
  return Array.from({ length: n }, (_, i) => edits[i + 1] ?? `line ${i + 1}`).join('\n') + '\n';
}
