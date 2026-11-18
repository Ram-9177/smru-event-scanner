import { createHmac, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { Drive, DriveEntry, DriveRead, DriveStatus } from './types.js';
import { DriveNotFoundError, DriveTooLargeError, mimeFromName, streamToBuffer } from './types.js';

/** How long a link to the stand-in drive works (as a OneDrive download link, about an hour). */
export const LOCAL_URL_LIFE_MS = 60 * 60_000;

/** "bytes=0-99", "bytes=100-", "bytes=-50" against a size: the inclusive range, or null when there is none or it is not satisfiable. */
export function parseRange(range: string | null | undefined, size: number): { start: number; end: number } | 'bad' | null {
  if (!range) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  if (!m || (m[1] === '' && m[2] === '')) return null; // several ranges or nonsense: the whole file, as servers do
  let start: number;
  let end: number;
  if (m[1] === '') {
    const n = Number(m[2]);
    if (n === 0) return 'bad';
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start >= size || start > end) return 'bad';
  return { start, end };
}

/** The name itself if it is free in the folder, else "name 1.ext", "name 2.ext" ... (what OneDrive does on "rename"). */
export function freeName(dir: string, name: string): string {
  if (!fs.existsSync(path.join(dir, name))) return path.join(dir, name);
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let n = 1; ; n++) {
    const candidate = path.join(dir, `${base} ${n}${ext}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
}

/**
 * A folder on this machine that stands in for OneDrive.
 * Ids are stable across renames (inode + creation time), like OneDrive item ids.
 */
export class LocalDrive implements Drive {
  kind = 'local' as const;
  private paths = new Map<string, string>();
  private secret: string | null;

  constructor(
    private root: string,
    opts: { secret?: string } = {},
  ) {
    fs.mkdirSync(root, { recursive: true });
    this.secret = opts.secret ?? null;
  }

  /** The key that signs the /_drive links (the app's session secret). Set by createContext. */
  useSigner(secret: string): void {
    this.secret = secret;
  }
  hasSigner(): boolean {
    return !!this.secret;
  }

  private sig(id: string, exp: number): string {
    return createHmac('sha256', this.secret ?? '').update(`drive|${id}|${exp}`).digest('base64url').slice(0, 32);
  }

  /** A link that works for an hour, served by routes/localdrive.ts: the stand-in for OneDrive's pre-authenticated links. */
  signedUrl(id: string, now = Date.now()): { url: string; expiresAt: number } {
    if (!this.secret) throw new Error('The local drive has no signing key.');
    const exp = Math.floor((now + LOCAL_URL_LIFE_MS) / 1000);
    return { url: `/_drive/${encodeURIComponent(id)}?e=${exp}&s=${this.sig(id, exp)}`, expiresAt: exp * 1000 };
  }

  /** True when a /_drive link is ours and has not expired. */
  checkUrl(id: string, exp: string, sig: string, now = Date.now()): boolean {
    if (!this.secret || !/^\d{1,12}$/.test(exp) || Number(exp) * 1000 < now) return false;
    const want = Buffer.from(this.sig(id, Number(exp)));
    const got = Buffer.from(String(sig));
    return want.length === got.length && timingSafeEqual(want, got);
  }

  /** Where an item is on this machine (the /_drive route sends it). Throws DriveNotFoundError. */
  pathOf(id: string): string {
    return this.resolve(id);
  }

  private entry(abs: string): DriveEntry | null {
    let st: fs.BigIntStats;
    try {
      st = fs.statSync(abs, { bigint: true });
    } catch {
      return null;
    }
    const id = `${st.ino}-${st.birthtimeNs / 1_000_000n}`;
    this.paths.set(id, abs);
    const name = path.basename(abs);
    const isFolder = st.isDirectory();
    return {
      id,
      name,
      isFolder,
      size: Number(st.size),
      ctag: `${st.size}:${st.mtimeNs / 1_000_000n}`,
      mime: isFolder ? null : mimeFromName(name),
      modifiedAt: new Date(Number(st.mtimeMs)),
      takenAt: null,
    };
  }

  /** Find the path for an id; rescan the whole root once if we do not know it (or it moved). */
  private resolve(id: string | null): string {
    if (id === null) return this.root;
    const known = this.paths.get(id);
    if (known && this.entry(known)?.id === id) return known;
    this.paths.delete(id);
    const walk = (dir: string): string | null => {
      for (const name of fs.readdirSync(dir)) {
        const abs = path.join(dir, name);
        const e = this.entry(abs);
        if (!e) continue;
        if (e.id === id) return abs;
        if (e.isFolder) {
          const hit = walk(abs);
          if (hit) return hit;
        }
      }
      return null;
    };
    const found = walk(this.root);
    if (!found) throw new DriveNotFoundError();
    return found;
  }

  async status(): Promise<DriveStatus> {
    return { kind: 'local', connected: true, needsReconnect: false, account: 'Local folder (stand-in for OneDrive)', rootName: this.root, quota: null };
  }

  async children(folderId: string | null, _pageSize?: number, opts: { urls?: boolean; patient?: boolean } = {}): Promise<DriveEntry[]> {
    const dir = this.resolve(folderId);
    return fs
      .readdirSync(dir)
      .filter((n) => !n.startsWith('.'))
      .sort()
      .map((n) => this.entry(path.join(dir, n)))
      .filter((e): e is DriveEntry => e !== null)
      .map((e) => (opts.urls && !e.isFolder && this.secret ? this.withUrl(e) : e));
  }

  private withUrl(e: DriveEntry): DriveEntry {
    const { url, expiresAt } = this.signedUrl(e.id);
    return { ...e, url, urlExpiresAt: expiresAt };
  }

  async item(itemId: string): Promise<DriveEntry> {
    const e = this.entry(this.resolve(itemId));
    if (!e) throw new DriveNotFoundError();
    return e.isFolder || !this.secret ? e : this.withUrl(e);
  }

  async read(itemId: string, opts: { url?: string | null; range?: string | null; signal?: AbortSignal } = {}): Promise<DriveRead> {
    opts.signal?.throwIfAborted();
    const abs = this.resolve(itemId);
    const st = await fs.promises.stat(abs).catch(() => null);
    if (!st || !st.isFile()) throw new DriveNotFoundError();
    const r = parseRange(opts.range, st.size);
    if (r === 'bad') throw new Error('The range asked for is outside the file.');
    const stream = fs.createReadStream(abs, r ? { start: r.start, end: r.end } : {});
    if (opts.signal) opts.signal.addEventListener('abort', () => stream.destroy(), { once: true });
    return {
      status: r ? 206 : 200,
      size: r ? r.end - r.start + 1 : st.size,
      contentRange: r ? `bytes ${r.start}-${r.end}/${st.size}` : null,
      mime: mimeFromName(abs),
      body: Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>,
    };
  }

  async readAll(itemId: string, maxBytes: number, signal?: AbortSignal): Promise<Buffer> {
    signal?.throwIfAborted();
    const abs = this.resolve(itemId);
    const st = await fs.promises.stat(abs).catch(() => null);
    if (!st || !st.isFile()) throw new DriveNotFoundError();
    if (st.size > maxBytes) throw new DriveTooLargeError(st.size);
    return streamToBuffer((await this.read(itemId, { signal })).body, maxBytes);
  }

  async download(itemId: string, destPath: string, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    try {
      await fs.promises.copyFile(this.resolve(itemId), destPath);
    } catch (e) {
      await fs.promises.rm(destPath, { force: true });
      throw e;
    }
  }

  /** A signed /_drive link (served by this server, as OneDrive's own links are served by Microsoft). */
  async downloadUrl(itemId: string): Promise<string | null> {
    this.resolve(itemId); // DriveNotFoundError when it is not there
    return this.secret ? this.signedUrl(itemId).url : null;
  }

  async createFolder(parentId: string | null, name: string): Promise<DriveEntry> {
    const abs = path.join(this.resolve(parentId), name);
    fs.mkdirSync(abs, { recursive: true });
    return this.entry(abs)!;
  }

  async upload(parentId: string | null, name: string, data: Buffer): Promise<DriveEntry> {
    const abs = path.join(this.resolve(parentId), path.basename(name));
    await fs.promises.writeFile(abs, data);
    return this.entry(abs)!;
  }

  async uploadFile(parentId: string | null, name: string, filePath: string, _mime?: string): Promise<DriveEntry> {
    const to = freeName(this.resolve(parentId), path.basename(name));
    await fs.promises.copyFile(filePath, to, fs.constants.COPYFILE_EXCL);
    return this.entry(to)!;
  }

  async copy(itemId: string, parentId: string | null, name: string): Promise<DriveEntry> {
    const from = this.resolve(itemId);
    const to = freeName(this.resolve(parentId), path.basename(name));
    await fs.promises.cp(from, to, { recursive: true, errorOnExist: true, force: false });
    return this.entry(to)!;
  }

  async rename(itemId: string, name: string): Promise<DriveEntry> {
    const from = this.resolve(itemId);
    const to = path.join(path.dirname(from), path.basename(name));
    await fs.promises.rename(from, to);
    this.paths.set(itemId, to);
    return this.entry(to)!;
  }

  async replace(itemId: string, data: Buffer): Promise<DriveEntry> {
    const abs = this.resolve(itemId);
    await fs.promises.writeFile(abs, data); // same file, new content: the id stays, the content tag changes
    return this.entry(abs)!;
  }

  async renew(): Promise<void> {
    /* a local folder has no sign-in */
  }

  async remove(itemId: string, _opts?: { permanent?: boolean }): Promise<void> {
    let abs: string;
    try {
      abs = this.resolve(itemId);
    } catch {
      return; // already gone
    }
    await fs.promises.rm(abs, { recursive: true, force: true });
    this.paths.delete(itemId);
  }
}
