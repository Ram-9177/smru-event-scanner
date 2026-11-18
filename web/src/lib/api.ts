/** One small client for the server's API. Students are known only by a random token their phone keeps. */

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

let memoryToken = '';

export function deviceToken(): string {
  const make = () => {
    const b = new Uint8Array(24);
    crypto.getRandomValues(b);
    return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  };
  try {
    let t = localStorage.getItem('ep.device');
    if (!t) {
      t = make();
      localStorage.setItem('ep.device', t);
    }
    return t;
  } catch {
    // Private mode: the token lives only as long as this tab.
    memoryToken ||= make();
    return memoryToken;
  }
}

export interface ApiOptions {
  method?: string;
  json?: unknown;
  body?: Blob;
  headers?: Record<string, string>;
}

export async function api<T = any>(path: string, opts: ApiOptions = {}): Promise<T> {
  const headers: Record<string, string> = { 'x-device': deviceToken(), ...opts.headers };
  let body: BodyInit | undefined;
  if (opts.json !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(opts.json);
  } else if (opts.body) {
    headers['content-type'] ||= opts.body.type || 'application/octet-stream';
    body = opts.body;
  }
  let res: Response;
  try {
    res = await fetch(`/api${path}`, { method: opts.method ?? (body ? 'POST' : 'GET'), headers, body, credentials: 'same-origin' });
  } catch {
    throw new ApiError(0, 'offline', 'No connection. Check your internet and try again.');
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, data?.error ?? 'error', data?.message ?? 'Something went wrong. Try again.');
  return data as T;
}

/**
 * Sends one file as the raw request body. Small files go through api(); larger ones (videos) through
 * XMLHttpRequest, which reports how much of the file has gone up, so the progress bar moves.
 */
export function uploadFile<T = any>(path: string, file: Blob, opts: { headers?: Record<string, string>; onProgress?: (sent: number, total: number) => void } = {}): Promise<T> {
  const headers: Record<string, string> = { 'content-type': file.type || 'application/octet-stream', ...opts.headers };
  const report = opts.onProgress;
  if (!report || file.size < 4 * 1024 * 1024 || typeof XMLHttpRequest === 'undefined') {
    return api<T>(path, { body: file, headers }).then((out) => (report?.(file.size, file.size), out));
  }
  return new Promise<T>((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open('POST', `/api${path}`);
    x.withCredentials = true;
    for (const [k, v] of Object.entries({ 'x-device': deviceToken(), ...headers })) x.setRequestHeader(k, v);
    x.upload.onprogress = (e) => e.lengthComputable && report(e.loaded, e.total);
    x.onload = () => {
      let data: any = null;
      try {
        data = JSON.parse(x.responseText);
      } catch {
        /* not JSON */
      }
      if (x.status >= 200 && x.status < 300) return resolve(data as T);
      const fallback = x.status === 413 ? 'This file is too large.' : 'Something went wrong. Try again.';
      reject(new ApiError(x.status, data?.error ?? 'error', data?.message ?? fallback));
    };
    x.onerror = () => reject(new ApiError(0, 'offline', 'No connection. Check your internet and try again.'));
    x.send(file);
  });
}

// ---- shapes the server sends ---------------------------------------------------------
export interface Campus {
  id: string;
  name: string;
  slug: string;
}

export interface EventInfo {
  slug: string;
  title: string;
  starts_on: string | null;
  ends_on: string | null;
  venue: string | null;
  /** Older servers do not send it. */
  campus?: Campus | null;
  state: 'draft' | 'live' | 'closed' | 'archived';
  cover: string | null;
  strip: string[];
  photos: number;
  /** How many photos this phone's last selfie found in the event. */
  mine: number;
  /** Of those, how many Keep me updated added that this phone has not seen yet ("N new"). Older servers do not send it. */
  mine_new?: number;
  /** The event's face data was deleted (expiry): face search is over, the album stays. Older servers do not send it. */
  face_ended?: boolean;
  options: { find: boolean; album: boolean; album_locked: boolean; upload: boolean; download: boolean };
}

/** One photo or video. Videos have a playable mp4 in `video`; `web` is their still frame. */
export interface Photo {
  id: string;
  thumb: string;
  web: string;
  width?: number;
  height?: number;
  taken_at?: string | null;
  by?: string | null;
  type?: 'photo' | 'video';
  duration_ms?: number | null;
  video?: string | null;
  /** How many of the university's main people are in it: alone, with one other, or in a group. */
  kind?: Kind;
  /** A video in your results: where your face is seen in it, in milliseconds (the player starts just before). */
  at_ms?: number | null;
  /** In your results: added by Keep me updated and not seen yet. */
  fresh?: boolean;
}

