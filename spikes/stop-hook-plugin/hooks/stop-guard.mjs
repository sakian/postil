// Stop hook: refuse to let the turn end while a submitted review has unanswered threads.
import fs from 'node:fs';
const LOG = new URL('../hook.log', import.meta.url).pathname;  // lands in the plugin root
const log = (m) => fs.appendFileSync(LOG, `[${new Date().toISOString()}] ${m}\n`);

let input = '';
process.stdin.on('data', c => input += c);
process.stdin.on('end', async () => {
  let hook = {};
  try { hook = JSON.parse(input || '{}'); } catch {}
  log(`FIRED stop_hook_active=${hook.stop_hook_active} keys=${Object.keys(hook).join(',')}`);

  // Guard against an infinite block loop: Claude Code sets this when the last stop was already blocked.
  if (hook.stop_hook_active) { log('already active -> allow stop'); process.exit(0); }

  let status;
  try {
    const r = await fetch('http://127.0.0.1:7717/status');
    status = await r.json();
  } catch (e) { log(`server unreachable: ${e.message} -> allow stop`); process.exit(0); }

  const unanswered = [];
  for (const rev of status.reviews ?? [])
    for (const t of rev.threads ?? [])
      if (!t.replies?.length) unanswered.push(`${t.path}:${t.lines} — "${t.body.slice(0, 60)}"`);

  if (!unanswered.length) { log('no unanswered threads -> allow stop'); process.exit(0); }

  log(`BLOCKING: ${unanswered.length} unanswered thread(s)`);
  console.log(JSON.stringify({
    decision: 'block',
    reason: `postil: ${unanswered.length} review thread(s) still have no reply. Reply to each with the postil reply endpoint before finishing:\n` +
            unanswered.map(u => `  - ${u}`).join('\n')
  }));
  process.exit(0);
});
