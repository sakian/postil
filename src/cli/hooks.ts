import type { HookStatus } from '../core/api-types.ts';
import { PostilClient } from '../core/client.ts';
import { agentHint } from '../core/hints.ts';

interface HookInput {
  session_id?: string;
  cwd?: string;
  source?: string;
  stop_hook_active?: boolean;
}

async function readInput(timeoutMs = 2000): Promise<HookInput> {
  if (process.stdin.isTTY) return {};
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    process.stdin.on('data', (c: Buffer) => chunks.push(c));
    process.stdin.on('end', () => { clearTimeout(timer); resolve(); });
    process.stdin.on('error', () => { clearTimeout(timer); resolve(); });
  });
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as HookInput;
  } catch {
    return {};
  }
}

function lines(t: { path: string; start_line: number | null; end_line: number | null }): string {
  if (t.start_line === null) return t.path;
  return t.start_line === t.end_line ? `${t.path}:${t.start_line}` : `${t.path}:${t.start_line}-${t.end_line}`;
}

/** What this session still owes, as a self-contained instruction, or null when nothing is owed. */
export function owed(status: HookStatus): string | null {
  const parts: string[] = [];
  for (const r of status.in_progress) {
    parts.push(
      r.unanswered.length
        ? `Review #${r.review_id} still has ${r.unanswered.length} thread(s) without your reply: ` +
            `${r.unanswered.map((t) => `thread ${t.thread_id} (${lines(t)})`).join(', ')}. ` +
            'Reply to each with the postil reply tool, then call complete_review.'
        : `Every thread in review #${r.review_id} has your reply. Call the postil complete_review tool with a short summary to finish it.`,
    );
  }
  if (status.waiting.length) parts.push(agentHint(status.waiting));
  return parts.length ? `postil: ${parts.join('\n')}` : null;
}

function emit(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

/**
 * Claude Code hook handlers. They must never disrupt a session: any failure, a missing server,
 * or a session that is not listening for reviews means exit 0 with no output.
 */
export async function runHook(event: string): Promise<number> {
  const input = await readInput();
  try {
    const client = await PostilClient.connect(input.cwd ?? process.cwd(), { probeTimeoutMs: 800 });
    const session = input.session_id;
    const status = session ? await client.request<HookStatus>('GET', `/api/agent/hook-status?session=${encodeURIComponent(session)}`) : null;

    switch (event) {
      case 'stop': {
        // Honour Claude Code's loop guard: block at most once per stop.
        if (input.stop_hook_active || !status?.listener) return 0;
        const reason = owed(status);
        if (reason) emit({ decision: 'block', reason });
        return 0;
      }
      case 'prompt': {
        if (!status?.listener) return 0;
        const reason = owed(status);
        if (reason) emit({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: reason } });
        return 0;
      }
      case 'session-start': {
        let context: string;
        if (status?.listener && input.source === 'compact') {
          context =
            'This session is handling postil code reviews. When a postil review event arrives, fetch it with the postil ' +
            'get_review tool, address and reply to every thread, then call complete_review. Only the user resolves threads.' +
            (owed(status) ? `\n${owed(status)}` : '');
        } else if (status?.listener) {
          context =
            'This session was listening for postil reviews, and its monitor did not survive the restart. Call the postil ' +
            'connect tool and re-arm the Monitor on the URL it returns.' + (owed(status) ? `\n${owed(status)}` : '');
        } else {
          context = `A postil review server is running for this repository (UI: ${client.uiUrl}). To handle reviews from it automatically, use the postil review skill.`;
        }
        emit({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context } });
        return 0;
      }
      default:
        return 0;
    }
  } catch {
    return 0;
  }
}
