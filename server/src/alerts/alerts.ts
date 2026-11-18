import { backupStatus } from '../backup.js';
import type { Ctx } from '../context.js';
import { diskSpace } from '../ops/disk.js';
import { downSince } from '../media/copyurls.js';
import { NEEDS_COPIES } from '../media/rebuild.js';
import type { AdminUser } from '../routes/auth.js';
import { alertClearedMail, alertStartedMail, digestMail, testMail, type DigestData } from './emails.js';

/**
 * Alerts for the organisers (feature C, contract: bigger-contract.md). Owner: server-admin.
 *
 * checkAlerts looks at everything that can go wrong, keeps one row per active problem in the alerts table (key = kind,
 * or kind:<event id>), clears what is fixed, and emails the super admins who have alert emails on: when a problem
 * starts (at most once per problem per 12 hours) and when it clears. The morning summary (sendDigest) goes out once a
 * day from cfg.alerts.digestHour, only when uploads wait for approval or requests are open.
 */

export type AlertKind =
  | 'sync_failing' // one event: two syncs in a row failed (events.sync_failures >= 2)
  | 'onedrive_reconnect' // OneDrive needs connecting again (drive status needsReconnect)
  | 'onedrive_secret' // the client secret runs out within cfg.alerts.expiryWarnDays (MS_CLIENT_SECRET_EXPIRES), or has
  | 'onedrive_signin' // the stored Microsoft sign-in was last renewed more than 90 - expiryWarnDays days ago
  | 'backup_failed' // the last backup try failed
  | 'backup_old' // the newest backup is older than cfg.alerts.backupMaxAgeHours
  | 'disk_low' // free disk below cfg.alerts.diskWarnBytes (critical below diskCriticalBytes)
  | 'face_down' // the face engine does not answer
  | 'copies_rebuilding' // more than 50 photos and videos have waited over 30 minutes for their copies in OneDrive
  | 'copies_lost' // one event: photos whose copies cannot be made (their originals are gone from OneDrive)
  | 'onedrive_space_low' // OneDrive has less than 10% free (critical below 3% or 5 GB)
  | 'images_unavailable'; // OneDrive has not given the album's photos for 5 minutes or more

/** Kinds an organiser (not only a super admin) sees in the console. */
export const EVENT_KINDS: readonly AlertKind[] = ['sync_failing', 'face_down', 'copies_lost'];

/** One active problem as GET /api/admin/alerts sends it. */
export interface Alert {
  key: string;
  kind: AlertKind;
  severity: 'warn' | 'critical';
  title: string;
  detail: string | null;
  event: { id: string; title: string } | null;
  /** Where the console's banner button goes, and its words. */
  action: { label: string; to: string } | null;
  started_at: string;
}

/** A problem found by one check, before it is stored. */
export interface Found {
  key: string;
  kind: AlertKind;
  severity: 'warn' | 'critical';
  title: string;
  detail: string | null;
  eventId: string | null;
}

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
/** At most one email about the same problem in this time. */
export const EMAIL_EVERY_MS = 12 * HOUR;
/** Microsoft ends a stored sign-in (refresh token) that is not used for this many days. */
const SIGNIN_DAYS = 90;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "2026-12-03" -> "3 Dec 2026". */
export const niceDay = (ymd: string) => {
  const [y, m, d] = ymd.split('-').map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
};
/** Bytes as GB: one decimal under 10, else whole ("8.4", "23"). */
export const gbText = (bytes: number) => {
  const g = Math.round((bytes / 1024 ** 3) * 10) / 10; // 9.96 GB is "10", not "10.0"
  return g < 10 ? g.toFixed(1) : String(Math.round(g));
};
/** A threshold in GB as people write it ("3", "2.5"). */
const gbLimit = (bytes: number) => {
  const g = bytes / 1024 ** 3;
  return Number.isInteger(Math.round(g * 10) / 10) ? String(Math.round(g)) : g.toFixed(1);
};
const pad = (n: number) => String(n).padStart(2, '0');
/** YYYY-MM-DD of a moment in this server's own time zone. */
export const localDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

