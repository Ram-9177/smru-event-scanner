#!/usr/bin/env node
/**
 * Run Event Photos on this computer in one step (TypeScript, run directly by Node 22.18+).
 *   Mac:      double-click "Start Event Photos.command"
 *   Anywhere: npm run launch
 *
 * It installs what is missing (the app's packages), checks PostgreSQL 16 and Redis (on a Mac with Homebrew it
 * starts them), makes the database and the settings file on the first run, fetches the two face model files
 * once, starts the app, adds three sample events on the first run, and opens the browser.
 * Close the window or press Ctrl+C to stop.
 *
 * Options: --no-open (no browser), --no-samples (start with no events),
 *          --service (run by the login service, scripts/service.ts: no browser, and if the app is already running,
 *          started another way, it only watches it until it stops)
 * Everything it prints also goes to logs/start.log.
 *
 * While it runs it keeps things up: the app is started again when it stops (scripts/supervisor.ts), and with
 * NGROK_DOMAIN in server/.env the public link is kept up with ngrok (scripts/tunnel.ts; PUBLIC_TUNNEL=off: not).
 */
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSamples } from './samples.ts';
import { superviseApp, type Supervisor } from './supervisor.ts';
import { findNgrok, ngrokDomainFrom, ngrokHostOf, startTunnel, type Tunnel } from './tunnel.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(ROOT);
const WIN = process.platform === 'win32';
const MAC = process.platform === 'darwin';
const opts = new Set(process.argv.slice(2));
const SERVICE = opts.has('--service');
if (SERVICE) opts.add('--no-open');
const SERVER = path.join(ROOT, 'server');
const ENV_FILE = path.join(SERVER, '.env');
const MODELS = path.join(SERVER, 'models');
const STAND_IN = 'Event Photos (stand-in for OneDrive)';

// ---- output: the window and logs/start.log -------------------------------------------------
fs.mkdirSync(path.join(ROOT, 'logs'), { recursive: true });
const LOG = path.join(ROOT, 'logs', 'start.log');
const LOG_MAX = 5 * 1024 * 1024;
if (fs.existsSync(LOG) && fs.statSync(LOG).size > LOG_MAX) fs.renameSync(LOG, `${LOG}.old`);
let logStream = fs.createWriteStream(LOG, { flags: 'a' });
let logBytes = fs.statSync(LOG, { throwIfNoEntry: false })?.size ?? 0;
/** The log file; it starts again (the old one kept as start.log.old) past 5 MB, also while running for weeks. */
const log = {
  write(d: string | Buffer) {
    logStream.write(d);
    logBytes += typeof d === 'string' ? Buffer.byteLength(d) : d.length;
    if (logBytes <= LOG_MAX) return;
    logStream.end();
    try {
      fs.renameSync(LOG, `${LOG}.old`);
    } catch {
      /* keep writing to the same file */
    }
    logStream = fs.createWriteStream(LOG, { flags: 'a' });
    logBytes = 0;
  },
};
const stamp = () => new Date().toTimeString().slice(0, 8);
function say(line = '') {
  console.log(line);
  log.write(`${stamp()} ${line}\n`);
}
/** Under the login service, launchd writes what is printed to logs/service.log: keep it under 10 MB too. */
function trimServiceLog(): void {
  const file = path.join(ROOT, 'logs', 'service.log');
  try {
    if ((fs.statSync(file, { throwIfNoEntry: false })?.size ?? 0) <= 10 * 1024 * 1024) return;
    fs.copyFileSync(file, `${file}.old`);
    fs.truncateSync(file, 0);
  } catch {
    /* not important */
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
class Stop extends Error {}
/** Say why, stop everything. stopWith is for event handlers; fail also ends the step that called it. */
function stopWith(message: string): void {
  if (stopping) return;
  say('');
  say(`Stopped: ${message}`);
  say(`Details are in ${path.relative(ROOT, LOG)}.`);
  stopAll(1);
}
function fail(message: string): never {
  stopWith(message);
  throw new Stop(message);
}

// ---- small helpers -----------------------------------------------------------------------------
const mtime = (p: string): number => fs.statSync(p, { throwIfNoEntry: false })?.mtimeMs ?? 0;
function newest(p: string): number {
  const st = fs.statSync(p, { throwIfNoEntry: false });
  if (!st) return 0;
  if (!st.isDirectory()) return st.mtimeMs;
  return Math.max(0, ...fs.readdirSync(p).map((n) => newest(path.join(p, n))));
}
const sha256 = (buf: Buffer): string => crypto.createHash('sha256').update(buf).digest('hex');

/** Run a command to the end, showing its output and keeping it in the log. */
function run(cmd: string, argv: string[], { cwd = ROOT, env = process.env, show = true }: { cwd?: string; env?: NodeJS.ProcessEnv; show?: boolean } = {}): Promise<{ code: number | null; error?: Error }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, argv, { cwd, env, shell: WIN, stdio: ['ignore', 'pipe', 'pipe'] });
    const out = (d) => {
      if (show) process.stdout.write(d);
      log.write(d);
    };
    child.stdout.on('data', out);
    child.stderr.on('data', out);
    child.on('error', (e) => resolve({ code: -1, error: e }));
    child.on('close', (code) => resolve({ code }));
  });
}

