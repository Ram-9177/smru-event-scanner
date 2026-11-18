import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** backups/ at the top of the project (next to server/ and web/): outside data/, so starting over never removes them. */
const DEFAULT_BACKUP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../backups');

/** Everything the server can be told from outside. One place, so nothing reads process.env elsewhere. */
export interface Config {
  port: number;
  /** Address to listen on. Empty = every address (a server). 127.0.0.1 = only this computer (the one-step start). */
  host: string;
  /**
   * Which proxies may tell the app the visitor's address and https (X-Forwarded-For / -Proto), as Express's
   * 'trust proxy'. Default 'loopback': only a proxy on this computer (Caddy, nginx). Anyone else who reaches the
   * port directly cannot pick their own address. TRUST_PROXY=10.0.0.5 (addresses, comma-separated), a number
   * of hops, or true/false.
   */
  trustProxy: boolean | number | string;
  /** The one permanent address, for the QR and for links (https://NGROK_DOMAIN when that is set, else PUBLIC_URL). */
  publicUrl: string;
  /** Folder for temp files, keys and (in demo mode) the stand-in drive. No photo or video is kept here: they live in OneDrive. */
  dataDir: string;
  /** What the console calls the computer the app runs on ("Free up space on the Mac"): 'Mac' on macOS, else 'server'. */
  machine: 'Mac' | 'server';
  /** PostgreSQL 16 connection string. */
  databaseUrl: string;
  /** Redis 7: sign-in limits, signed-out tokens, one-time links. */
  redisUrl: string;
  /** Every Redis key starts with this, so one Redis can serve several apps (and every test file its own). */
  redisPrefix: string;
  /** Signs image links (HMAC); also the key for the stored Microsoft sign-in. */
  sessionSecret: string;
  /** RS256 key pair for the sign-in tokens (JWT), as PEM. Empty: made once and kept in dataDir. */
  jwtPrivateKey: string;
  jwtPublicKey: string;
  /** Outgoing email (Nodemailer). Empty smtpUrl: messages are written to dataDir/outbox instead of sent. */
  smtpUrl: string;
  mailFrom: string;
  /** Organisers can sign in with their Microsoft account (OpenID Connect), with the same Entra app as OneDrive. */
  sso: { enabled: boolean; redirectUri: string };
  isProd: boolean;

  /** 'graph' = OneDrive through Microsoft Graph. 'local' = a folder on this machine that stands in for OneDrive. */
  drive: 'local' | 'graph';
  localDriveDir: string;
  ms: {
    tenantId: string;
    clientId: string;
    clientSecret: string;
    redirectUri: string;
    /** Delegated permissions asked for at sign-in. */
    scope: string;
    /** 'approot' = Apps > Event Photos (app-folder permission). 'folder' = the folder rootFolderName: a top-level name, or a path like "Photos/Event Photos". */
    root: 'approot' | 'folder';
    rootFolderName: string;
    /** A sharing link to a folder ("Copy link" in OneDrive). Set: the app works in that folder, wherever it lives,
     *  with any account it is shared with (needs Files.ReadWrite.All). Empty: rootFolderName in the account's own OneDrive. */
    rootLink: string;
    graphBase: string;
    loginBase: string;
  };

  /** The face models (YuNet, SFace) for the face engine that runs inside the server. */
  faceModelsDir: string;
  /** Worker threads for face work. */
  faceWorkers: number;
  faceModel: string;

  /** First admin, created on first start if no user exists. */
  adminEmail: string;
  adminPassword: string;
  orgName: string;
  /** The campuses made on the first start (later changed in Settings): CAMPUSES=Hyderabad,Chebrolu,Budampadu */
  campuses: string[];
  /** Who students can ask about their data or a photo, shown on the My data page: "IT Help Desk, helpdesk@college.edu". */
  contact: string;

  syncIntervalMin: number;
  /** How many photos are processed at the same time. */
  workers: number;

  workMaxPx: number;
  webMaxPx: number;
  thumbMaxPx: number;
  minFacePx: number;
  faceSure: number;
  faceMaybe: number;
  dupBits: number;
  /** Find the same shot taken twice (burst shots) and show only the best one. */
  burstDuplicates: boolean;