const SETTINGS_ONEDRIVE = { label: 'Open OneDrive settings', to: '/admin/settings?tab=onedrive' };

/** The banner's button for a kind (and its event). */
function actionFor(kind: AlertKind, eventId: string | null): Alert['action'] {
  switch (kind) {
    case 'sync_failing':
      return eventId ? { label: 'Open the event', to: `/admin/events/${eventId}?tab=settings` } : null;
    case 'onedrive_reconnect':
    case 'onedrive_signin':
      return SETTINGS_ONEDRIVE;
    case 'disk_low':
    case 'copies_rebuilding':
    case 'onedrive_space_low':
      return { label: 'See storage', to: '/admin/settings?tab=alerts' };
    case 'copies_lost':
      return eventId ? { label: 'Open the Media manager', to: `/admin/events/${eventId}?tab=media&filter=lost` } : null;
    case 'images_unavailable':
      return SETTINGS_ONEDRIVE;
    default:
      return null;
  }
}

// ---- when this server started (for "no backup has been made yet") --------------------------------
let serverStart = Date.now();
/** Tests: pretend the server started at this moment (null = now). */
export function setServerStart(d: Date | null): void {
  serverStart = (d ?? new Date()).getTime();
}

// ---- the checks ---------------------------------------------------------------------------------
/** Since when more than 50 items have waited for their copies (in this process). */
const rebuildingSince = new Map<string, number>();
type Check = { kinds: AlertKind[]; run: (ctx: Ctx, now: Date) => Promise<Found[]> };

