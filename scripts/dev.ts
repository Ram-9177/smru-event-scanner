#!/usr/bin/env node
/**
 * Start everything with one command (TypeScript, run directly by Node 22.18+).
 *   npm run demo   server (with the face engine inside it); open http://localhost:3000   (to try the app)
 *   npm run dev    server + Vite; open http://localhost:5173                           (while changing code)
 * PostgreSQL 16 and Redis must be running (npm run launch starts them on a Mac with Homebrew).
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const parts: [string, string, string[]][] = [
  ['server', npm, ['run', 'dev', '-w', 'server']],
  ['web', npm, ['run', 'dev', '-w', 'web']],
];
const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null;
// npm run demo: everything on one address (http://localhost:3000), with the web app built once.
const demo = process.argv.includes('--demo');
/** Newest change time of the files under a path. */
function newest(p: string): number {
  const st = fs.statSync(p, { throwIfNoEntry: false });
  if (!st) return 0;
  if (!st.isDirectory()) return st.mtimeMs;
  return Math.max(0, ...fs.readdirSync(p).map((n) => newest(`${p}/${n}`)));
}
const builtAt = newest('web/dist/index.html');
if (demo && Math.max(newest('web/src'), newest('web/public'), newest('web/index.html')) > builtAt) {
  console.log(builtAt ? 'The web app changed: building it again ...' : 'Building the web app (first run only) ...');
  const built = spawnSync(npm, ['run', 'build', '-w', 'web'], { stdio: 'inherit', shell: process.platform === 'win32' });
  if (built.status !== 0) process.exit(built.status ?? 1);
}
const children = parts.filter(([name]) => (demo ? name !== 'web' : !only || name === only)).map(([name, cmd, args]) => {
  const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' });
  const say = (data: Buffer) => String(data).split('\n').filter(Boolean).forEach((line) => console.log(`[${name}] ${line}`));
  child.stdout.on('data', say);
  child.stderr.on('data', say);
  child.on('exit', (code) => console.log(`[${name}] stopped${code ? ` (code ${code})` : ''}`));
  return child;
});
const stop = () => {
  children.forEach((c) => c.kill());
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
if (demo) console.log('Open http://localhost:3000  (admin console: http://localhost:3000/admin)');
else if (!only) console.log('Open http://localhost:5173  (admin console: http://localhost:5173/admin)');
