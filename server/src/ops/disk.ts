import fs from 'node:fs';
import path from 'node:path';
import type { Config } from '../config.js';
import type { Ctx } from '../context.js';
import { bad } from '../lib/http.js';
import { LocalDrive } from '../drive/local.js';
import { COPIES_FOLDER } from '../media/copies.js';
import { NEEDS_COPIES, rebuildRunning } from '../media/rebuild.js';

/**
 * The disk that holds server/data (feature D, contract: bigger-contract.md). Owner: server-admin. It holds the
 * database, backups, the photo cache and temp files only: photos and videos are in OneDrive.
 * diskSpace and assertRoomForUploads are used by the upload routes (public.ts and admin.ts) and by alerts.
 */

export interface DiskSpace {
  /** The folder measured (cfg.dataDir). */
  path: string;
  /** Bytes free for this server's user, and the disk's size. */
  free: number;
  total: number;
}

/**
 * What Settings > Storage shows (GET /api/admin/storage). Bytes. Photos and videos live in OneDrive (the originals,
 * and the app's own copies in "_app copies (do not edit)"); the computer the app runs on keeps the database, backups,
 * the photo cache and temp files.
 */
export interface StorageReport {
  /** What the console calls that computer: 'Mac' or 'server' (cfg.machine). */
  machine: Config['machine'];
  /** The address the app is reached at (PUBLIC_URL's host), to say which server. */
  host: string;
  /** The disk holding server/data. */
  disk: DiskSpace;
  server: {
    /** data/tmp: uploads and downloads in progress, files of one job. */
    temp: number;
    /** data/media, data/full, data/people: copies from before photos lived only in OneDrive (0 once moved). */
    legacy_copies: number;
    /** BACKUP_DIR: the database dumps (0 when backups are off). */
    backups: number;
    /** pg_database_size of the app's database. */
    database: number;
    /** data/cache: thumbnails and main-view copies kept for speed (IMG_CACHE_MB). */
    cache: number;
  };
  onedrive: {
    connected: boolean;
    quota: { total: number; used: number; remaining: number } | null;
    /** The size of the app's copies folder in OneDrive (null when it could not be read). */
    copies: number | null;
  };
  copies: {
    /** Photos and videos whose copies are being made in OneDrive (rebuild job). */
    waiting: number;
    /** Ones whose copies cannot be made (their original is gone): not shown to students. */
    lost: number;
    running: boolean;
    last_error: string | null;
    /** Nothing of the album is kept on the server any more. */
    local_done: boolean;
  };
  /** The photo cache's limit (IMG_CACHE_MB; 0 = off). */
  cache_max: number;
  /** Uploads are refused below this (TEMP_MIN_FREE_GB). */
  min_free_upload: number;
  /** The alert levels (ALERT_DISK_WARN_GB, ALERT_DISK_CRITICAL_GB). */
  warn_below: number;
  critical_below: number;
  backups_on: boolean;
}

type Probe = (dir: string) => Promise<{ free: number; total: number }>;

const realProbe: Probe = async (dir) => {
  const s = await fs.promises.statfs(dir);
  return { free: Number(s.bavail) * Number(s.bsize), total: Number(s.blocks) * Number(s.bsize) };
};
let probe: Probe = realProbe;

/** Tests: pretend the disk has this much free (null = measure the real disk again). */
export function setDiskProbe(fn: Probe | null): void {
  probe = fn ?? realProbe;
}

/** Free and total bytes of the disk holding cfg.dataDir. A disk that cannot be read counts as unlimited (never blocks). */
export async function diskSpace(cfg: Pick<Config, 'dataDir'>): Promise<DiskSpace> {
  try {
    fs.mkdirSync(cfg.dataDir, { recursive: true });
    const { free, total } = await probe(cfg.dataDir);
    return { path: cfg.dataDir, free, total };
  } catch {
    return { path: cfg.dataDir, free: Infinity, total: Infinity };
  }
}

/** The messages an upload refused for disk space gets (HTTP 507, error code disk_full). */
export const DISK_FULL_STUDENT = 'The server is nearly full, so photos cannot be added right now. Try again later.';
/** For organisers: what is short, and what to do about it on a Mac or on a server. */
export function diskFullOrganiser(machine: Config['machine'], need: number): string {
  const fix = machine === 'Mac' ? 'free some space on the Mac' : 'give the server a bigger disk, or free some space on it';
  return `This ${machine} has less than ${gbWords(need)} free for temporary files, so uploads are paused. Photos and videos are kept in OneDrive; ${fix} (Settings, Storage).`;
}

/** "1 GB", "1.5 GB". */
const gbWords = (bytes: number) => {
  const g = Math.round((bytes / 1024 ** 3) * 10) / 10;
  return `${Number.isInteger(g) ? g : g.toFixed(1)} GB`;
};

/**
 * Refuse an upload while the server has too little room for its temporary files: throws HttpError 507 'disk_full'.
 * A photo is handled in memory and needs TEMP_MIN_FREE_GB free; a video is on disk while it is read and its preview
 * and clean copy are made, so it needs about 2.3 times its size (`bytes`, from Content-Length, or the route's
 * largest) on top. `who` picks the message. Call it before any of the body is read where the route allows it.
 */