const CHECKS: Check[] = [
  {
    kinds: ['sync_failing'],
    async run(ctx) {
      // While OneDrive needs connecting again every sync fails: that one critical alert says it, not one more alert
      // (and email) per event. Alerts already open for an event stay as they are.
      let reconnect = false;
      if (ctx.drive.kind === 'graph') {
        const conn = (await ctx.db.query<{ needs_reconnect: boolean }>(`select needs_reconnect from connections where org_id = $1`, [ctx.orgId])).rows[0];
        reconnect = !!conn?.needs_reconnect;
      }
      const open = reconnect
        ? new Set((await ctx.db.query<{ key: string }>(`select key from alerts where kind = 'sync_failing' and cleared_at is null`)).rows.map((a) => a.key))
        : null;
      const rows = (
        await ctx.db.query<{ id: string; title: string; sync_error: string | null }>(
          `select id, title, sync_error from events
            where org_id = $1 and status in ('draft', 'live') and onedrive_folder_id is not null and sync_failures >= 2
            order by title, id`,
          [ctx.orgId],
        )
      ).rows;
      return rows
        .filter((e) => !open || open.has(`sync_failing:${e.id}`))
        .map((e) => ({
          key: `sync_failing:${e.id}`,
          kind: 'sync_failing' as const,
          severity: 'warn' as const,
          title: `Sync is failing for ${e.title}`,
          detail: e.sync_error || 'The last syncs did not work.',
          eventId: e.id,
        }));
    },
  },
  {
    kinds: ['onedrive_reconnect', 'onedrive_signin'],
    async run(ctx, now) {
      if (ctx.drive.kind !== 'graph') return [];
      const conn = (
        await ctx.db.query<{ needs_reconnect: boolean; has_token: boolean; root_item_id: string | null; used_at: Date }>(
          `select needs_reconnect, (refresh_token is not null) as has_token, root_item_id, coalesce(renewed_at, connected_at) as used_at
             from connections where org_id = $1`,
          [ctx.orgId],
        )
      ).rows[0];
      if (!conn) return [];
      if (conn.needs_reconnect) {
        return [
          {
            key: 'onedrive_reconnect',
            kind: 'onedrive_reconnect',
            severity: 'critical',
            title: 'OneDrive needs connecting again',
            detail: 'New photos are not being read and students cannot add photos. A super admin connects OneDrive again in Settings.',
            eventId: null,
          },
        ];
      }
      if (!conn.has_token || !conn.root_item_id) return [];
      const days = Math.floor((now.getTime() - new Date(conn.used_at).getTime()) / DAY);
      if (days <= SIGNIN_DAYS - ctx.cfg.alerts.expiryWarnDays) return [];
      return [
        {
          key: 'onedrive_signin',
          kind: 'onedrive_signin',
          severity: 'warn',
          title: `The OneDrive sign-in has not been used for ${days} days`,
          detail: 'Microsoft ends it after 90 days without use. Press Sync now on any event to keep it, or connect OneDrive again.',
          eventId: null,
        },
      ];
    },
  },
  {
    kinds: ['onedrive_secret'],
    async run(ctx, now) {
      const ends = ctx.cfg.msClientSecretExpires;
      if (!ends) return [];
      const [y, m, d] = ends.split('-').map(Number);
      const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
      const left = Math.round((new Date(y, m - 1, d).getTime() - today) / DAY);
      if (left > ctx.cfg.alerts.expiryWarnDays) return [];
      const passed = left < 0;
      return [
        {
          key: 'onedrive_secret',
          kind: 'onedrive_secret',
          severity: passed ? 'critical' : 'warn',
          title: passed ? 'The OneDrive client secret has run out' : `The OneDrive client secret runs out on ${niceDay(ends)}`,
          detail:
            'Make a new client secret in Microsoft Entra (Certificates & secrets), put its Value in MS_CLIENT_SECRET in server/.env, set MS_CLIENT_SECRET_EXPIRES to its end date, and restart.',
          eventId: null,
        },
      ];
    },
  },
  {
    kinds: ['backup_failed', 'backup_old'],
    async run(ctx, now) {
      const b = backupStatus(ctx.cfg);
      if (!b.dir) return [];
      if (b.last_error) {
        return [{ key: 'backup_failed', kind: 'backup_failed', severity: 'critical', title: 'The database backup did not work', detail: b.last_error, eventId: null }];
      }
      const maxAge = ctx.cfg.alerts.backupMaxAgeHours * HOUR;
      const detail = `Backups go to ${b.dir}. Check that pg_dump works (PG_DUMP in server/.env).`;
      if (!b.last_at) {
        if (now.getTime() - serverStart < maxAge) return [];
        return [{ key: 'backup_old', kind: 'backup_old', severity: 'warn', title: 'No database backup has been made yet', detail, eventId: null }];
      }
      const age = now.getTime() - new Date(b.last_at).getTime();
      if (age <= maxAge) return [];
      const days = Math.max(1, Math.floor(age / DAY));
      return [{ key: 'backup_old', kind: 'backup_old', severity: 'warn', title: `The last database backup is ${days} days old`, detail, eventId: null }];
    },
  },
  {
    kinds: ['disk_low'],
    async run(ctx) {
      const { free } = await diskSpace(ctx.cfg);
      const { diskWarnBytes, diskCriticalBytes } = ctx.cfg.alerts;
      if (!Number.isFinite(free) || free >= diskWarnBytes) return [];
      const stop = gbLimit(ctx.cfg.uploadMinFreeBytes);
      const critical = free < diskCriticalBytes;
      // Photos and videos are in OneDrive; this disk holds the database, backups, the photo cache and every upload on
      // its way there. A Mac gets its space back by cleaning up; a server more often needs a bigger disk.
      const fix = ctx.cfg.machine === 'Mac' ? 'Free up space on the Mac.' : 'Give the server a bigger disk, or free up space on it.';
      return [
        {
          key: 'disk_low',
          kind: 'disk_low',
          severity: critical ? 'critical' : 'warn',
          title: critical ? `The server is nearly full: ${gbText(free)} GB free` : `Only ${gbText(free)} GB free on the server`,
          detail:
            free < ctx.cfg.uploadMinFreeBytes
              ? `Uploads are paused until there is at least ${stop} GB free. ${fix}`
              : `${fix} Uploads stop below ${stop} GB.`,
          eventId: null,
        },
      ];
    },
  },
  {
    kinds: ['copies_rebuilding'],
    async run(ctx, now) {
      const n = (await ctx.db.query<{ n: number }>(`select count(*)::int as n from media m join events e on e.id = m.event_id where ${NEEDS_COPIES}`)).rows[0].n;
      if (n <= 50) {
        rebuildingSince.delete(ctx.orgId);
        return [];
      }
      const since = rebuildingSince.get(ctx.orgId) ?? now.getTime();
      rebuildingSince.set(ctx.orgId, since);
      if (now.getTime() - since < 30 * 60_000) return [];
      return [
        {
          key: 'copies_rebuilding',
          kind: 'copies_rebuilding',
          severity: 'warn',
          title: `Rebuilding album copies in OneDrive: ${n} left.`,
          detail: 'Students see "being prepared" for these photos until their copies are made from the originals. It carries on by itself while OneDrive answers.',
          eventId: null,
        },
      ];
    },
  },
  {
    kinds: ['copies_lost'],
    async run(ctx) {
      const rows = (
        await ctx.db.query<{ id: string; title: string; n: number }>(
          `select e.id, e.title, count(*)::int as n from media m join events e on e.id = m.event_id
            where e.org_id = $1 and m.copies_lost group by e.id, e.title order by e.title, e.id`,
          [ctx.orgId],
        )
      ).rows;
      return rows.map((e) => ({
        key: `copies_lost:${e.id}`,
        kind: 'copies_lost' as const,
        severity: 'warn' as const,
        title: `${e.n} photo${e.n === 1 ? '' : 's'} of ${e.title} cannot be shown: their originals are no longer in OneDrive.`,
        detail: 'Put the originals back in the event folder and press Try again in the Media manager, or leave them out of the album.',
        eventId: e.id,
      }));
    },
  },
  {
    kinds: ['onedrive_space_low'],
    async run(ctx) {
      const st = await ctx.drive.status();
      const q = st.quota;
      if (!st.connected || !q || !(q.total > 0)) return [];
      const share = q.remaining / q.total;
      if (share >= 0.1) return [];
      const critical = share < 0.03 || q.remaining < 5 * 1024 ** 3;
      return [
        {
          key: 'onedrive_space_low',
          kind: 'onedrive_space_low',
          severity: critical ? 'critical' : 'warn',
          title: `OneDrive is nearly full: ${gbText(q.remaining)} GB free of ${gbText(q.total)} GB`,
          detail: 'Photos, videos and the app\'s copies all live in OneDrive. Free some space there or ask for a higher limit; download copies of videos are not kept while it is this full.',
          eventId: null,
        },
      ];
    },
  },
  {
    kinds: ['images_unavailable'],
    async run(ctx, now) {
      const since = await downSince(ctx);
      if (!since || now.getTime() - since < 5 * 60_000) return [];
      return [
        {
          key: 'images_unavailable',
          kind: 'images_unavailable',
          severity: 'critical',
          title: 'Students cannot see photos: OneDrive is not giving them',
          detail: 'The album shows "Photos can\'t be loaded right now". Check that OneDrive is connected (Settings, OneDrive); it carries on by itself when OneDrive answers.',
          eventId: null,
        },
      ];
    },
  },
  {
    kinds: ['face_down'],
    async run(ctx) {
      let up = false;
      try {
        up = await ctx.face.health();
      } catch {
        up = false;
      }
      if (up) return [];
      return [
        {
          key: 'face_down',
          kind: 'face_down',
          severity: 'critical',
          title: 'Face recognition is not running',
          detail: 'New photos cannot be read and selfies do not work. Restart the app; if this stays, the face model files in server/models are missing.',
          eventId: null,
        },
      ];
    },
  },
];

