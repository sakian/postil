/**
 * Build postil and (re)install its Claude Code plugin from this checkout.
 *
 *   npm run install-plugin
 *
 * A reinstall is what makes Claude Code take a rebuilt plugin: `claude plugin update` keeps the
 * cached copy while the version number is unchanged.
 */
import { execSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const claude = (...args: string[]) => spawnSync('claude', args, { encoding: 'utf8' });

if (claude('--version').error) {
  console.error('Claude Code (`claude`) is not on PATH. Install it first.');
  process.exit(1);
}
execSync('npm run build', { cwd: root, stdio: 'inherit' }); // through a shell: npm is npm.cmd on Windows

const listed = claude('plugin', 'marketplace', 'list').stdout ?? '';
const step = listed.includes('postil')
  ? claude('plugin', 'marketplace', 'update', 'postil')
  : claude('plugin', 'marketplace', 'add', root);
if (step.status !== 0) {
  console.error(step.stderr || step.stdout);
  process.exit(1);
}
claude('plugin', 'uninstall', 'postil@postil'); // absent on a first install; that is fine
const install = claude('plugin', 'install', 'postil@postil');
if (install.status !== 0) {
  console.error(install.stderr || install.stdout);
  process.exit(1);
}
console.log('\nInstalled the postil plugin. In a Claude Code session, run /postil:review.');
console.log('Sessions that were already open pick it up after a restart.');
