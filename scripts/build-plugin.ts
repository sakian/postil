/**
 * Bundle the CLI, server, MCP server and hooks into plugin/dist/postil.mjs, and copy the built
 * UI beside it, so the Claude Code plugin runs with nothing but `node`: no checkout, no
 * `npm install`, and nothing on PATH.
 *
 *   npm run build   (builds the UI first, then this)
 */
import { build } from 'esbuild';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const out = `${root}plugin/dist`;
const { version } = JSON.parse(readFileSync(`${root}package.json`, 'utf8')) as { version: string };

if (!existsSync(`${root}web/dist/index.html`)) throw new Error('build the UI first: vite build --config web/vite.config.ts');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

await build({
  entryPoints: [`${root}src/cli/main.ts`],
  outfile: `${out}/postil.mjs`,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  minify: false,
  legalComments: 'none',
  define: { __POSTIL_BUNDLE__: 'true', __POSTIL_VERSION__: JSON.stringify(version) },
  // ws speeds itself up with these native modules when present, and works without them.
  external: ['bufferutil', 'utf-8-validate'],
  banner: {
    // CommonJS dependencies call require(); give the ES module bundle one.
    // (esbuild keeps the entry file's own #! line first.)
    js: "import { createRequire as __postilRequire } from 'node:module';\nconst require = __postilRequire(import.meta.url);",
  },
});
cpSync(`${root}web/dist`, `${out}/web`, { recursive: true, filter: (src) => !src.endsWith('.map') });

const kb = (p: string) => `${Math.round(statSync(p).size / 1024)} KB`;
console.log(`plugin/dist/postil.mjs  ${kb(`${out}/postil.mjs`)}  (postil ${version})`);
console.log('plugin/dist/web         UI copied');
