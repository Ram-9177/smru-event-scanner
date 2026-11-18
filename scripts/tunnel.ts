/**
 * The permanent public link: one ngrok tunnel to the fixed domain (NGROK_DOMAIN), run by start.ts.
 *
 * - An ngrok tunnel that is already running for the domain is reused, never a second one (ngrok's local API on
 *   127.0.0.1:4040 is asked first, then the public address itself).
 * - Otherwise start.ts runs `ngrok http --url=https://<domain> <port>` and starts it again when it stops
 *   (after 5, 10, 30, 60, 120 seconds, then every 120; back to 5 once it has stayed up for 10 minutes).
 * - Every 5 minutes the public address is fetched; when it does not answer that is said clearly (again once an hour
 *   while it stays down), and a tunnel is started if none is running.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';

export type Say = (line: string) => void;

/** ngrok's own local API (the agent's web interface). */
export const NGROK_API = 'http://127.0.0.1:4040/api/tunnels';
/** Without this header ngrok's free plan answers a browser warning page instead of the app. */
const SKIP_WARNING = { 'ngrok-skip-browser-warning': '1' };

/** NGROK_DOMAIN as a bare host name, as server/src/config.ts reads it: "https://x.ngrok-free.dev/" -> "x.ngrok-free.dev". */
export function ngrokDomainFrom(v: string | undefined): string {
  return (v ?? '').trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '').toLowerCase();
}

/** The host of PUBLIC_URL when it is an ngrok address (so it can stand in for NGROK_DOMAIN), else ''. */
export function ngrokHostOf(publicUrl: string | undefined): string {
  try {
    const u = new URL((publicUrl ?? '').trim());
    return u.protocol === 'https:' && /\.ngrok(-free)?\.(app|dev|io)$/i.test(u.hostname) ? u.hostname.toLowerCase() : '';
  } catch {
    return '';
  }
}

function executable(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** The ngrok program: NGROK_PATH, else the one on PATH, else where Homebrew puts it. null = not installed. */
export function findNgrok(explicit?: string): string | null {
  const onPath = (() => {
    const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['ngrok'], { encoding: 'utf8' });
    return r.status === 0 ? r.stdout.split(/\r?\n/)[0].trim() : '';
  })();
  for (const p of [explicit?.trim() ?? '', onPath, '/opt/homebrew/bin/ngrok', '/usr/local/bin/ngrok']) if (p && executable(p)) return p;
  return null;
}

/** The port number in an ngrok tunnel's addr ("http://localhost:3000", "localhost:3000", "3000"); null if none. */
export function portOfAddr(addr: unknown): number | null {
  const m = /(?:^|:)(\d{1,5})\/?$/.exec(String(addr ?? '').trim());
  return m ? Number(m[1]) : null;
}

export interface FoundTunnel {
  addr: string;
  port: number | null;
}

/** The tunnel for this domain that ngrok's local API lists, or null (no API, or no such tunnel). */
export async function existingTunnel(domain: string, api = NGROK_API, ms = 1500): Promise<FoundTunnel | null> {
  try {
    const r = await fetch(api, { signal: AbortSignal.timeout(ms) });
    if (!r.ok) return null;
    const body = (await r.json()) as { tunnels?: { public_url?: string; config?: { addr?: string } }[] };
    const want = `https://${domain}`;
    const t = (body?.tunnels ?? []).find((x) => String(x?.public_url ?? '').toLowerCase().replace(/\/+$/, '') === want);
    if (!t) return null;
    const addr = String(t.config?.addr ?? '');
    return { addr, port: portOfAddr(addr) };
  } catch {
    return null;
  }
}

export interface Probe {
  /** HTTP status; 0 = no answer at all. */
  status: number;
  /** ngrok answered that nothing serves this domain now (ERR_NGROK_3200). */
  offline: boolean;
  ok: boolean;
  reason: string;
}

/** Fetch <base>/api/events the way a student's phone reaches it. */
export async function probe(base: string, ms: number): Promise<Probe> {
  try {
    const r = await fetch(`${base}/api/events`, { headers: SKIP_WARNING, signal: AbortSignal.timeout(ms), redirect: 'manual' });
    const text = await r.text().catch(() => '');
    const offline = r.status === 404 && (text.includes('ERR_NGROK_3200') || (r.headers.get('ngrok-error-code') ?? '') === 'ERR_NGROK_3200');
    const ok = r.status >= 200 && r.status < 300;
    return { status: r.status, offline, ok, reason: offline ? 'ngrok says nothing is serving it' : `HTTP ${r.status}` };
  } catch (e) {
    const err = e as Error & { cause?: { code?: string; message?: string } };
    const reason =
      err.name === 'TimeoutError' || err.name === 'AbortError'
        ? `no answer in ${Math.round(ms / 1000)} seconds`
        : err.cause?.code || err.cause?.message || err.message || String(e);
    return { status: 0, offline: false, ok: false, reason };
  }
}

export interface TunnelOptions {
  domain: string;
  port: number;
  /** The ngrok program (findNgrok). */
  ngrok: string;
  say: Say;
  /** ngrok's local API (tests use a fake). */
  api?: string;
  /** Where the public address is fetched (tests use a fake); default https://<domain>. */
  base?: string;
  restartDelaysMs?: number[];
  /** Up this long: the restart delays start again from the first. */
  stableMs?: number;
  firstCheckMs?: number;
  checkEveryMs?: number;
  /** While the link stays down, say so again this often. */
  downRepeatMs?: number;
  apiTimeoutMs?: number;
  reuseTimeoutMs?: number;
  checkTimeoutMs?: number;
}

