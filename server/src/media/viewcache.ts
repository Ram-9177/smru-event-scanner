/**
 * A small, fast cache on this server for the two copies students look at most: thumbnails (t) and the main view (w).
 * OneDrive stays the only real store; this cache is a speed-up with a hard size cap (IMG_CACHE_MB, default 300).
 * When it is full, the copies looked at least recently are dropped. Originals, videos, download copies and anything
 * else are never kept here. A cached file is only ever sent after the image route's link and visibility checks, so
 * a hidden or removed photo is never served from it; its file simply ages out.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Ctx } from '../context.js';
import { Queue } from '../lib/queue.js';
import { diskSpace } from '../ops/disk.js';
import { extOf, itemOf } from './copies.js';

/** Thumbnails and main-view copies are small; anything larger is not worth a place in the cache. */
const MAX_FILE = 8 * 1024 * 1024;
/** Copies being fetched into the cache at the same moment. */
const FILLS_AT_ONCE = 3;
/**
 * Copies waiting for their turn (an album opening asks for dozens at once: each waits, none is skipped). Past this,
 * a view is still served from OneDrive, just without being queued for the cache.
 */
const MAX_WAITING = 500;

interface Entry {
  file: string;
  size: number;
}

export interface ViewCache {
  /** The cached file for this OneDrive copy, or null (and the copy is fetched into the cache in the background). */
  get(key: string): string | null;
  /** Bytes in the cache now. */
  bytes(): number;
  /** Waits for background fills (tests). */
  idle(): Promise<void>;
  /** Empties the cache. */
  clear(): void;
}

const NAME = /^[A-Za-z0-9!_-]+\.(webp|jpg|jpeg|png)$/;

export function makeViewCache(ctx: Ctx): ViewCache {
  const cap = ctx.cfg.viewCacheBytes;
  const dir = path.join(ctx.cfg.dataDir, 'cache');
  /** Map order = least recently used first. */
  const index = new Map<string, Entry>();
  let total = 0;
  const filling = new Map<string, Promise<void>>();
  const fills = new Queue(FILLS_AT_ONCE);
  let warned = false;

  if (cap > 0 && fs.existsSync(dir)) {
    // Rebuilt from the folder at start, oldest looked at first.
    const found = fs
      .readdirSync(dir)
      .flatMap((n) => {
        const p = path.join(dir, n);
        if (!NAME.test(n)) {
          fs.rmSync(p, { force: true, recursive: true }); // half-written or foreign files never stay
          return [];
        }
        const st = fs.statSync(p);
        return [{ id: n.replace(/\.[^.]+$/, ''), file: p, size: st.size, at: st.atimeMs }];
      })
      .sort((a, b) => a.at - b.at);
    for (const f of found) {
      index.set(f.id, { file: f.file, size: f.size });
      total += f.size;
    }
    trim();
  } else if (cap === 0 && fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  function trim() {
    for (const [id, e] of index) {
      if (total <= cap) break;
      index.delete(id);
      total -= e.size;
      fs.rmSync(e.file, { force: true });
    }
    if (index.size === 0 && fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  }

  async function fill(key: string, id: string) {
    try {
      // The cache never squeezes a nearly full disk: uploads need that room more.
      const free = (await diskSpace(ctx.cfg)).free;
      if (free < ctx.cfg.uploadMinFreeBytes + cap) return;
      const data = await ctx.drive.readAll(id, MAX_FILE, undefined, { patient: false });
      if (!data.length || data.length > cap) return;
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${id}.${extOf(key) || 'webp'}`);
      const part = `${file}.${process.pid}.part`;
      fs.writeFileSync(part, data);
      fs.renameSync(part, file);
      const old = index.get(id);
      if (old) total -= old.size;
      index.set(id, { file, size: data.length });
      total += data.length;
      trim();
    } catch (e) {
      // A copy that cannot be fetched now is simply served from OneDrive; the next view tries again.
      if (!warned) {
        warned = true;
        console.warn(`[event-photos] view cache: could not keep a copy on this server (${(e as Error)?.message ?? e}); photos are served from OneDrive.`);
      }
    }
  }

  return {
    get(key) {
      if (cap <= 0) return null;
      const id = itemOf(key);
      if (!/^[A-Za-z0-9!_-]+$/.test(id)) return null;
      const e = index.get(id);
      if (e) {
        if (fs.existsSync(e.file)) {
          index.delete(id); // most recently used goes to the end
          index.set(id, e);
          return e.file;
        }
        index.delete(id);
        total -= e.size;
      }
      if (!filling.has(id) && filling.size < MAX_WAITING) {
        const p = fills.push(() => fill(key, id)).finally(() => filling.delete(id));
        filling.set(id, p);
      }
      return null;
    },
    bytes: () => total,
    async idle() {
      while (filling.size) await Promise.all([...filling.values()]);
    },
    clear() {
      index.clear();
      total = 0;
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}