/** The super admins who get alert emails. */
async function recipients(ctx: Ctx): Promise<string[]> {
  return (await ctx.db.query<{ email: string }>(`select email from users where org_id = $1 and role = 'super_admin' and alert_emails order by email`, [ctx.orgId])).rows.map((u) => u.email);
}

const consoleUrl = (ctx: Ctx) => `${ctx.cfg.publicUrl}/admin`;

/** Send one message to everyone; true when at least one went. */
async function sendAll(ctx: Ctx, to: string[], make: (to: string) => Parameters<Ctx['mailer']['send']>[0]): Promise<boolean> {
  let any = false;
  for (const t of to) if (await ctx.mailer.send(make(t))) any = true;
  return any;
}

async function runChecks(ctx: Ctx, now: Date): Promise<Found[]> {
  const found: Found[] = [];
  const unsure: AlertKind[] = []; // kinds whose check failed this time: their alerts stay as they are
  for (const c of CHECKS) {
    try {
      found.push(...(await c.run(ctx, now)));
    } catch (e) {
      unsure.push(...c.kinds);
      ctx.log(`alerts: a check could not run: ${(e as Error).message}`);
    }
  }

  const due: Found[] = [];
  for (const f of found) {
    const row = (
      await ctx.db.query<{ emailed_at: Date | null }>(
        `insert into alerts (key, kind, severity, event_id, title, detail, started_at, seen_at, cleared_at)
         values ($1, $2, $3, $4, $5, $6, $7, $7, null)
         on conflict (key) do update set kind = excluded.kind, severity = excluded.severity, event_id = excluded.event_id,
           title = excluded.title, detail = excluded.detail, seen_at = excluded.seen_at,
           started_at = case when alerts.cleared_at is null then alerts.started_at else excluded.started_at end,
           cleared_at = null
         returning emailed_at`,
        [f.key, f.kind, f.severity, f.eventId, f.title, f.detail, now],
      )
    ).rows[0];
    if (!row.emailed_at || new Date(row.emailed_at).getTime() < now.getTime() - EMAIL_EVERY_MS) due.push(f);
  }

  const cleared = (
    await ctx.db.query<{ key: string; title: string; emailed_at: Date | null; started_at: Date }>(
      `update alerts set cleared_at = $1
        where cleared_at is null and not (key = any($2::text[])) and not (kind = any($3::text[]))
        returning key, title, emailed_at, started_at`,
      [now, found.map((f) => f.key), unsure],
    )
  ).rows;

  if (ctx.mailer.configured && (due.length || cleared.length)) {
    const to = await recipients(ctx);
    if (to.length) {
      for (const f of due) {
        if (await sendAll(ctx, to, (t) => alertStartedMail(t, f, consoleUrl(ctx)))) {
          await ctx.db.query(`update alerts set emailed_at = $2 where key = $1`, [f.key, now]);
        }
      }
      // "Fixed" only for a problem someone was told about (this time it was open).
      for (const c of cleared) {
        if (c.emailed_at && new Date(c.emailed_at).getTime() >= new Date(c.started_at).getTime()) {
          await sendAll(ctx, to, (t) => alertClearedMail(t, c, consoleUrl(ctx)));
        }
      }
    }
  }
  return found;
}

