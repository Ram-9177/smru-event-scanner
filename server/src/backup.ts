import { execFile, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Config } from './config.js';
import type { Ctx } from './context.js';

/**
 * Automatic database backups: pg_dump (custom format) into BACKUP_DIR, a few minutes after start and then every
 * BACKUP_EVERY_HOURS, keeping the newest BACKUP_KEEP. The dump is written under a hidden temporary name and renamed
 * only when pg_dump has finished well, so a file named event_photos-*.dump is always whole. One at a time, at low
 * priority. Only files this job made (event_photos-YYYY-MM-DD-HHMM.dump) are ever removed from the folder.
 * The password is never on pg_dump's command line: the connection goes to it as PGHOST/PGUSER/PGPASSWORD/... .
 * Restore with: pg_restore --clean --if-exists -d <database> <file>
 */

type BackupConfig = Pick<Config, 'databaseUrl' | 'backupDir' | 'backupKeep' | 'pgDumpPath'>;

const FIRST_AFTER_MS = 2 * 60 * 1000;
const MAX_RUN_MS = 2 * 60 * 60 * 1000;
const NAME = /^event_photos-\d{4}-\d{2}-\d{2}-\d{4}\.dump$/;
const PART = /^\.event_photos-\d{4}-\d{2}-\d{2}-\d{4}\.dump\.part$/;

const state: { lastAt: Date | null; lastError: string | null } = { lastAt: null, lastError: null };
let running: { child: ChildProcess | null; tmp: string } | null = null;
let warnedNoPgDump = false;

const pad = (n: number) => String(n).padStart(2, '0');
/** event_photos-2026-11-17-0930.dump, in this server's local time. */
export const backupName = (d: Date) => `event_photos-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.dump`;