/** True when something answers on this port, on IPv4 or IPv6. */
function answers(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ port, host });
    const done = (v) => {
      s.destroy();
      resolve(v);
    };
    s.setTimeout(800, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}
function bindable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
  });
}
async function portFree(port: number): Promise<boolean> {
  return !(await answers(port, '127.0.0.1')) && !(await answers(port, '::1')) && (await bindable(port));
}
async function freePort(from: number): Promise<number> {
  for (let p = from; p < from + 50; p++) if (await portFree(p)) return p;
  fail(`no free port between ${from} and ${from + 49}.`);
}
async function getJson(url: string, ms = 1500): Promise<any> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(ms) });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}
async function waitFor(url: string, ms: number, what: string): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await getJson(url)) return true;
    if (stopping) throw new Stop('stopping');
    await new Promise((r) => setTimeout(r, 700));
  }
  fail(`${what} did not start within ${Math.round(ms / 1000)} seconds.`);
}
async function download(url: string, file: string): Promise<Buffer> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  fs.writeFileSync(file, buf);
  return buf;
}

// ---- settings file (server/.env) -------------------------------------------------------------
function readEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  if (!fs.existsSync(ENV_FILE)) return env;
  for (const line of fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (m) env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2').trim();
  }
  return env;
}
/** Set KEY=value in server/.env: replaces the active line, else a commented "# KEY=" line, else appends. */
function setEnv(values: Record<string, string | number>): void {
  let text = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, 'utf8') : '';
  for (const [key, value] of Object.entries(values)) {
    const line = `${key}=${value}`;
    const active = new RegExp(`^${key}=.*$`, 'm');
    const commented = new RegExp(`^#\\s*${key}=.*$`, 'm');
    if (active.test(text)) text = text.replace(active, line);
    else if (commented.test(text)) text = text.replace(commented, line);
    else text += `${text.endsWith('\n') || !text ? '' : '\n'}${line}\n`;
  }
  fs.writeFileSync(ENV_FILE, text, { mode: 0o600 });
}
function newPassword() {
  const abc = 'abcdefghjkmnpqrstuvwxyz23456789';
  const pick = () => Array.from(crypto.randomBytes(4), (b) => abc[b % abc.length]).join('');
  return `${pick()}-${pick()}-${pick()}-${pick()}`;
}