export async function assertRoomForUploads(
  cfg: Pick<Config, 'dataDir' | 'uploadMinFreeBytes' | 'machine'>,
  who: 'student' | 'organiser',
  opts: { video?: boolean; bytes?: number } = {},
): Promise<void> {
  const { free } = await diskSpace(cfg);
  const need = opts.video ? Math.max(0, opts.bytes ?? 0) * 2.3 + cfg.uploadMinFreeBytes : cfg.uploadMinFreeBytes;
  if (free < need) {
    const msg = who === 'student' ? DISK_FULL_STUDENT : diskFullOrganiser(cfg.machine, need);
    throw bad(507, 'disk_full', msg);
  }
}

/** Bytes of every file under a folder (symbolic links are not followed). 0 when it is not there. */
export async function folderSize(dir: string): Promise<number> {
  let total = 0;
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const d of entries) {
    const abs = path.join(dir, d.name);
    if (d.isDirectory()) total += await folderSize(abs);
    else if (d.isFile()) {
      try {
        total += (await fs.promises.stat(abs)).size;
      } catch {
        /* gone while we looked */
      }
    }
  }
  return total;
}

/** The size of the copies folder in OneDrive (Graph gives a folder's size with everything in it): cached 10 minutes. */
let copiesSize: { at: number; n: number | null; key: string } | null = null;
async function oneDriveCopiesSize(ctx: Ctx): Promise<number | null> {
  const key = `${ctx.cfg.redisPrefix}${ctx.drive.kind}`;
  if (copiesSize && copiesSize.key === key && Date.now() - copiesSize.at < 10 * 60_000) return copiesSize.n;
  let n: number | null = null;
  try {
    const root = (await ctx.drive.children(null)).find((e) => e.isFolder && e.name.toLowerCase() === COPIES_FOLDER.toLowerCase());
    if (!root) n = 0;
    else if (ctx.drive.kind === 'graph') n = root.size;
    else n = ctx.drive instanceof LocalDrive ? await folderSize(ctx.drive.pathOf(root.id)) : null;
  } catch {
    n = null;
  }
  copiesSize = { at: Date.now(), n, key };
  return n;
}

/** "stmarys-event-scanner.supercxo.ai" from PUBLIC_URL; empty when it is not a URL. */
const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
};

/** Settings > Storage: the server (database, backups, photo cache, temp files) and OneDrive (originals and the app's copies). */
export async function storageReport(ctx: Ctx): Promise<StorageReport> {
  const { cfg } = ctx;
  const [disk, temp, cache, legacyMedia, legacyFull, legacyPeople, backups, database, status, copiesBytes, counts, local] = await Promise.all([
    diskSpace(cfg),
    folderSize(path.join(cfg.dataDir, 'tmp')),
    folderSize(path.join(cfg.dataDir, 'cache')),
    folderSize(path.join(cfg.dataDir, 'media')),
    folderSize(path.join(cfg.dataDir, 'full')),
    folderSize(path.join(cfg.dataDir, 'people')),
    cfg.backupDir ? folderSize(cfg.backupDir) : Promise.resolve(0),
    ctx.db.query<{ n: string }>(`select pg_database_size(current_database())::text as n`).then((r) => Number(r.rows[0].n)),
    ctx.drive.status().catch(() => null),
    oneDriveCopiesSize(ctx),
    ctx.db
      .query<{ waiting: number; lost: number; last_error: string | null }>(
        `select count(*) filter (where ${NEEDS_COPIES})::int as waiting,
                count(*) filter (where copies_lost)::int as lost,
                (array_agg(copies_error order by processed_at desc nulls last) filter (where copies_error is not null))[1] as last_error
           from media m join events e on e.id = m.event_id`,
      )
      .then((r) => r.rows[0]),
    ctx.db.query(`select 1 from app_state where key = 'copies_local_done'`).then((r) => r.rows.length > 0),
  ]);
  // A disk that could not be measured is sent as 0 (JSON has no Infinity).
  const finite = (n: number) => (Number.isFinite(n) ? n : 0);
  return {
    machine: cfg.machine,
    host: hostOf(cfg.publicUrl),
    disk: { path: disk.path, free: finite(disk.free), total: finite(disk.total) },
    server: { temp, legacy_copies: legacyMedia + legacyFull + legacyPeople, backups, database, cache },
    onedrive: { connected: !!status?.connected, quota: status?.quota ?? null, copies: copiesBytes },
    copies: { waiting: counts.waiting, lost: counts.lost, running: rebuildRunning(ctx), last_error: counts.last_error, local_done: local },
    cache_max: cfg.viewCacheBytes,
    min_free_upload: cfg.uploadMinFreeBytes,
    warn_below: cfg.alerts.diskWarnBytes,
    critical_below: cfg.alerts.diskCriticalBytes,
    backups_on: !!cfg.backupDir,
  };
}