/** The PostgreSQL connection as the PG* settings pg_dump reads from its environment (so nothing secret is in argv). */
export function pgEnv(databaseUrl: string): Record<string, string> {
  let u: URL;
  try {
    u = new URL(databaseUrl);
  } catch {
    throw new Error('DATABASE_URL is not a postgres:// address, so it cannot be backed up.');
  }
  if (!/^postgres(ql)?:$/.test(u.protocol)) throw new Error('DATABASE_URL is not a postgres:// address, so it cannot be backed up.');
  const env: Record<string, string> = {};
  const host = u.searchParams.get('host') || decodeURIComponent(u.hostname);
  if (host) env.PGHOST = host.replace(/^\[(.*)\]$/, '$1');
  if (u.port || u.searchParams.get('port')) env.PGPORT = u.port || u.searchParams.get('port')!;
  if (u.username) env.PGUSER = decodeURIComponent(u.username);
  if (u.password) env.PGPASSWORD = decodeURIComponent(u.password);
  const db = decodeURIComponent(u.pathname.replace(/^\//, ''));
  if (db) env.PGDATABASE = db;
  const ssl = u.searchParams.get('sslmode');
  if (ssl) env.PGSSLMODE = ssl;
  return env;
}

const versionOf = (bin: string) =>
  new Promise<number | null>((resolve) => {
    execFile(bin, ['--version'], { timeout: 10_000 }, (err, out) => {
      const m = !err && /(\d+)(?:\.\d+)?/.exec(String(out));
      resolve(m ? Number(m[1]) : null);
    });
  });

/**
 * A pg_dump that can dump this server: PG_DUMP when set, else the usual places for this PostgreSQL version (and newer
 * ones: an older pg_dump refuses a newer server), then plain pg_dump. Null when none of them works.
 */
export async function findPgDump(cfg: Pick<Config, 'pgDumpPath'>, serverMajor: number): Promise<string | null> {
  const majors = [0, 1, 2, 3].map((n) => serverMajor + n);
  const candidates = [
    cfg.pgDumpPath,
    ...majors.flatMap((m) => [
      `/opt/homebrew/opt/postgresql@${m}/bin/pg_dump`,
      `/usr/local/opt/postgresql@${m}/bin/pg_dump`,
      `/Applications/Postgres.app/Contents/Versions/${m}/bin/pg_dump`,
      `/usr/lib/postgresql/${m}/bin/pg_dump`,
      `/usr/pgsql-${m}/bin/pg_dump`,
    ]),
    'pg_dump',
  ].filter(Boolean);
  for (const bin of candidates) {
    if (bin.includes('/') && !fs.existsSync(bin)) continue;
    const v = await versionOf(bin);
    if (v !== null && v >= serverMajor) return bin;
  }
  return null;
}

/** Keep the newest `keep` dumps made by this job; anything else in the folder is left alone. Returns the names removed. */
export function pruneBackups(dir: string, keep: number): string[] {
  const ours = fs.readdirSync(dir).filter((f) => NAME.test(f)).sort().reverse(); // the name sorts by date
  const old = ours.slice(Math.max(1, keep));
  for (const f of old) fs.rmSync(path.join(dir, f), { force: true });
  return old;
}

/**
 * Dump the database now. Returns the file made, or null when a backup is already running. Throws when pg_dump is not
 * found or fails (nothing is left behind then). `schema` limits the dump to one schema (the tests).
 */
export async function backupNow(cfg: BackupConfig, pgDump: string, opts: { schema?: string } = {}): Promise<string | null> {
  if (running) return null;
  const dir = cfg.backupDir;
  const file = path.join(dir, backupName(new Date()));
  const tmp = path.join(dir, `.${path.basename(file)}.part`);
  running = { child: null, tmp };
  try {
    // The dumps hold names, emails and password hashes: only this server's user may read them.
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    // What a stopped server left half-written (none of them is running: only one backup runs at a time).
    for (const f of fs.readdirSync(dir)) if (PART.test(f)) fs.rmSync(path.join(dir, f), { force: true });
    const args = ['--format=custom', '--no-owner', '--no-privileges', '--file', tmp, ...(opts.schema ? ['--schema', opts.schema] : [])];
    await new Promise<void>((resolve, reject) => {
      const child = spawn(pgDump, args, { env: { ...process.env, ...pgEnv(cfg.databaseUrl) }, stdio: ['ignore', 'ignore', 'pipe'] });
      running!.child = child;
      // A pg_dump that hangs (a lock it waits for, a lost connection) would stop every later backup: stop it.
      const tooLong = setTimeout(() => child.kill(), MAX_RUN_MS);
      tooLong.unref();
      child.on('close', () => clearTimeout(tooLong));
      try {
        if (child.pid) os.setPriority(child.pid, 10); // a backup never takes the CPU from requests and photo work
      } catch {
        /* not allowed here: it runs at normal priority */
      }
      let err = '';
      child.stderr!.on('data', (d: Buffer) => {
        if (err.length < 4000) err += d.toString();
      });
      child.on('error', reject);
      child.on('close', (code, signal) => {
        if (code === 0) resolve();
        else reject(new Error(err.trim().split('\n').pop() || `pg_dump stopped (${signal ?? `exit ${code}`})`));
      });
    });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, file);
    pruneBackups(dir, cfg.backupKeep);
    return file;
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  } finally {
    running = null;
  }
}

/** For Settings (super admins): where backups go, when the last one was made, and what went wrong with the last try. */
export function backupStatus(cfg: Pick<Config, 'backupDir'>): { dir: string | null; last_at: string | null; last_error: string | null } {
  if (!cfg.backupDir) return { dir: null, last_at: null, last_error: null };
  let last = state.lastAt;
  if (!last) {
    // After a restart: the newest dump in the folder.
    try {
      const newest = fs.readdirSync(cfg.backupDir).filter((f) => NAME.test(f)).sort().pop();
      if (newest) last = fs.statSync(path.join(cfg.backupDir, newest)).mtime;
    } catch {
      /* no folder yet */
    }
  }
  return { dir: cfg.backupDir, last_at: last ? last.toISOString() : null, last_error: state.lastError };
}

/** Tests: pretend the last backup try went this way (alerts read it through backupStatus). */
export function setBackupState(s: { lastAt?: Date | null; lastError?: string | null }): void {
  if (s.lastAt !== undefined) state.lastAt = s.lastAt;
  if (s.lastError !== undefined) state.lastError = s.lastError;
}

/** Start the backups (off when BACKUP_DIR is empty). Returns stop: no more runs, and a running pg_dump is stopped. */
export function startBackups(ctx: Pick<Ctx, 'cfg' | 'db' | 'log'>, firstAfterMs = FIRST_AFTER_MS): () => void {
  const { cfg } = ctx;
  if (!cfg.backupDir) return () => {};
  const run = async () => {
    try {
      const major = Math.floor(Number((await ctx.db.query<{ v: string }>(`select current_setting('server_version_num') as v`)).rows[0].v) / 10000);
      const pgDump = await findPgDump(cfg, major);
      if (!pgDump) {
        state.lastError = 'pg_dump was not found, so the database is not being backed up. Set PG_DUMP to its path.';
        if (!warnedNoPgDump) ctx.log(`backups: pg_dump (PostgreSQL ${major} or newer) was not found. Set PG_DUMP to its path, or BACKUP_DIR=off.`);
        warnedNoPgDump = true;
        return;
      }
      const file = await backupNow(cfg, pgDump);
      if (!file) return;
      state.lastAt = new Date();
      state.lastError = null;
      ctx.log(`backups: database saved to ${file}`);
    } catch (e) {
      state.lastError = (e as Error).message;
      ctx.log(`backups: the database backup failed: ${(e as Error).message}`);
    }
  };
  let every: NodeJS.Timeout | undefined;
  const first = setTimeout(() => {
    void run();
    // setInterval takes at most about 24 days; beyond that Node would run it every millisecond.
    every = setInterval(() => void run(), Math.min(cfg.backupEveryHours * 3600 * 1000, 2 ** 31 - 1));
    every.unref();
  }, firstAfterMs);
  first.unref();
  return () => {
    clearTimeout(first);
    if (every) clearInterval(every);
    if (running) {
      running.child?.kill();
      fs.rmSync(running.tmp, { force: true });
    }
  };
}