// ---- PostgreSQL 16 and Redis ---------------------------------------------------------------------
const BREW_PREFIXES = ['/opt/homebrew', '/usr/local'];
function which(name: string): string | null {
  const r = spawnSync(WIN ? 'where' : 'which', [name], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.split(/\r?\n/)[0].trim() || null : null;
}
const brew = (): string | null => which('brew') ?? BREW_PREFIXES.map((p) => `${p}/bin/brew`).find((p) => fs.existsSync(p)) ?? null;

/** Start a Homebrew service and wait until its port answers. */
async function brewStart(formula: string, port: number, what: string): Promise<void> {
  const b = MAC ? brew() : null;
  if (!b) fail(`${what} is not running on port ${port}. Start it, or set ${what === 'Redis' ? 'REDIS_URL' : 'DATABASE_URL'} in server/.env to where it runs.`);
  say(`Starting ${what} (${formula}) ...`);
  const r = await run(b!, ['services', 'start', formula], { show: false });
  if (r.code !== 0) fail(`${what} is not installed. Install it once with:  brew install ${formula}   then start again.`);
  const until = Date.now() + 30_000;
  while (Date.now() < until) {
    if (await answers(port, '127.0.0.1')) return;
    await new Promise((res) => setTimeout(res, 500));
  }
  fail(`${what} did not start within 30 seconds. Try:  brew services restart ${formula}`);
}

/** PostgreSQL 16 answering at DATABASE_URL, with the app's database made. */
async function setUpDatabase(databaseUrl: string): Promise<void> {
  const url = new URL(databaseUrl);
  const port = Number(url.port || 5432);
  const local = ['localhost', '127.0.0.1', '::1', ''].includes(url.hostname);
  if (local && !(await answers(port, '127.0.0.1')) && !(await answers(port, '::1'))) await brewStart('postgresql@16', port, 'PostgreSQL 16');
  const { default: pg } = await import('pg');
  const name = decodeURIComponent(url.pathname.slice(1)) || 'event_photos';
  const adminUrl = new URL(url);
  adminUrl.pathname = '/postgres';
  const c = new pg.Client({ connectionString: adminUrl.href });
  try {
    await c.connect();
  } catch (e) {
    fail(`PostgreSQL at ${url.host} refused the connection: ${(e as Error).message}`);
  }
  try {
    const v = Number((await c.query('show server_version_num')).rows[0].server_version_num);
    if (Math.floor(v / 10000) !== 16) say(`Note: this PostgreSQL is version ${Math.floor(v / 10000)}; the app is built and tested on PostgreSQL 16.`);
    const has = await c.query('select 1 from pg_database where datname = $1', [name]);
    if (!has.rowCount) {
      await c.query(`create database "${name.replace(/"/g, '""')}"`);
      say(`Made the database ${name}.`);
    }
  } finally {
    await c.end();
  }
}

async function setUpRedis(redisUrl: string): Promise<void> {
  const url = new URL(redisUrl);
  const port = Number(url.port || 6379);
  const host = url.hostname || '127.0.0.1';
  if (await answers(port, host)) return;
  if (['localhost', '127.0.0.1', '::1'].includes(host)) return brewStart('redis', port, 'Redis');
  fail(`Redis does not answer at ${host}:${port} (REDIS_URL in server/.env).`);
}

// ---- the face models (YuNet and SFace from the OpenCV Zoo, about 39 MB) --------------------------
const ZOO = ['https://github.com/opencv/opencv_zoo/raw/main/models/', 'https://media.githubusercontent.com/media/opencv/opencv_zoo/main/models/'];
const FACE_MODELS = [
  ['face_detection_yunet_2023mar.onnx', 'face_detection_yunet/face_detection_yunet_2023mar.onnx', '8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4'],
  ['face_recognition_sface_2021dec.onnx', 'face_recognition_sface/face_recognition_sface_2021dec.onnx', '0ba9fbfa01b5270c96627c4ef784da859931e02f04419c829e83484087c34e79'],
];
async function setUpModels(): Promise<void> {
  fs.mkdirSync(MODELS, { recursive: true });
  for (const [name, where, want] of FACE_MODELS) {
    const file = path.join(MODELS, name);
    if (fs.existsSync(file) && sha256(fs.readFileSync(file)) === want) continue;
    say(`Downloading the face model ${name} (first run only) ...`);
    let ok = false;
    for (const base of ZOO) {
      try {
        const buf = await download(base + where, `${file}.part`);
        if (sha256(buf) !== want) throw new Error('the checksum does not match');
        fs.renameSync(`${file}.part`, file);
        ok = true;
        break;
      } catch (e) {
        say(`  ${base}: ${(e as Error).message}`);
      }
    }
    fs.rmSync(`${file}.part`, { force: true });
    if (!ok) fail(`could not download ${name}. Download it in a browser from ${ZOO[0] + where}, put it in ${MODELS} and start again.`);
  }
}

// ---- processes -------------------------------------------------------------------------------
const children = new Set<import('node:child_process').ChildProcess>();
let stopping = false;
let app: Supervisor | null = null;
let tunnel: Tunnel | null = null;
function stopAll(code = 0) {
  if (stopping) return;
  stopping = true;
  tunnel?.stop();
  app?.stop();
  const running = [...children].filter((c) => c.exitCode === null && c.signalCode === null);
  for (const c of running) c.kill('SIGTERM');
  // Give the app a few seconds to finish what it is doing, then go.
  const until = Date.now() + 8000;
  const wait = () => {
    if (Date.now() > until || running.every((c) => c.exitCode !== null || c.signalCode !== null)) process.exit(code);
    else setTimeout(wait, 200);
  };
  setTimeout(wait, 300);
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    say('');
    say('Stopping Event Photos ...');
    stopAll(0);
  });
}
/** Start a program, its output shown as "[name] ..." lines. Who watches it decides what happens when it stops. */
function startChild(name: string, cmd: string, argv: string[], { cwd = ROOT, env = process.env }: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) {
  const child = spawn(cmd, argv, { cwd, env, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
  const out = (d) => {
    for (const line of String(d).split('\n').filter(Boolean)) say(`[${name}] ${line}`);
  };
  child.stdout.on('data', out);
  child.stderr.on('data', out);
  children.add(child);
  child.on('exit', () => children.delete(child));
  child.on('error', () => children.delete(child));
  return child;
}
/** True when the app answers on this port. */
async function appAnswers(port: number | string): Promise<boolean> {
  return Boolean((await getJson(`http://127.0.0.1:${port}/api/events`))?.events);
}
/**
 * --service, and the app was started another way (by hand): watch it. Returns once it has not answered for two
 * minutes (the other start may be restarting it), so this one starts it.
 */
async function watchOther(port: string): Promise<void> {
  say('Event Photos is already running (started another way). Watching it.');
  for (;;) {
    await sleep(60_000);
    if (await appAnswers(port)) continue;
    let back = false;
    for (let i = 0; i < 12 && !back; i++) {
      await sleep(10_000);
      back = await appAnswers(port);
    }
    if (!back) {
      say('Event Photos stopped answering, so it is started here now.');
      return;
    }
  }
}
function openBrowser(url: string): void {
  if (opts.has('--no-open')) return;
  const [cmd, argv] = MAC ? ['open', [url]] : WIN ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
  try {
    spawn(cmd, argv, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
  } catch {
    /* no browser to open: the address is printed */
  }
}

// ---- the steps -------------------------------------------------------------------------------
async function main() {
  const [maj, min] = process.versions.node.split('.').map(Number);
  if (maj < 22 || (maj === 22 && min < 18)) fail(`this app needs Node.js 22.18 or newer; this is ${process.versions.node}. Get the LTS version from https://nodejs.org.`);
  say(`Event Photos, in ${ROOT}${SERVICE ? ' (started by the login service)' : ''}`);
  if (SERVICE) setInterval(trimServiceLog, 10 * 60_000).unref();

  // 1. Is it already running? Then only open it (the login service watches it instead).
  const saved = readEnv();
  if (saved.PORT && (await appAnswers(saved.PORT))) {
    if (SERVICE) {
      await watchOther(saved.PORT);
    } else {
      const dom = ngrokDomainFrom(process.env.NGROK_DOMAIN || saved.NGROK_DOMAIN);
      const url = dom ? `https://${dom}` : saved.PUBLIC_URL || `http://localhost:${saved.PORT}`;
      say(`Event Photos is already running: ${url}`);
      openBrowser(url);
      return stopAll(0);
    }
  }

  // 2. The app's packages.
  const nodeDir = path.dirname(process.execPath);
  const npmHere = path.join(nodeDir, WIN ? 'npm.cmd' : 'npm');
  const NPM = fs.existsSync(npmHere) ? npmHere : WIN ? 'npm.cmd' : 'npm';
  const env = { ...process.env, PATH: `${nodeDir}${path.delimiter}${process.env.PATH ?? ''}` };
  const installed = path.join(ROOT, 'node_modules', '.package-lock.json');
  if (!fs.existsSync(installed) || mtime(path.join(ROOT, 'package-lock.json')) > mtime(installed)) {
    say('');
    say('Installing the app\'s packages (first run: about a minute) ...');
    const r = await run(NPM, ['install', '--no-audit', '--no-fund'], { env });
    if (r.code !== 0) fail('the packages did not install. Check the internet connection and start again.');
  }

  // 3. The face models.
  await setUpModels();

  // 4. Build what changed.
  if (Math.max(newest('web/src'), newest('web/public'), mtime('web/index.html'), mtime('web/vite.config.ts')) > mtime('web/dist/index.html')) {
    say('');
    say('Building the screens ...');
    if ((await run(NPM, ['run', 'build', '-w', 'web'], { env })).code !== 0) fail('the screens did not build.');
  }
  if (Math.max(newest('server/src'), mtime('server/tsconfig.build.json')) > mtime('server/dist/index.js')) {
    say('');
    say('Building the server ...');
    if ((await run(NPM, ['run', 'build', '-w', 'server'], { env })).code !== 0) fail('the server did not build.');
  }

  // 5. Settings: made once, kept in server/.env.
  let first = false;
  if (!fs.existsSync(ENV_FILE)) {
    first = true;
    fs.copyFileSync(path.join(ROOT, '.env.example'), ENV_FILE);
    const port = await freePort(3000);
    setEnv({
      PORT: port,
      PUBLIC_URL: `http://localhost:${port}`,
      HOST: '127.0.0.1',
      ADMIN_EMAIL: 'admin@event-photos.local',
      ADMIN_PASSWORD: newPassword(),
      LOCAL_DRIVE_DIR: `../${STAND_IN}`,
    });
    say('');
    say('Made the settings file server/.env (it keeps the sign-in and the ports).');
  }
  let cfg = readEnv();
  // The fixed ngrok domain. A PUBLIC_URL that is already an ngrok address counts as one (written down once).
  if (!ngrokDomainFrom(process.env.NGROK_DOMAIN || cfg.NGROK_DOMAIN) && ngrokHostOf(cfg.PUBLIC_URL)) {
    setEnv({ NGROK_DOMAIN: ngrokHostOf(cfg.PUBLIC_URL) });
    say(`PUBLIC_URL is an ngrok address, so it is now NGROK_DOMAIN in server/.env and this start keeps that tunnel up.`);
    say('(To run ngrok yourself instead, set PUBLIC_TUNNEL=off there.)');
    cfg = readEnv();
  }
  const domain = ngrokDomainFrom(process.env.NGROK_DOMAIN || cfg.NGROK_DOMAIN);
  const tunnelOff = /^(off|0|false|no)$/i.test((process.env.PUBLIC_TUNNEL || cfg.PUBLIC_TUNNEL || '').trim());
  let port = Number(cfg.PORT || 3000);
  if (!(await portFree(port))) {
    const was = port;
    port = await freePort(port + 1);
    // With a fixed domain the link stays the same; only the port on this Mac changes.
    setEnv(domain ? { PORT: port } : { PORT: port, PUBLIC_URL: `http://localhost:${port}` });
    say(`Port ${was} is taken by another program, so Event Photos now uses ${port}.`);
    if (cfg.MS_CLIENT_ID && !domain) say(`OneDrive is set up: register http://localhost:${port}/admin/onedrive/callback in Microsoft Entra too, or free port ${was}.`);
    cfg = readEnv();
  }
  // PostgreSQL 16 and Redis: started if they are not running (Mac + Homebrew), and the database made.
  if (!cfg.DATABASE_URL || !cfg.REDIS_URL) {
    setEnv({ DATABASE_URL: cfg.DATABASE_URL || 'postgres://localhost:5432/event_photos', REDIS_URL: cfg.REDIS_URL || 'redis://127.0.0.1:6379' });
    cfg = readEnv();
  }
  say('');
  await setUpDatabase(cfg.DATABASE_URL);
  await setUpRedis(cfg.REDIS_URL);
  const here = `http://localhost:${port}`;
  const url = domain ? `https://${domain}` : cfg.PUBLIC_URL || here;
  const driveDir = path.resolve(SERVER, cfg.LOCAL_DRIVE_DIR || './data/drive');
  const local = !(cfg.MS_TENANT_ID && cfg.MS_CLIENT_ID && cfg.MS_CLIENT_SECRET) || cfg.DRIVE === 'local';
  if (local) fs.mkdirSync(driveDir, { recursive: true });

  // 6. Start the app (the face engine runs inside it). When it stops on its own it is started again.
  say('Starting the app ...');
  const appEnv: NodeJS.ProcessEnv = { ...env, PORT: String(port), PUBLIC_URL: url, HOST: cfg.HOST || '127.0.0.1' };
  if (domain) appEnv.NGROK_DOMAIN = domain;
  app = superviseApp({
    spawnApp: () => startChild('app', process.execPath, ['dist/index.js'], { cwd: SERVER, env: appEnv }),
    say,
    giveUp: (message) => stopWith(message),
    answering: async (child) => {
      const until = Date.now() + 120_000;
      while (Date.now() < until && child.exitCode === null && child.signalCode === null && !stopping) {
        if (await appAnswers(port)) return true;
        await sleep(1000);
      }
      return false;
    },
  });
  await waitFor(`http://127.0.0.1:${port}/api/events`, 90_000, 'The app');

  // 6b. The public link (NGROK_DOMAIN): reuse a running tunnel, else start ngrok and keep it up.
  if (domain && !tunnelOff) {
    const ngrok = findNgrok(process.env.NGROK_PATH || cfg.NGROK_PATH);
    if (!ngrok) say('ngrok is not installed, so there is no public link. Install it with:  brew install ngrok');
    else {
      tunnel = startTunnel({ domain, port, ngrok, say, api: process.env.NGROK_API || cfg.NGROK_API || undefined });
      await tunnel.ready;
    }
  }

  // 7. Sample events, once.
  const marker = path.join(SERVER, 'data', '.samples-done');
  if (local && !opts.has('--no-samples') && !fs.existsSync(marker) && cfg.ADMIN_EMAIL && cfg.ADMIN_PASSWORD) {
    say('');
    say('Adding three sample events ...');
    try {
      const added = await loadSamples({ base: `http://127.0.0.1:${port}`, email: cfg.ADMIN_EMAIL, password: cfg.ADMIN_PASSWORD, driveDir, say });
      say(added ? 'Sample events added. Delete them in the admin page when you start for real.' : 'The app already has events, so no samples were added.');
      fs.mkdirSync(path.dirname(marker), { recursive: true });
      fs.writeFileSync(marker, new Date().toISOString());
    } catch (e) {
      say(`Samples not added (${(e as Error).message}). The app works without them.`);
    }
  }

  // 8. Ready.
  say('');
  say('==================================================================');
  say(' Event Photos is running');
  say(`   Students:    ${url}`);
  say(`   Organisers:  ${url}/admin`);
  if (url !== here) say(`   On this Mac:  ${here}`);
  if (first) {
    say(`   Sign in:     ${cfg.ADMIN_EMAIL}  /  ${cfg.ADMIN_PASSWORD}`);
    say('                (also kept in server/.env; change it in Settings, My password)');
  } else if (cfg.ADMIN_EMAIL) {
    say(`   Sign in:     ${cfg.ADMIN_EMAIL}  (first password: ADMIN_PASSWORD in server/.env)`);
  }
  if (local) {
    say(`   Event folders (stand-in for OneDrive):`);
    say(`     ${driveDir}`);
    say(`     One folder per event. Then link it in the admin page and press Sync now.`);
  }
  if (SERVICE) say('   Runs by itself (login service). Check it: npm run service status. Stop it: npm run service stop');
  else say('   To stop: close this window, or press Ctrl+C.');
  say('==================================================================');
  openBrowser(url);
}

main().catch((e: unknown) => {
  if (!(e instanceof Stop)) stopWith((e as Error)?.stack || String(e));
});
