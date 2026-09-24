/// <reference lib="webworker" />
/**
 * Syntax highlighting off the main thread: a whole file can take a second or more to tokenize.
 * Uses Shiki's JavaScript regex engine, so no WebAssembly (and no CSP exception) is needed.
 * Grammars load on demand, one chunk per language.
 */
import { createHighlighterCore, type HighlighterCore } from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';
import { bundledLanguages, bundledLanguagesInfo } from 'shiki/langs';
import { bundledThemes } from 'shiki/themes';
import type { HighlightRequest, HighlightResponse, Token } from './protocol.ts';

const ready: Promise<HighlighterCore> = createHighlighterCore({
  themes: [bundledThemes['github-light'](), bundledThemes['github-dark']()],
  langs: [],
  engine: createJavaScriptRegexEngine(),
});

const byAlias = new Map<string, string>();
for (const info of bundledLanguagesInfo) {
  byAlias.set(info.id, info.id);
  for (const a of info.aliases ?? []) byAlias.set(a, info.id);
}

const EXTENSIONS: Record<string, string> = {
  mjs: 'javascript', cjs: 'javascript', mts: 'typescript', cts: 'typescript', yml: 'yaml', h: 'c', hpp: 'cpp',
  cc: 'cpp', hh: 'cpp', cxx: 'cpp', rs: 'rust', py: 'python', rb: 'ruby', kt: 'kotlin', kts: 'kotlin', cs: 'csharp',
  sh: 'bash', zsh: 'bash', bash: 'bash', ps1: 'powershell', md: 'markdown', mdx: 'mdx', htm: 'html', svg: 'xml',
  jsonc: 'jsonc', json5: 'json5', tf: 'hcl', gql: 'graphql', proto: 'proto', txt: '',
};
const NAMES: Record<string, string> = {
  dockerfile: 'docker', makefile: 'make', 'cmakelists.txt': 'cmake', gemfile: 'ruby', rakefile: 'ruby', '.bashrc': 'bash',
};

/** The Shiki language for a file path, or for a Markdown fence's language name. */
export function resolveLanguage(nameOrPath: string): string | null {
  const base = nameOrPath.split('/').pop()!.toLowerCase();
  if (NAMES[base] !== undefined) return NAMES[base] || null;
  const ext = base.includes('.') ? base.split('.').pop()! : base;
  const mapped = EXTENSIONS[ext] ?? ext;
  if (mapped === '') return null;
  return byAlias.get(mapped) ?? null;
}

const scope = self as unknown as DedicatedWorkerGlobalScope;

// Newest first: after a fast scroll, the files on screen asked last, and files merely scrolled
// past should not make them wait.
const pending: HighlightRequest[] = [];
let busy = false;
scope.onmessage = (e: MessageEvent<HighlightRequest>) => {
  pending.push(e.data);
  if (!busy) void drain();
};
async function drain(): Promise<void> {
  busy = true;
  while (pending.length) await handle(pending.pop()!);
  busy = false;
}

async function handle({ id, text, language }: HighlightRequest): Promise<void> {
  const reply = (r: HighlightResponse) => scope.postMessage(r);
  try {
    const lang = resolveLanguage(language);
    if (!lang || !(lang in bundledLanguages)) return reply({ id, lines: null });
    const h = await ready;
    if (!h.getLoadedLanguages().includes(lang)) await h.loadLanguage(bundledLanguages[lang as keyof typeof bundledLanguages]());
    const { tokens } = h.codeToTokens(text, { lang, themes: { light: 'github-light', dark: 'github-dark' }, defaultColor: false });
    const lines: Token[][] = tokens.map((line) =>
      line.map((t) => [t.content, String(t.htmlStyle?.['--shiki-light'] ?? ''), String(t.htmlStyle?.['--shiki-dark'] ?? '')]),
    );
    reply({ id, lines });
  } catch (err) {
    reply({ id, lines: null, error: String(err) });
  }
}