// ---- Keep me updated and Remove me (bigger-contract.md, features E and F) ----------------------
/** Keep me updated for this phone in this event (in GET /api/e/:slug/mine as `keep`). */
export interface KeepState {
  /** Offered at all (KEEP_UPDATED on, face search not ended). */
  available: boolean;
  /** The student turned it on: their face vector is kept for this event. */
  on: boolean;
  /** This phone has a push subscription for this event. */
  push: boolean;
  /** The consent wording version the phone must send to turn it on (x-keep-consent). */
  consent_version: string;
}

/** The phone's latest removal request in this event (in GET /api/e/:slug/mine as `removal`). */
export interface RemovalState {
  id: string;
  status: 'open' | 'approved' | 'declined';
  /** How many photos it lists. */
  count: number;
  created_at: string;
  resolved_at: string | null;
}

// ---- the console: alerts and storage (features C and D) ----------------------------------------
export type AlertKind =
  | 'sync_failing'
  | 'onedrive_reconnect'
  | 'onedrive_secret'
  | 'onedrive_signin'
  | 'backup_failed'
  | 'backup_old'
  | 'disk_low'
  | 'face_down'
  | 'copies_rebuilding'
  | 'copies_lost'
  | 'onedrive_space_low'
  | 'images_unavailable';

/** One active problem (GET /api/admin/alerts). */
export interface AdminAlert {
  key: string;
  kind: AlertKind;
  severity: 'warn' | 'critical';
  title: string;
  detail: string | null;
  event: { id: string; title: string } | null;
  action: { label: string; to: string } | null;
  started_at: string;
}

/** Settings > Alerts (GET /api/admin/alerts/settings). */
export interface AlertSettings {
  /** An SMTP server is set, so emails really leave. */
  smtp: boolean;
  /** Email alerts for the signed-in super admin. */
  email_alerts: boolean;
  /** Where they go. */
  email: string;
  /** The hour the morning summary is sent (server time), or null when it is off. */
  digest_hour: number | null;
}

/**
 * Settings > Storage (GET /api/admin/storage). Bytes. Three parts, each of which can be on its own account: the
 * database (and its backups), the server (short-lived working files and a small photo cache) and Microsoft OneDrive
 * (every photo and video). The server's disk itself is not reported, only whether uploads must wait for room.
 */
export interface StorageReport {
  /** What to call the computer the app runs on: 'Mac' on macOS, 'server' anywhere else. */
  machine: 'Mac' | 'server';
  /** The address the app is reached at (PUBLIC_URL's host), to name the server. */
  host: string;
  database: { size: number; backups: number; backups_on: boolean };
  /** cache: thumbnails and main-view photos kept for speed, at most cache_max (0 = the cache is off). */
  server: { temp: number; cache: number; cache_max: number; legacy_copies: number; uploads_paused: boolean; min_free_upload: number };
  onedrive: { connected: boolean; quota: { total: number; used: number; remaining: number } | null; copies: number | null };
  copies: { waiting: number; lost: number; running: boolean; last_error: string | null; local_done: boolean };
}

/**
 * An image or video link streamed through the app instead of sent on to OneDrive: for fetch() (share, save) and
 * for opening a copy in a new tab, where a redirect to OneDrive's own address would not work.
 */
export const piped = (url: string) => `${url}${url.includes('?') ? '&' : '?'}pipe=1`;

/** The same link asked for again (a copy being prepared, an expired OneDrive link): only the cache sees a new address. */
export const retried = (url: string, n: number | string) => `${url}${url.includes('?') ? '&' : '?'}r=${n}`;

/** The full-quality original of a photo or video: the server sends the browser on to a fresh OneDrive link. */
export const originalUrl = (slug: string, id: string) => `/api/e/${encodeURIComponent(slug)}/original/${encodeURIComponent(id)}?d=${deviceToken()}`;

export type Kind = 'solo' | 'duo' | 'group';

export const isVideo = (p: Pick<Photo, 'type' | 'video'>) => p.type === 'video' && !!p.video;

/** A video's length the way players show it: 0:42, 3:05, 1:02:10. */
export function clock(ms: number | null | undefined): string {
  if (!ms || ms < 0) return '';
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** File sizes in plain words: 850 KB, 12.4 MB, 1.2 GB. */
export function size(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(bytes < 10 * 1024 ** 2 ? 1 : 0)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

export interface Me {
  album_open: boolean;
  searched: boolean;
  my_photos: number;
  uploads_left: number;
}

export function niceDate(day: string | null): string {
  if (!day) return '';
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

/** Frame numbers the way film counts them: 1, 1A, 2, 2A ... */
export const frameNo = (i: number) => `${Math.floor(i / 2) + 1}${i % 2 ? 'A' : ''}`;