const runs = new WeakMap<Ctx, { running: Promise<Found[]> | null; finishedAt: number }>();
const runState = (ctx: Ctx) => {
  let s = runs.get(ctx);
  if (!s) runs.set(ctx, (s = { running: null, finishedAt: 0 }));
  return s;
};

/**
 * Look at everything now: store new problems, clear fixed ones, send the emails that are due. Returns the active
 * problems. Runs one at a time (a call while one runs waits for it). `now` is for tests.
 */
export function checkAlerts(ctx: Ctx, now: Date = new Date()): Promise<Found[]> {
  const s = runState(ctx);
  if (s.running) return s.running;
  s.running = runChecks(ctx, now).finally(() => {
    s.running = null;
    s.finishedAt = Date.now();
  });
  return s.running;
}

/** When the last check finished (ms since 1970; 0 = not yet in this process). GET /alerts checks again after a minute. */
export function lastCheckAt(ctx: Ctx): number {
  return runState(ctx).finishedAt;
}

/** The active problems this person may see: super admins all, organisers EVENT_KINDS. Newest first, critical first. */
export async function activeAlerts(ctx: Ctx, user: AdminUser): Promise<Alert[]> {
  const kinds = user.role === 'super_admin' ? null : [...EVENT_KINDS];
  const rows = (
    await ctx.db.query<any>(
      `select a.key, a.kind, a.severity, a.title, a.detail, a.event_id, a.started_at, e.title as event_title
         from alerts a left join events e on e.id = a.event_id
        where a.cleared_at is null and ($1::text[] is null or a.kind = any($1::text[]))
          and (a.event_id is null or e.org_id = $2)
        order by (a.severity = 'critical') desc, a.started_at desc, a.key`,
      [kinds, ctx.orgId],
    )
  ).rows;
  return rows.map((a) => ({
    key: a.key,
    kind: a.kind,
    severity: a.severity,
    title: a.title,
    detail: a.detail,
    event: a.event_id ? { id: a.event_id, title: a.event_title } : null,
    action: actionFor(a.kind, a.event_id),
    started_at: new Date(a.started_at).toISOString(),
  }));
}

