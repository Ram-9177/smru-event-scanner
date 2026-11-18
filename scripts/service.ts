#!/usr/bin/env node
/**
 * Run Event Photos all the time on this Mac: a login service (launchd LaunchAgent) that runs scripts/start.ts.
 *
 *   npm run service install     start it now and at every login; started again if it stops
 *   npm run service status      is it running, does the app answer, does the public link answer, the last log lines
 *   npm run service stop        stop it until the next login (or until: npm run service start)
 *   npm run service start       start it again after a stop
 *   npm run service uninstall   stop it and do not start it at login any more
 *
 * `npm run service -- install --dry-run` prints the service file and changes nothing.
 * The Mac is kept awake while it runs (caffeinate -is). What it prints goes to logs/service.log (and logs/start.log).
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ngrokDomainFrom, ngrokHostOf, probe } from './tunnel.ts';

export const LABEL = 'local.event-photos';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLIST = path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
const LOG = path.join(ROOT, 'logs', 'service.log');
const BASE_PATH = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The LaunchAgent file: start.ts --service under caffeinate, at login, started again unless it ended cleanly. */
/**
 * The node to run: Homebrew's stable link (/opt/homebrew/bin/node, /usr/local/bin/node) when it is this same node,
 * not the versioned Cellar folder process.execPath points to, which `brew upgrade node` removes.
 */
export function stableNode(exec = process.execPath, links = ['/opt/homebrew/bin/node', '/usr/local/bin/node']): string {
  if (!exec.includes('/Cellar/')) return exec;
  for (const link of links) {
    try {
      if (fs.realpathSync(link) === fs.realpathSync(exec)) return link;
    } catch {}
  }
  return exec;
}