  uploadMaxBytes: number;
  /** Largest photo an organiser can send from the admin console (cameras make bigger files than phones). */
  adminUploadMaxBytes: number;
  /** Largest video an organiser can send from the admin console (streamed to disk, never held in memory). */
  adminVideoMaxBytes: number;
  /** Largest video a student can send from a phone. */
  uploadVideoMaxBytes: number;
  uploadsPerPhone: number;
  /** ffmpeg and ffprobe, for videos (poster frame, the preview every browser plays, frames for faces). */
  ffmpegPath: string;
  ffprobePath: string;
  /** Longest video taken in, in minutes (VIDEO_MAX_MINUTES): a longer one is refused, so one file cannot hold the video line for hours. */
  videoMaxMinutes: number;
  searchesPer10Min: number;
  searchesPerDay: number;
  /** Selfie searches from one network address in ten minutes, whatever the phone (SEARCHES_PER_IP_10_MIN; 0 = no limit). */
  searchesPerIp10Min: number;
  imageLinkMinutes: number;
  /** Room in OneDrive (the app's copies folder) for full-quality download copies kept for the next student who asks (FULL_COPIES_GB, default 50; FULL_COPIES_MB still read). */
  fullCopiesBytes: number;
  /** OneDrive copies: how long a download link is taken to work when it does not say (DRIVE_URL_LIFE_MIN, 55). */
  driveUrlLifeMin: number;
  /** A link is handed out only while at least this many minutes of it are left (DRIVE_URL_MARGIN_MIN, 20). */
  driveUrlMarginMin: number;
  /** How long a browser keeps the album's redirect to a OneDrive copy, in seconds (IMG_REDIRECT_MAX_AGE, 300). */
  imgRedirectMaxAge: number;
  /** Copies streamed through this server at the same moment (PIPES_AT_ONCE, 16). */
  pipesAtOnce: number;
  /** Thumbnails and main-view copies kept on this server for speed, at most this many bytes (IMG_CACHE_MB, 300; 0 = off). Everything else lives only in OneDrive. */
  viewCacheBytes: number;
  /** Album copies rebuilt from the originals at the same moment (REBUILD_AT_ONCE, 2) and per minute (REBUILD_PER_MIN, 60). */
  rebuildAtOnce: number;
  rebuildPerMin: number;
  /** Scene descriptions held in memory while same shots are compared (SCENE_CACHE_MB, 256). */
  sceneCacheBytes: number;
  /** A photo handed to a student is cleaned in memory up to this size (HANDOVER_MAX_MB, 80); a larger one through a temp file. */
  handoverMaxBytes: number;
  /** Keep a location-free copy of each video in OneDrive for downloads (CLEAN_VIDEO_COPIES, on). */
  cleanVideoCopies: boolean;
  /** How the album's videos reach the browser: 'redirect' to OneDrive (default) or 'pipe' through this server (VIDEO_VIA). */
  videoVia: 'redirect' | 'pipe';
  /** Where the database is dumped (BACKUP_DIR). Empty = no automatic backups (BACKUP_DIR=off). */
  backupDir: string;
  /** How many of those dumps are kept (BACKUP_KEEP), and hours between them (BACKUP_EVERY_HOURS). */
  backupKeep: number;
  backupEveryHours: number;
  /** pg_dump to use (PG_DUMP). Empty: looked for where PostgreSQL is usually installed. */
  pgDumpPath: string;

  /**
   * The fixed ngrok domain (NGROK_DOMAIN, e.g. galleried-warless-petronila.ngrok-free.dev, without https://). Empty =
   * none. When set, the one link (publicUrl, the QR and the share kit) is https://NGROK_DOMAIN, whatever PUBLIC_URL says.
   * scripts/start.ts runs the tunnel to it (PUBLIC_TUNNEL=off: it does not).
   */
  ngrokDomain: string;

  /** Keep me updated: Web Push keys (VAPID). Empty: a pair is made once and kept in DATA_DIR/vapid.json. */
  vapid: { publicKey: string; privateKey: string; subject: string };
  /** Keep me updated is offered to students (KEEP_UPDATED=off hides it and stops matching new photos). */
  keepUpdated: boolean;