/** What the morning summary would say now. */
export async function digestData(ctx: Ctx): Promise<DigestData> {
  const waiting = (
    await ctx.db.query<{ event: string; count: number }>(
      `select e.title as event, count(*)::int as count
         from media m join events e on e.id = m.event_id
        where e.org_id = $1 and e.status <> 'archived' and m.status = 'ready' and m.duplicate_of is null and m.review = 'pending'
        group by e.id, e.title, e.starts_on order by e.starts_on desc nulls last, e.title`,
      [ctx.orgId],
    )
  ).rows;
  const req = (
    await ctx.db.query<{ reports: number; removals: number }>(
      `select (count(*) filter (where q.kind = 'report'))::int as reports, (count(*) filter (where q.kind = 'removal'))::int as removals
         from requests q join events e on e.id = q.event_id
        where e.org_id = $1 and e.status <> 'archived' and q.status = 'open'`,
      [ctx.orgId],
    )
  ).rows[0];
  return { waiting, reports: req.reports, removals: req.removals };
}

/**
 * The morning summary to the super admins with alert emails on: uploads waiting for approval (per event) and open
 * requests (reports, removals). Sent at most once a day (app_state 'digest_last' = YYYY-MM-DD), between digestHour
 * and digestHour + 3, and only when there is something in it. Returns true when it was sent. `now` is for tests.
 */
export async function sendDigest(ctx: Ctx, now: Date = new Date()): Promise<boolean> {
  const hour = ctx.cfg.alerts.digestHour;
  if (hour < 0 || !ctx.mailer.configured) return false;
  if (now.getHours() < hour || now.getHours() >= hour + 3) return false;
  const today = localDay(now);
  // Claim today in one step, so two runs at once never both send it.
  const claimed = (
    await ctx.db.query(
      `insert into app_state (key, value, updated_at) values ('digest_last', to_jsonb($1::text), now())
       on conflict (key) do update set value = excluded.value, updated_at = now()
        where app_state.value is distinct from excluded.value
       returning key`,
      [today],
    )
  ).rowCount;
  if (!claimed) return false;
  const d = await digestData(ctx);
  const uploads = d.waiting.reduce((n, w) => n + w.count, 0);
  if (uploads + d.reports + d.removals === 0) return false;
  const to = await recipients(ctx);
  if (!to.length) return false;
  return sendAll(ctx, to, (t) => digestMail(t, d, consoleUrl(ctx)));
}

/** "Send a test email" (Settings > Alerts). Resolves true when the SMTP server took it. */
export async function sendTestEmail(ctx: Ctx, to: string): Promise<boolean> {
  return ctx.mailer.send(testMail(to, consoleUrl(ctx)));
}

/** Start the checks (every cfg.alerts.everyMin minutes, the first a minute after start) and the summary. Returns stop. */
export function startAlerts(ctx: Ctx): () => void {
  setServerStart(null);
  const tick = async () => {
    try {
      await checkAlerts(ctx);
    } catch (e) {
      ctx.log(`alerts: ${(e as Error).message}`);
    }
    try {
      await sendDigest(ctx);
    } catch (e) {
      ctx.log(`alerts: the morning summary could not be sent: ${(e as Error).message}`);
    }
  };
  let every: NodeJS.Timeout | undefined;
  const first = setTimeout(() => {
    void tick();
    every = setInterval(() => void tick(), ctx.cfg.alerts.everyMin * 60_000);
    every.unref();
  }, 60_000);
  first.unref();
  return () => {
    clearTimeout(first);
    if (every) clearInterval(every);
  };
}