export function plistXml({ root = ROOT, node = stableNode() }: { root?: string; node?: string } = {}): string {
  const log = path.join(root, 'logs', 'service.log');
  const nodeDir = path.dirname(node);
  const envPath = BASE_PATH.split(':').includes(nodeDir) ? BASE_PATH : `${nodeDir}:${BASE_PATH}`;
  const args = ['/usr/bin/caffeinate', '-is', node, path.join(root, 'scripts', 'start.ts'), '--service'];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((a) => `    <string>${xml(a)}</string>`).join('\n')}
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(root)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>30</integer>
  <key>StandardOutPath</key>
  <string>${xml(log)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(log)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${xml(envPath)}</string>
  </dict>
</dict>
</plist>
`;
}

function readEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  const file = path.join(ROOT, 'server', '.env');
  if (!fs.existsSync(file)) return env;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (m) env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2').trim();
  }
  return env;
}

const target = () => `gui/${process.getuid?.() ?? os.userInfo().uid}`;
function launchctl(...argv: string[]): { code: number; out: string } {
  const r = spawnSync('/bin/launchctl', argv, { encoding: 'utf8' });
  return { code: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
}
const loaded = () => launchctl('print', `${target()}/${LABEL}`).code === 0;
/** bootout returns before the old one has quite gone; bootstrap too soon fails. Wait up to 10 seconds. */
function bootout(): void {
  launchctl('bootout', `${target()}/${LABEL}`);
  const nap = new Int32Array(new SharedArrayBuffer(4));
  for (let i = 0; i < 40 && loaded(); i++) Atomics.wait(nap, 0, 0, 250);
}

function macOnly(): void {
  if (process.platform === 'darwin') return;
  console.log('The login service is for a Mac only. On a server use systemd or pm2 to keep "node scripts/start.ts --service" running.');
  process.exit(1);
}

function bootstrap(): boolean {
  const r = launchctl('bootstrap', target(), PLIST);
  if (r.code !== 0) {
    console.log(`launchctl could not start it (${r.out || `code ${r.code}`}).`);
    return false;
  }
  return true;
}

function install(dryRun: boolean): void {
  const text = plistXml();
  if (dryRun) {
    console.log(`Would write ${PLIST}:\n`);
    process.stdout.write(text);
    return;
  }
  macOnly();
  fs.mkdirSync(path.dirname(PLIST), { recursive: true });
  fs.mkdirSync(path.dirname(LOG), { recursive: true });
  fs.writeFileSync(PLIST, text, { mode: 0o644 });
  fs.chmodSync(PLIST, 0o644);
  if (loaded()) bootout();
  console.log(`Wrote the login service ${PLIST}.`);
  if (!bootstrap()) process.exit(1);
  console.log('Event Photos now runs by itself: started now, at every login, and again if it stops.');
  console.log('The Mac stays awake while it runs (the screen may still turn off).');
  console.log('If it was already running in a Terminal window, the service watches that one and takes over when it stops.');
  console.log(`What it does is written to ${path.relative(ROOT, LOG)} (and logs/start.log).`);
  console.log('Check it: npm run service status   Stop it for a while: npm run service stop   Remove it: npm run service uninstall');
}

function stop(): void {
  macOnly();
  if (!loaded()) return console.log('The login service is not running.');
  bootout();
  console.log(
    fs.existsSync(PLIST)
      ? 'Stopped Event Photos. It starts again at the next login, or now with: npm run service start'
      : 'Stopped Event Photos.',
  );
}

function start(): void {
  macOnly();
  if (!fs.existsSync(PLIST)) return console.log('The login service is not installed. Install it with: npm run service install');
  if (loaded()) return console.log('The login service is already running. See: npm run service status');
  if (!bootstrap()) process.exit(1);
  console.log('Started Event Photos (login service).');
}

function uninstall(): void {
  macOnly();
  const was = loaded();
  if (was) bootout();
  const had = fs.existsSync(PLIST);
  fs.rmSync(PLIST, { force: true });
  if (!was && !had) return console.log('The login service was not installed. Nothing to do.');
  console.log('Removed the login service. Event Photos is stopped and does not start at login any more.');
  console.log('To run it by hand: double-click Start Event Photos, or npm run launch.');
}

async function status(): Promise<void> {
  macOnly();
  const env = readEnv();
  const port = env.PORT || '3000';
  console.log(`Login service:  ${fs.existsSync(PLIST) ? `installed (${PLIST})` : 'not installed (npm run service install)'}`);
  const p = launchctl('print', `${target()}/${LABEL}`);
  if (p.code !== 0) console.log('Running:        no');
  else {
    const state = /^\s*state = (.+)$/m.exec(p.out)?.[1]?.trim() ?? 'unknown';
    const pid = /^\s*pid = (\d+)/m.exec(p.out)?.[1];
    const last = /^\s*last exit code = (.+)$/m.exec(p.out)?.[1]?.trim();
    console.log(`Running:        ${state}${pid ? ` (pid ${pid})` : ''}${last ? `, last exit: ${last}` : ''}`);
  }
  const local = await probe(`http://127.0.0.1:${port}`, 3000);
  console.log(`App:            http://127.0.0.1:${port} ${local.ok ? 'answers' : `does not answer (${local.reason})`}`);
  const domain = ngrokDomainFrom(env.NGROK_DOMAIN) || ngrokHostOf(env.PUBLIC_URL);
  const publicUrl = domain ? `https://${domain}` : (env.PUBLIC_URL || '').replace(/\/+$/, '');
  if (publicUrl && !/^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(publicUrl)) {
    const pub = await probe(publicUrl, 15_000);
    console.log(`Public link:    ${publicUrl} ${pub.ok ? 'answers' : `does NOT answer (${pub.reason})`}`);
  } else console.log('Public link:    none (set NGROK_DOMAIN in server/.env)');
  if (fs.existsSync(LOG)) {
    const lines = fs.readFileSync(LOG, 'utf8').split(/\r?\n/).filter((l) => l.trim()).slice(-10);
    console.log(`\nLast lines of ${path.relative(ROOT, LOG)}:`);
    for (const l of lines) console.log(`  ${l}`);
  } else console.log(`\nNo ${path.relative(ROOT, LOG)} yet.`);
}

async function main(argv: string[]): Promise<void> {
  const cmd = argv.find((a) => !a.startsWith('-'));
  const dryRun = argv.includes('--dry-run');
  if (cmd === 'install') return install(dryRun);
  if (cmd === 'uninstall') return uninstall();
  if (cmd === 'status') return status();
  if (cmd === 'stop') return stop();
  if (cmd === 'start') return start();
  console.log('Use: npm run service install | status | stop | start | uninstall   (install --dry-run: show the service file only)');
  process.exitCode = cmd ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