export type TunnelStart = 'reused' | 'started' | 'other-port';

export interface Tunnel {
  /** The first decision: reused, started, or another port's tunnel is in the way. */
  ready: Promise<TunnelStart>;
  /** One check of the public address now (the timer does this every 5 minutes). */
  check(): Promise<Probe>;
  /** Our own ngrok, while it runs (a reused tunnel is not ours). */
  child(): ChildProcess | null;
  /** Stop checking and stop our own ngrok. A reused tunnel is left running. */
  stop(): void;
}

export function startTunnel(o: TunnelOptions): Tunnel {
  const url = `https://${o.domain}`;
  const base = o.base ?? url;
  const api = o.api ?? NGROK_API;
  const delays = o.restartDelaysMs ?? [5_000, 10_000, 30_000, 60_000, 120_000];
  const stableMs = o.stableMs ?? 600_000;
  const checkEveryMs = o.checkEveryMs ?? 300_000;
  const downRepeatMs = o.downRepeatMs ?? 3_600_000;
  const apiMs = o.apiTimeoutMs ?? 1500;
  const reuseMs = o.reuseTimeoutMs ?? 8000;
  const checkMs = o.checkTimeoutMs ?? 15_000;
  const say = o.say;

  let stopped = false;
  let own: ChildProcess | null = null;
  let upSince = 0;
  let failures = 0;
  let restartTimer: NodeJS.Timeout | null = null;
  let checkTimer: NodeJS.Timeout | null = null;
  let down: { lastSaid: number } | null = null;

  function spawnNgrok(): void {
    if (stopped || own) return;
    say(`Public link: starting ngrok for ${url} ...`);
    const c = spawn(o.ngrok, ['http', `--url=${url}`, String(o.port), '--log=stdout', '--log-level=warn'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    own = c;
    upSince = Date.now();
    const out = (d: Buffer) => {
      for (const line of String(d).split('\n').filter((l) => l.trim())) say(`[ngrok] ${line}`);
    };
    c.stdout?.on('data', out);
    c.stderr?.on('data', out);
    let ended = false;
    const end = (why: string) => {
      if (ended) return;
      ended = true;
      exited(c, why);
    };
    c.on('error', (e) => end((e as NodeJS.ErrnoException).code || e.message));
    c.on('exit', (code, signal) => end(String(signal ?? code)));
  }

  function exited(c: ChildProcess, why: string): void {
    if (own !== c) return;
    own = null;
    if (stopped) return;
    if (Date.now() - upSince >= stableMs) failures = 0;
    const delay = delays[Math.min(failures, delays.length - 1)];
    failures++;
    say(`Public link: ngrok stopped (${why}). Starting it again in ${delay / 1000} seconds.`);
    restartTimer = setTimeout(() => {
      restartTimer = null;
      if (!stopped) void decide();
    }, delay);
    restartTimer.unref?.();
  }

  /** Reuse a running tunnel for the domain, else start ours. Never a second tunnel. */
  async function decide(): Promise<TunnelStart> {
    const found = await existingTunnel(o.domain, api, apiMs);
    if (found) {
      if (found.port !== o.port) {
        say(`Public link: the ngrok tunnel already running points at ${found.addr}, not port ${o.port}. Stop that ngrok and start again.`);
        return 'other-port';
      }
      say(`Public link: reusing the ngrok tunnel that is already running (${url}).`);
      return 'reused';
    }
    const p = await probe(base, reuseMs);
    if (p.status !== 0 && !p.offline) {
      say(`Public link: reusing the ngrok tunnel that is already running (${url}).`);
      return 'reused';
    }
    if (stopped) return 'started';
    spawnNgrok();
    return 'started';
  }

  async function check(): Promise<Probe> {
    const p = await probe(base, checkMs);
    if (stopped) return p;
    if (p.ok) {
      if (down) say(`Public link works again: ${url}`);
      down = null;
      return p;
    }
    const now = Date.now();
    if (!down || now - down.lastSaid >= downRepeatMs) {
      down = { lastSaid: now };
      say(`Public link is DOWN: ${url} did not answer (${p.reason}). Students cannot open it.`);
    }
    // Nothing serves the domain: start ours, unless ours is running or about to restart, or ngrok lists one.
    if ((p.offline || p.status === 0) && !own && !restartTimer) {
      const found = await existingTunnel(o.domain, api, apiMs);
      if (!found && !stopped && !own && !restartTimer) spawnNgrok();
    }
    return p;
  }

  function schedule(ms: number): void {
    if (stopped) return;
    checkTimer = setTimeout(async () => {
      checkTimer = null;
      try {
        await check();
      } catch {
        /* a check never stops the checking */
      }
      schedule(checkEveryMs);
    }, ms);
    checkTimer.unref?.();
  }

  const ready = decide();
  schedule(o.firstCheckMs ?? 30_000);

  return {
    ready,
    check,
    child: () => own,
    stop() {
      stopped = true;
      if (restartTimer) clearTimeout(restartTimer);
      if (checkTimer) clearTimeout(checkTimer);
      restartTimer = checkTimer = null;
      const c = own;
      if (c && c.exitCode === null && c.signalCode === null) c.kill('SIGTERM');
    },
  };
}
