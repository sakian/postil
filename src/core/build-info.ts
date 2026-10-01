import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * postil runs two ways: from source (Node strips the TypeScript) and as the single-file bundle
 * inside the Claude Code plugin. The bundler defines these constants; from source they are
 * undefined. Paths that depend on the layout are resolved here and nowhere else.
 */
declare const __POSTIL_BUNDLE__: boolean | undefined;
declare const __POSTIL_VERSION__: string | undefined;
declare const __POSTIL_BUILD__: Build | undefined;

/** One build of the bundle: a hash of what went into it, and when it was made. */
export interface Build {
  id: string;
  at: string;
}

export const BUNDLED: boolean = typeof __POSTIL_BUNDLE__ !== 'undefined' && __POSTIL_BUNDLE__;

export const VERSION: string =
  typeof __POSTIL_VERSION__ !== 'undefined'
    ? __POSTIL_VERSION__
    : (JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }).version;

/**
 * This bundle's build; null from source, where every edit would count as a new build. The version
 * number alone cannot tell a server started before a rebuild from one started after it.
 */
export const BUILD: Build | null = typeof __POSTIL_BUILD__ !== 'undefined' ? __POSTIL_BUILD__ : null;

/** The file to run for the `postil` command: the bundle itself, or the source entry point. */
export const CLI_ENTRY: string = BUNDLED ? fileURLToPath(import.meta.url) : fileURLToPath(new URL('../cli/main.ts', import.meta.url));

/** The built browser UI: next to the bundle, or web/dist in a checkout. */
export const DEFAULT_WEB_ROOT: string =
  process.env.POSTIL_WEB_ROOT ?? (BUNDLED ? fileURLToPath(new URL('./web', import.meta.url)) : fileURLToPath(new URL('../../web/dist', import.meta.url)));
