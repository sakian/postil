import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import type { AgentReview, AppliedSuggestion, ListenResult, ReviewView, ThreadView } from '../core/api-types.ts';
import { ApiError, NotRunningError, PostilClient } from '../core/client.ts';
import { VERSION } from '../core/version.ts';
import { formatPending, formatReview, formatUiThread } from './agent-format.ts';
import { openBrowser, startDaemon, waitCommand } from './daemon.ts';
import { describeExport, describeImport } from './transfer-format.ts';

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

const text = (t: string): ToolResult => ({ content: [{ type: 'text', text: t }] });
const failure = (t: string): ToolResult => ({ content: [{ type: 'text', text: t }], isError: true });

/**
 * The MCP server the Claude Code plugin runs. It holds no state: every call finds the review
 * server for the project through its discovery file, so the review server can be started,
 * stopped or restarted at any time without restarting Claude.
 */
export function createMcpServer(env: { projectDir: string; session: string | undefined }): McpServer {
  const server = new McpServer({ name: 'postil', version: VERSION });

  const withClient = async (fn: (client: PostilClient) => Promise<ToolResult>): Promise<ToolResult> => {
    try {
      return await fn(await PostilClient.connect(env.projectDir, { session: env.session }));
    } catch (e) {
      if (e instanceof NotRunningError) {
        return failure(`${e.message}. Call connect to start it.`);
      }
      if (e instanceof ApiError) return failure(`postil: ${e.message}`);
      return failure(`postil: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  server.registerTool(
    'connect',
    {
      title: 'Listen for postil reviews',
      description:
        "Register this session to receive postil reviews, starting the repository's review server if needed, and get the " +
        'URL to watch. Arm the Monitor tool on it so you are woken when the user submits a review. After the monitor ' +
        'closes, call again with start=false, so a server the user stopped on purpose is not restarted.',
      inputSchema: { start: z.boolean().optional().describe('Start the server if it is not running (default true).') },
    },
    async ({ start }) => {
      let note: string | null = null;
      if (start !== false) {
        try {
          const started = await startDaemon(env.projectDir);
          if (started.restarted) note = 'Restarted the review server, which was running an older build of postil. Tell the user to reload the review tab.';
          if (started.outdated) {
            note = 'The review server runs an older build of postil. It was left running because a review is waiting or in progress; ' +
              'it is restarted on the next connect once that review is complete.';
          }
        } catch (e) {
          return failure(`postil: could not start the review server: ${e instanceof Error ? e.message : String(e)}`);
        }
      } else {
        try {
          await PostilClient.connect(env.projectDir);
        } catch (e) {
          if (!(e instanceof NotRunningError)) throw e;
          return failure(
            `The postil server is not running (it may be restarting). To be told when it is back, arm the Monitor tool ` +
              `with command: ${waitCommand(e.root)}  (description "postil server restart", timeout_ms 1800000). ` +
              'When it reports the server is running, call connect again and re-arm the WebSocket monitor.',
          );
        }
      }
      return withClient(async (client) => {
        const { pending } = client.session
          ? await client.request<ListenResult>('POST', '/api/agent/listen')
          : { pending: (await client.request<{ reviews: ReviewView[] }>('GET', '/api/agent/pending')).reviews.map((r) => r.id) };
        return text(
          [
            `postil is running for ${client.info.root}.`,
            ...(note ? [note] : []),
            `Review UI (for the user): ${client.uiUrl}`,
            '',
            'To be woken when the user submits a review, arm the Monitor tool with:',
            `  ws.url: ${client.agentEventsUrl}`,
            '  description: postil review requests',
            '  timeout_ms: 1800000',
            'When the monitor expires or its WebSocket closes, call connect again and re-arm it.',
            ...(client.session ? [] : ['', 'Warning: no Claude Code session id was available, so hooks cannot recognise this session.']),
            '',
            pending.length ? `Reviews already waiting: ${pending.map((id) => `#${id}`).join(', ')}. Handle them now with get_review.` : 'No reviews are waiting yet.',
          ].join('\n'),
        );
      });
    },
  );

  server.registerTool(
    'open_ui',
    { title: 'Open the review UI', description: "Open the postil review UI in the user's browser.", inputSchema: {} },
    async () =>
      withClient(async (client) =>
        text((await openBrowser(client.uiUrl)) ? `Opened ${client.uiUrl}` : `No browser could be launched here. Give the user this address: ${client.uiUrl}`),
      ),
  );

  server.registerTool(
    'list_pending',
    { title: 'List waiting reviews', description: 'List postil reviews the user has submitted that are not yet complete.', inputSchema: {} },
    async () => withClient(async (client) => text(formatPending((await client.request<{ reviews: ReviewView[] }>('GET', '/api/agent/pending')).reviews))),
  );

  server.registerTool(
    'get_review',
    {
      title: 'Get a review',
      description:
        "Fetch a submitted postil review: every thread with the user's comments, the lines they refer to, and which threads " +
        'still need your reply. Fetching claims the review for this session.',
      inputSchema: { review_id: z.number().int().positive() },
    },
    async ({ review_id }) =>
      withClient(async (client) => text(formatReview(await client.request<AgentReview>('GET', `/api/agent/reviews/${review_id}`)))),
  );

  server.registerTool(
    'get_thread',
    {
      title: 'Get a thread',
      description: 'Fetch one postil review thread with its full conversation.',
      inputSchema: { thread_id: z.number().int().positive() },
    },
    async ({ thread_id }) =>
      withClient(async (client) => {
        const thread = await client.request<ThreadView>('GET', `/api/threads/${thread_id}`);
        if (!thread.published) return failure(`thread ${thread_id} has not been submitted yet`);
        return text(formatUiThread(thread));
      }),
  );

  server.registerTool(
    'reply',
    {
      title: 'Reply to a thread',
      description:
        'Reply to a postil review thread. The user sees it immediately in the review UI. Say briefly what you changed and ' +
        'where, or answer the question. Set needs_decision when the user must choose before you can proceed.',
      inputSchema: {
        thread_id: z.number().int().positive(),
        body: z.string().min(1).describe('Markdown. Keep it short.'),
        needs_decision: z.boolean().optional(),
      },
    },
    async ({ thread_id, body, needs_decision }) =>
      withClient(async (client) => {
        await client.request('POST', `/api/agent/threads/${thread_id}/reply`, { body, needs_decision: needs_decision ?? false });
        return text(`Replied to thread ${thread_id}.`);
      }),
  );

  server.registerTool(
    'apply_suggestion',
    {
      title: 'Apply a suggestion',
      description:
        "Write a comment's ```suggestion block into the working tree, replacing the lines the comment is attached to. " +
        'Refused if those lines have changed since the comment was written; then make the edit yourself. Reply to the thread afterwards.',
      inputSchema: { comment_id: z.number().int().positive() },
    },
    async ({ comment_id }) =>
      withClient(async (client) => {
        const r = await client.request<AppliedSuggestion>('POST', `/api/agent/comments/${comment_id}/apply`);
        const lines = r.start_line === r.end_line ? `line ${r.start_line}` : `lines ${r.start_line}-${r.end_line}`;
        return text(`Applied the suggestion from comment ${comment_id} to ${r.path}, now at ${lines}. Reply to thread ${r.thread_id} to say so.`);
      }),
  );

  server.registerTool(
    'complete_review',
    {
      title: 'Complete a review',
      description:
        'Mark a postil review as addressed once every thread in it has your reply. Refused, with the list of threads, while any lack one.',
      inputSchema: { review_id: z.number().int().positive(), summary: z.string().min(1).describe('One or two sentences for the user.') },
    },
    async ({ review_id, summary }) =>
      withClient(async (client) => {
        await client.request('POST', `/api/agent/reviews/${review_id}/complete`, { summary });
        return text(`Review #${review_id} is complete. The user will see your summary and replies in the review UI.`);
      }),
  );

  server.registerTool(
    'reset',
    {
      title: 'Discard the review',
      description:
        'Discard the postil review in progress so the user can start a new one: archive every conversation and review, ' +
        'delete comments the user has not submitted, and clear viewed marks. Only when the user asks for it.',
      inputSchema: {},
    },
    async () =>
      withClient(async (client) => {
        const r = await client.request<{ threads: number; reviews: number; drafts: number }>('POST', '/api/reset');
        return text(
          `Archived ${r.threads} conversation(s) and ${r.reviews} review(s), and deleted ${r.drafts} unsent comment(s). ` +
            'Drop any review you were working on; the user can find the old conversations under Archived.',
        );
      }),
  );

  server.registerTool(
    'export_session',
    {
      title: 'Export the review session',
      description:
        "Write this repository's postil session to a file, so the user can carry it on in a clone on another computer " +
        'with `postil import` or import_session. It holds the conversations, reviews, viewed marks, the snapshots they ' +
        'need, local commits, and the working tree as it is. By default this Claude Code conversation goes along, so it ' +
        'can be resumed there. Only when the user asks for it.',
      inputSchema: {
        file: z.string().optional().describe('Where to write it. Default: a timestamped file in the home directory.'),
        include_conversation: z.boolean().optional().describe('Include this Claude Code conversation (default true).'),
      },
    },
    async ({ file, include_conversation }) => {
      const include = include_conversation !== false;
      if (include && !env.session) return failure('postil: no Claude Code session id is available, so the conversation cannot be included. Call again with include_conversation false.');
      try {
        const { exportSession } = await import('../core/transfer.ts');
        const r = await exportSession(env.projectDir, { ...(file !== undefined && { file }), ...(include && { claudeSession: env.session! }) });
        return text(describeExport(r));
      } catch (e) {
        return failure(`postil: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );

  server.registerTool(
    'import_session',
    {
      title: 'Import a review session',
      description:
        'Take over a postil session that `postil export` or export_session wrote in another clone. The review server ' +
        'must not be running here. Then call connect to listen. Only when the user asks for it.',
      inputSchema: {
        file: z.string().min(1),
        worktree: z.boolean().optional().describe(
          'Also bring the exported uncommitted changes into this working tree, which must have none of its own, fast-forwarding to the exported commit if needed.',
        ),
        force: z.boolean().optional().describe('Replace a session already under way here, keeping its database as a backup. Only when the user agrees.'),
      },
    },
    async ({ file, worktree, force }) => {
      try {
        const { importSession } = await import('../core/transfer.ts');
        return text(describeImport(await importSession(env.projectDir, file, { worktree: worktree ?? false, force: force ?? false })));
      } catch (e) {
        return failure(`postil: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );

  return server;
}

export async function runMcpServer(): Promise<void> {
  const server = createMcpServer({
    projectDir: process.env.CLAUDE_PROJECT_DIR ?? process.cwd(),
    session: process.env.CLAUDE_CODE_SESSION_ID,
  });
  await server.connect(new StdioServerTransport());
  await new Promise<void>((resolve) => {
    process.stdin.on('close', resolve);
    process.on('SIGTERM', resolve);
  });
}