  /** Alerts for the organisers (server/src/alerts). */
  alerts: {
    /** Minutes between checks (ALERTS_EVERY_MIN). */
    everyMin: number;
    /** The morning summary is sent from this hour, server time (ALERT_DIGEST_HOUR, 0-23; -1 = no summary). */
    digestHour: number;
    /**
     * Free space on the server below this many bytes: a warning in the console (ALERT_DISK_WARN_GB). 0, the default, is
     * off: the server holds only backups, a photo cache and uploads on their way to OneDrive, so the console says
     * nothing about its disk until uploads have to stop (below uploadMinFreeBytes).
     */
    diskWarnBytes: number;
    /** Free space below this many bytes: critical (ALERT_DISK_CRITICAL_GB; 0, the default, is off). */
    diskCriticalBytes: number;
    /** The newest backup older than this many hours: an alert (ALERT_BACKUP_MAX_AGE_HOURS, default 48). */
    backupMaxAgeHours: number;
    /** Warn this many days before the OneDrive client secret (or sign-in) runs out (ALERT_EXPIRY_DAYS, default 14). */
    expiryWarnDays: number;
  };
  /** When the OneDrive client secret runs out (MS_CLIENT_SECRET_EXPIRES=YYYY-MM-DD, from Entra). Empty = not known. */
  msClientSecretExpires: string;
  /** Uploads (students' and organisers') are refused while the server has less free than this for temporary files (TEMP_MIN_FREE_GB, the older UPLOAD_MIN_FREE_GB still read; default 1). */
  uploadMinFreeBytes: number;
  /** "Delete face data N days after the event" for a new event (FACE_DAYS_DEFAULT, default 90; 0 = unset). */
  faceDaysDefault: number;
  /** Minutes between runs of the close-and-expire job (EXPIRY_EVERY_MIN, default 60). */
  expiryEveryMin: number;
}

const num = (v: string | undefined, d: number) => (v !== undefined && v !== '' && !Number.isNaN(Number(v)) ? Number(v) : d);

/** TRUST_PROXY: empty = 'loopback'; true/false; a whole number = that many proxies; else addresses or names Express knows. */
export function trustProxyFrom(v: string | undefined): boolean | number | string {
  const s = (v ?? '').trim();
  if (!s) return 'loopback';
  if (/^(true|yes|on)$/i.test(s)) return true;
  if (/^(false|no|off)$/i.test(s)) return false;
  if (/^\d+$/.test(s)) return Number(s);
  return s;
}

/** NGROK_DOMAIN as a bare host name: "https://x.ngrok-free.dev/" -> "x.ngrok-free.dev". Empty when not set. */
export function ngrokDomainFrom(v: string | undefined): string {
  return (v ?? '').trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '').toLowerCase();
}

