import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { BUNDLED, CLI_ENTRY, DEFAULT_WEB_ROOT, VERSION } from '../core/build-info.ts';
import { NotRunningError, PostilClient } from '../core/client.ts';
import { Repo } from '../git/repo.ts';

type Check = { ok: boolean | null; label: string; detail: string };

function version(text: string): number[] {
  return (/(\d+)\.(\d+)(?:\.(\d+))?/.exec(text) ?? []).slice(1).map((n) => Number(n ?? 0));
}

function atLeast(have: number[], want: number[]): boolean {
  for (let i = 0; i < want.length; i++) {
    if ((have[i] ?? 0) !== want[i]) return (have[i] ?? 0) > want[i]!;
  }
  return true;
}

/** Check everything postil depends on, and say what to do about anything missing. */
export async function doctor(cwd: string): Promise<number> {
  const checks: Check[] = [];
  const node = version(process.version);
  checks.push({ ok: atLeast(node, [24, 0]), label: 'Node.js', detail: `${process.version}${atLeast(node, [24, 0]) ? '' : ' (postil needs 24 or newer)'}` });

  const gitOut = spawnSync('git', ['--version'], { encoding: 'utf8' });
  const gitV = version(gitOut.stdout ?? '');
  checks.push(
    gitOut.error
      ? { ok: false, label: 'git', detail: 'not found' }
      : { ok: atLeast(gitV, [2, 43]), label: 'git', detail: `${gitOut.stdout.trim()}${atLeast(gitV, [2, 43]) ? '' : ' (postil needs 2.43 or newer)'}` },
  );

  checks.push({
    ok: existsSync(join(DEFAULT_WEB_ROOT, 'index.html')), label: 'Browser UI',
    detail: existsSync(join(DEFAULT_WEB_ROOT, 'index.html')) ? DEFAULT_WEB_ROOT : `not built at ${DEFAULT_WEB_ROOT}; run npm run build`,
  });
  checks.push({ ok: null, label: 'postil', detail: `${VERSION}, ${BUNDLED ? 'plugin bundle' : 'source checkout'} (${CLI_ENTRY})` });

  const claudeOut = spawnSync('claude', ['--version'], { encoding: 'utf8' });
  checks.push(claudeOut.error ? { ok: false, label: 'Claude Code', detail: 'not found on PATH' } : { ok: true, label: 'Claude Code', detail: claudeOut.stdout.trim() });
  if (!claudeOut.error) {
    const plugins = spawnSync('claude', ['plugin', 'list'], { encoding: 'utf8' }).stdout ?? '';
    const installed = /postil@postil/.test(plugins);
    checks.push({ ok: installed, label: 'Claude Code plugin', detail: installed ? 'postil@postil installed' : 'not installed; run npm run install-plugin in the postil checkout' });
  }

  try {
    const repo = await Repo.open(cwd);
    checks.push({ ok: true, label: 'Repository', detail: repo.root });
    try {
      const client = await PostilClient.connect(cwd);
      const health = await client.request<{ listening: number }>('GET', '/api/health');
      checks.push({ ok: true, label: 'Review server', detail: `running at ${client.info.url} (pid ${client.info.pid})` });
      checks.push({ ok: null, label: 'Claude listening', detail: health.listening ? `${health.listening} session(s)` : 'none; run /postil:review in Claude Code' });
    } catch (e) {
      if (!(e instanceof NotRunningError)) throw e;
      checks.push({ ok: null, label: 'Review server', detail: 'not running (it starts on /postil:review, or postil start)' });
    }
  } catch {
    checks.push({ ok: null, label: 'Repository', detail: `${cwd} is not inside a git working tree` });
  }

  const width = Math.max(...checks.map((c) => c.label.length));
  for (const c of checks) console.log(`${c.ok === true ? '✓' : c.ok === false ? '✗' : '·'} ${c.label.padEnd(width)}  ${c.detail}`);
  return checks.some((c) => c.ok === false) ? 1 : 0;
}