/** The one link: https://NGROK_DOMAIN when that is set (the fixed tunnel); otherwise PUBLIC_URL, or http://localhost:<port>. */
export function publicUrlFrom(env: NodeJS.ProcessEnv, port: number): string {
  const ngrok = ngrokDomainFrom(env.NGROK_DOMAIN);
  if (ngrok) return `https://${ngrok}`;
  return (env.PUBLIC_URL || '').trim().replace(/\/+$/, '') || `http://localhost:${port}`;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, overrides: Partial<Config> = {}): Config {
  const dataDir = path.resolve(env.DATA_DIR || './data');
  const port = num(env.PORT, 3000);
  const publicUrl = publicUrlFrom(env, port);
  const gb = (v: string | undefined, d: number) => Math.round(num(v, d) * 1024 ** 3);
  const isProd = env.NODE_ENV === 'production';
  const cfg: Config = {
    port,
    host: env.HOST || '',
    trustProxy: trustProxyFrom(env.TRUST_PROXY),
    publicUrl,
    dataDir,
    machine: process.platform === 'darwin' ? 'Mac' : 'server',
    databaseUrl: env.DATABASE_URL || 'postgres://localhost:5432/event_photos',
    redisUrl: env.REDIS_URL || 'redis://127.0.0.1:6379',
    redisPrefix: env.REDIS_PREFIX || 'ep:',
    sessionSecret: env.SESSION_SECRET || '',
    jwtPrivateKey: (env.JWT_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    jwtPublicKey: (env.JWT_PUBLIC_KEY || '').replace(/\\n/g, '\n'),
    smtpUrl: env.SMTP_URL || '',
    mailFrom: env.MAIL_FROM || `Event Photos <no-reply@${new URL(publicUrl).hostname}>`,
    sso: {
      enabled: !/^(0|false|off|no)$/i.test(env.MS_SSO ?? '') && !!(env.MS_TENANT_ID && env.MS_CLIENT_ID && env.MS_CLIENT_SECRET),
      // The OneDrive callback address is already registered in Entra, so sign-in comes back there too by default.
      redirectUri: env.MS_SSO_REDIRECT_URI || env.MS_REDIRECT_URI || `${publicUrl}/admin/onedrive/callback`,
    },
    isProd,
    // OneDrive is used when DRIVE=graph, or when the three Microsoft values are filled in and DRIVE is not set.
    drive: env.DRIVE === 'graph' || (!env.DRIVE && !!(env.MS_TENANT_ID && env.MS_CLIENT_ID && env.MS_CLIENT_SECRET)) ? 'graph' : 'local',
    localDriveDir: path.resolve(env.LOCAL_DRIVE_DIR || path.join(dataDir, 'drive')),
    ms: {
      tenantId: env.MS_TENANT_ID || '',
      clientId: env.MS_CLIENT_ID || '',
      clientSecret: env.MS_CLIENT_SECRET || '',
      redirectUri: env.MS_REDIRECT_URI || `${publicUrl}/admin/onedrive/callback`,
      scope:
        env.MS_SCOPE ||
        (env.MS_ROOT_LINK ? 'offline_access User.Read Files.ReadWrite.All' : env.MS_ROOT === 'folder' ? 'offline_access User.Read Files.ReadWrite' : 'offline_access User.Read Files.ReadWrite.AppFolder'),
      root: env.MS_ROOT === 'folder' || env.MS_ROOT_LINK ? 'folder' : 'approot',
      rootFolderName: env.MS_ROOT_FOLDER || 'Event Photos',
      rootLink: (env.MS_ROOT_LINK || '').trim(),
      graphBase: (env.MS_GRAPH_BASE || 'https://graph.microsoft.com/v1.0').replace(/\/+$/, ''),
      loginBase: (env.MS_LOGIN_BASE || 'https://login.microsoftonline.com').replace(/\/+$/, ''),
    },
    faceModelsDir: path.resolve(env.FACE_MODELS || './models'),
    faceWorkers: num(env.FACE_WORKERS, 2),
    faceModel: env.FACE_MODEL || 'sface_2021dec',
    adminEmail: (env.ADMIN_EMAIL || '').trim().toLowerCase(),
    adminPassword: env.ADMIN_PASSWORD || '',
    orgName: env.ORG_NAME || 'My college',
    campuses: (env.CAMPUSES ?? 'Hyderabad,Chebrolu,Budampadu').split(',').map((c) => c.trim()).filter(Boolean),
    contact: (env.CONTACT || '').trim(),
    syncIntervalMin: num(env.SYNC_INTERVAL_MIN, 10),
    workers: num(env.WORKERS, 3),
    workMaxPx: num(env.WORK_MAX_PX, 4096),
    webMaxPx: num(env.WEB_MAX_PX, 1600), // the album's full-screen copy: sharp on a phone, light; downloads give the full size
    thumbMaxPx: num(env.THUMB_MAX_PX, 400),
    minFacePx: num(env.MIN_FACE_PX, 24),
    faceSure: num(env.FACE_SURE, 0.5),
    faceMaybe: num(env.FACE_MAYBE, 0.4),
    dupBits: num(env.DUP_BITS, 32),
    burstDuplicates: !/^(0|false|off|no)$/i.test(env.BURST_DUPLICATES ?? ''),
    uploadMaxBytes: num(env.UPLOAD_MAX_MB, 20) * 1024 * 1024,
    adminUploadMaxBytes: num(env.ADMIN_UPLOAD_MAX_MB, 60) * 1024 * 1024,
    adminVideoMaxBytes: num(env.ADMIN_VIDEO_MAX_MB, 2048) * 1024 * 1024,
    uploadVideoMaxBytes: num(env.UPLOAD_VIDEO_MAX_MB, 200) * 1024 * 1024,
    uploadsPerPhone: num(env.UPLOADS_PER_PHONE, 60),
    ffmpegPath: env.FFMPEG_PATH || 'ffmpeg',
    ffprobePath: env.FFPROBE_PATH || 'ffprobe',
    videoMaxMinutes: num(env.VIDEO_MAX_MINUTES, 240), // a convocation recording is long; the video line works on one at a time
    searchesPer10Min: num(env.SEARCHES_PER_10_MIN, 5),
    searchesPerDay: num(env.SEARCHES_PER_DAY, 20),
    searchesPerIp10Min: num(env.SEARCHES_PER_IP_10_MIN ?? env.SEARCHES_PER_IP_10MIN, 60), // a whole class on one Wi-Fi
    imageLinkMinutes: num(env.IMAGE_LINK_MINUTES, 60),
    fullCopiesBytes: env.FULL_COPIES_GB ? gb(env.FULL_COPIES_GB, 50) : env.FULL_COPIES_MB ? num(env.FULL_COPIES_MB, 51200) * 1024 * 1024 : 50 * 1024 ** 3,
    driveUrlLifeMin: Math.max(5, num(env.DRIVE_URL_LIFE_MIN, 55)),
    driveUrlMarginMin: Math.max(1, num(env.DRIVE_URL_MARGIN_MIN, 20)),
    imgRedirectMaxAge: Math.max(0, num(env.IMG_REDIRECT_MAX_AGE, 300)),
    pipesAtOnce: Math.max(1, num(env.PIPES_AT_ONCE, 16)),
    viewCacheBytes: Math.max(0, num(env.IMG_CACHE_MB, 300)) * 1024 * 1024,
    rebuildAtOnce: Math.max(1, num(env.REBUILD_AT_ONCE, 2)),
    rebuildPerMin: Math.max(1, num(env.REBUILD_PER_MIN, 60)),
    sceneCacheBytes: Math.max(0, num(env.SCENE_CACHE_MB, 256)) * 1024 * 1024,
    handoverMaxBytes: Math.max(1, num(env.HANDOVER_MAX_MB, 80)) * 1024 * 1024,
    cleanVideoCopies: !/^(0|false|off|no)$/i.test(env.CLEAN_VIDEO_COPIES ?? ''),
    videoVia: /^pipe$/i.test(env.VIDEO_VIA ?? '') ? 'pipe' : 'redirect',
    backupDir: env.BACKUP_DIR === undefined ? DEFAULT_BACKUP_DIR : /^(off|no|false)?$/i.test(env.BACKUP_DIR.trim()) ? '' : path.resolve(env.BACKUP_DIR.trim()),
    backupKeep: Math.max(1, num(env.BACKUP_KEEP, 14)),
    backupEveryHours: num(env.BACKUP_EVERY_HOURS, 24) > 0 ? num(env.BACKUP_EVERY_HOURS, 24) : 24,
    pgDumpPath: (env.PG_DUMP || '').trim(),
    ngrokDomain: ngrokDomainFrom(env.NGROK_DOMAIN),
    vapid: {
      publicKey: (env.VAPID_PUBLIC_KEY || '').trim(),
      privateKey: (env.VAPID_PRIVATE_KEY || '').trim(),
      // Push services want a way to reach whoever sends: an https address or a mailto:.
      subject: (env.VAPID_SUBJECT || '').trim() || (publicUrl.startsWith('https://') ? publicUrl : 'mailto:no-reply@localhost'),
    },
    keepUpdated: !/^(0|false|off|no)$/i.test(env.KEEP_UPDATED ?? ''),
    alerts: {
      everyMin: Math.max(1, num(env.ALERTS_EVERY_MIN, 5)),
      digestHour: Math.min(23, Math.max(-1, Math.floor(num(env.ALERT_DIGEST_HOUR, 9)))),
      diskWarnBytes: gb(env.ALERT_DISK_WARN_GB, 0),
      diskCriticalBytes: gb(env.ALERT_DISK_CRITICAL_GB, 0),
      backupMaxAgeHours: Math.max(1, num(env.ALERT_BACKUP_MAX_AGE_HOURS, 48)),
      expiryWarnDays: Math.max(1, num(env.ALERT_EXPIRY_DAYS, 14)),
    },
    msClientSecretExpires: /^\d{4}-\d{2}-\d{2}$/.test((env.MS_CLIENT_SECRET_EXPIRES || '').trim()) ? env.MS_CLIENT_SECRET_EXPIRES!.trim() : '',
    uploadMinFreeBytes: gb(env.TEMP_MIN_FREE_GB ?? env.UPLOAD_MIN_FREE_GB, 1),
    faceDaysDefault: Math.max(0, Math.floor(num(env.FACE_DAYS_DEFAULT, 90))),
    expiryEveryMin: Math.max(1, num(env.EXPIRY_EVERY_MIN, 60)),
    ...overrides,
  };
  if (cfg.isProd && cfg.sessionSecret.length < 32) {
    throw new Error('SESSION_SECRET must be set to at least 32 characters in production.');
  }
  if (cfg.drive === 'graph' && !(cfg.ms.tenantId && cfg.ms.clientId && cfg.ms.clientSecret)) {
    throw new Error('DRIVE=graph needs MS_TENANT_ID, MS_CLIENT_ID and MS_CLIENT_SECRET.');
  }
  return cfg;
}
