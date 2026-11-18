import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import express, { type Request, type Response } from 'express';
import { Router } from '../lib/router.js';
import yazl from 'yazl';
import { z } from 'zod';
import type { Ctx } from '../context.js';
import { VISIBLE } from '../db/schema.js';
import { DriveBusyError, DriveNotFoundError } from '../drive/index.js';
import { bad, parse } from '../lib/http.js';
import { imageUrl } from '../lib/links.js';
import { signJwt, verifyJwt } from '../lib/jwt.js';
import { Limiter } from '../lib/redis.js';
import { hashPassword, needsRehash, sha256Hex, verifyPassword } from '../lib/security.js';
import { tempPath } from '../media/files.js';
import { searchEvent } from '../media/search.js';
import { ingestUpload, ingestVideoUpload, uploadTypeOk, videoTypeOk } from '../media/upload.js';
import { freeBytes, mimeOf, readRaw, receiveToFile, Slots } from '../lib/receive.js';
import { cleanFileForHandover, cleanForHandover } from '../media/location.js';
import { isHeic, type Look } from '../media/prepare.js';
import { forgetFullCopy, keptFullCopy, makeFullCopy, pendingFullCopy } from '../media/fullcopy.js';
import { cleanVideoCopy } from '../media/videocopy.js';
import { sha256Buffer, sha256File } from '../lib/hashes.js';
import { extOf, isDriveKey, itemOf, legacyPath } from '../media/copies.js';
import { hasFlag, warmSoon } from '../media/copyurls.js';
import { kickRebuild, markHot } from '../media/rebuild.js';
import { extOfName } from '../media/video.js';
import { randomUUID } from 'node:crypto';
import { EVENT_COLS, publicEvent } from './events-shared.js';
import { KIND_SQL } from '../people/filing.js';
import { assertRoomForUploads } from '../ops/disk.js';
import { freshCount, KEEP_CONSENT_VERSION, keepVector, markSeen, stopKeeping } from '../keep/keep-updated.js';
import { loadVapid, removeSubscriptions, saveSubscription } from '../keep/push.js';

/**
 * What a student gets for a download (Save original, Download all), never written to this server's disk unless it
 * has to be (an older video without its clean copy, a very large photo):
 *   buffer - a photo cleaned (or made full quality) in memory
 *   drive  - a copy kept in OneDrive (a full-quality photo, a video's location-free copy), streamed through
 *   file   - a temp file, removed after sending
 * name: the file name the student's phone saves it as.
 */
type Best =
  | { kind: 'buffer'; data: Buffer; name: string }
  | { kind: 'drive'; itemId: string; name: string; size: number | null; full?: boolean }
  | { kind: 'file'; file: string; name: string };

/** OneDrive itself (not the file) could not give an original just now: the student is told to try again later. */
const DRIVE_TROUBLE = ['DriveAuthError', 'DriveDownError', 'DriveBusyError', 'DriveFullError'];
/** Student requests never wait for a busy OneDrive (429/503): they get a quick "try again" instead. */
const NOW = { patient: false } as const;

const DEVICE = /^[A-Za-z0-9_-]{20,200}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** The wording version of the consent line under the selfie button. */
export const CONSENT_VERSION = 'v1';
/** What a phone is told when it asks for face search after the event's face data was deleted. */
const FACE_ENDED = 'Face search has ended for this event. Browse all photos instead.';
/** How long a Download all link works (it works once). */
const ZIP_LINK_SECONDS = 600;
/** ZIPs being made at the same moment by one server: each fetches originals from OneDrive into data/tmp. */
const ZIPS_AT_ONCE = 3;
const ORIGINALS_AT_ONCE = 8;
/** Save original, per phone in ten minutes: far more than anyone saves by hand, far less than a script asks for. */
const ORIGINALS_PER_PHONE_10_MIN = 300;
/** Students' uploads being received at the same moment (a photo is held in memory, a video streams to disk). */
const UPLOADS_AT_ONCE = 32;

/**
 * The address a network limit counts, or null when it would not be one visitor's network: an address on this computer
 * (a tunnel or proxy here that did not pass the visitor's address on), and, when no proxy is trusted
 * (TRUST_PROXY=false), a private one too (a proxy elsewhere in the building). Counting those would hold back everyone.
 */
export function networkOf(ip: string | undefined, trustProxy: boolean | number | string): string | null {
  const a = (ip ?? '').replace(/^::ffff:/i, '');
  if (!a || /^127\./.test(a) || a === '::1') return null;
  // TRUST_PROXY=0 trusts no proxy, as false does.
  if ((trustProxy === false || trustProxy === 0) && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|f[cd][0-9a-f]{2}:|fe80:)/i.test(a)) return null;
  if (!a.includes(':')) return a;
  // IPv6: one phone or home is given a whole /64, so count that and not each address in it.
  const [head, tail] = a.split('%')[0].split('::');
  const h = head ? head.split(':') : [];
  const t = tail === undefined ? [] : tail ? tail.split(':') : [];
  const groups = [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t];
  return `${groups.slice(0, 4).map((g) => (parseInt(g, 16) || 0).toString(16)).join(':')}::/64`;
}
/** Uploads from one network address in ten minutes. A campus Wi-Fi shares one address, so this is generous. */
const UPLOADS_PER_IP_10_MIN = 600;
/** Keep me updated: turning it on (a selfie each time), per phone in ten minutes. */
const KEEP_PER_10_MIN = 10;
/** Reports and removal requests, together, per phone in a day. */
const REQUESTS_PER_DAY = 20;
/**
 * Where a push subscription may point: the push services of the browsers (Chrome, Edge, Firefox, Safari, Samsung
 * and others use these). The server sends to this address, so it is never an address of the student's choosing.
 */
const PUSH_HOSTS = /(^|\.)(googleapis\.com|mozilla\.com|mozaws\.net|push\.apple\.com|notify\.windows\.com)$/i;

/** A push subscription as the browser's PushSubscription.toJSON() gives it. */
const SUBSCRIPTION = z.object({
  endpoint: z
    .string()
    .max(1000)
    .url()
    .refine((u) => {
      try {
        const url = new URL(u);
        return url.protocol === 'https:' && !url.port && PUSH_HOSTS.test(url.hostname);
      } catch {
        return false;
      }
    }, 'Not a push service address.'),
  keys: z.object({ p256dh: z.string().min(1).max(200), auth: z.string().min(1).max(100) }),
});

interface Guest {
  id: string;
  album_ok: boolean;
  upload_count: number;
  consent_at: Date | null;
  keep_updated: boolean;
  has_vector: boolean;
}

/** What students reach through the one link. No login anywhere: a phone is known by a random token it keeps. */
export function publicRoutes(ctx: Ctx): Router {
  const { db, cfg } = ctx;
  const r = Router();
  // Eight wrong album passcodes from one phone and it waits five minutes (counted in Redis).
  const passcodeTries = new Limiter(ctx.redis, 'passcode', 8, 5 * 60);
  // Download all: ten links per phone in ten minutes, and a few ZIPs made at once by this server.
  const zipLinks = new Limiter(ctx.redis, 'zip-link', 10, 10 * 60);
  const zipSlots = new Slots(ZIPS_AT_ONCE);
  // Save original (a photo is fetched here to take its GPS position out): a few at a time, and not without end for one phone.
  const originalSlots = new Slots(ORIGINALS_AT_ONCE);
  const originalsPerPhone = new Limiter(ctx.redis, 'original', ORIGINALS_PER_PHONE_10_MIN, 10 * 60);
  // Add your photos: no login, and a phone's token costs nothing, so the limits are on the network and the server.
  const uploadsFromIp = new Limiter(ctx.redis, 'upload-ip', UPLOADS_PER_IP_10_MIN, 10 * 60);
  const uploadSlots = new Slots(UPLOADS_AT_ONCE);
  // Find my photos is counted per phone, but a script can make itself a new phone for every try: so also per network
  // address, with room for a whole class on one Wi-Fi (SEARCHES_PER_IP_10_MIN, 0 = no limit).
  const searchesFromIp = new Limiter(ctx.redis, 'search-ip', cfg.searchesPerIp10Min, 10 * 60);
  // Keep me updated: turning it on runs the face model on a selfie, so a phone can do it only a few times.
  const keepTries = new Limiter(ctx.redis, 'keep', KEEP_PER_10_MIN, 10 * 60);

  /** The fix a photo is shown (and downloaded) with: its look, unless its event has Improve photos off. */
  const lookOf = (e: any, m: any): Look | null => (e.improve_photos === false ? null : (m.look ?? null));

  const baseOf = (m: any, i = 0) => String(m.name ?? `photo-${i + 1}`).replace(/\.[^.]+$/, '') || `photo-${i + 1}`;

  /**
   * The full quality a student gets for a downloaded original (Save original, Download all):
   *   - a photo the album shows unchanged: the original itself, byte for byte, with only where it was taken taken out
   *     (location.ts: only when every block of its metadata could be read and cleaned), done in memory
   *   - a photo the album shows with its fix (Improve photos), an iPhone HEIC photo, or one whose metadata could not
   *     be cleaned: the full-size photo (with that fix) as a JPEG of quality 93 in its own colours, camera and date
   *     kept, nothing else of the metadata (fullcopy.ts: made two at a time, kept in OneDrive for the next student)
   *   - a video: its location-free copy kept in OneDrive (videocopy.ts: the same video and sound, no metadata).
   *     An older video without one gets it made here, in a temp file (and the rebuild job keeps one for next time).
   *     Never the raw original: it carries the place it was filmed.
   */
  async function bestQuality(e: any, m: any, signal: AbortSignal): Promise<Best> {
    if (m.type === 'video') {
      const ext = extOfName(String(m.name ?? ''));
      if (isDriveKey(m.clean_key)) return { kind: 'drive', itemId: itemOf(m.clean_key), name: `${baseOf(m)}.${extOf(m.clean_key) || ext}`, size: null };
      if (!m.onedrive_item_id) throw new DriveNotFoundError();
      if (!(await roomForVideo(m))) throw bad(503, 'busy', 'This video can be downloaded a little later.');
      await markHot(ctx, m.id); // the rebuild job keeps a clean copy for the next download
      kickRebuild(ctx);
      const tmp = tempPath(cfg, `orig-${m.id}-${randomUUID()}`);
      try {
        await ctx.drive.download(m.onedrive_item_id, tmp, signal, NOW);
        const clean = await cleanVideoCopy(cfg, tmp, ext);
        return { kind: 'file', file: clean, name: `${baseOf(m)}.${path.extname(clean).slice(1)}` };
      } finally {
        await fs.promises.unlink(tmp).catch(() => {});
      }
    }
    const look = lookOf(e, m);
    const kept = await keptFullCopy(ctx, m.id, m.sha256 ?? null, look);
    if (kept) return { kind: 'drive', itemId: kept.itemId, name: `${baseOf(m)}.jpg`, size: kept.bytes, full: true };
    // Made moments ago and still being kept in OneDrive: the same bytes, without fetching the original again.
    const pending = pendingFullCopy(m.id, m.sha256 ?? null, look);
    const ready = pending ? await pending.catch(() => null) : null;
    if (ready) return { kind: 'buffer', data: ready, name: `${baseOf(m)}.jpg` };
    if (!m.onedrive_item_id) throw new DriveNotFoundError();
    let buf: Buffer | null = null;
    try {
      buf = await ctx.drive.readAll(m.onedrive_item_id, cfg.handoverMaxBytes, signal, NOW);
    } catch (err) {
      if ((err as Error)?.name !== 'DriveTooLargeError') throw err;
    }
    if (!buf) {
      // Larger than HANDOVER_MAX_MB: through a temp file, removed afterwards.
      const tmp = tempPath(cfg, `orig-${m.id}-${randomUUID()}`);
      try {
        await ctx.drive.download(m.onedrive_item_id, tmp, signal, NOW);
        if (!look && !(await isHeic(tmp)) && (await cleanFileForHandover(tmp))) {
          const out = `${tmp}.clean.${extOfName(String(m.name ?? 'photo.jpg'))}`;
          await fs.promises.rename(tmp, out);
          return { kind: 'file', file: out, name: m.name ?? 'photo.jpg' };
        }
        const same = m.sha256 && (await sha256File(tmp)) === m.sha256 ? m.sha256 : null;
        return { kind: 'buffer', data: (await makeFullCopy(ctx, m.id, same, tmp, look)).data, name: `${baseOf(m)}.jpg` };
      } finally {
        await fs.promises.unlink(tmp).catch(() => {});
      }
    }
    if (!look && !(await isHeic(buf))) {
      const clean = Buffer.from(buf); // cleaned in place: a copy, so a refusal leaves the original bytes for the full copy
      if (cleanForHandover(clean)) return { kind: 'buffer', data: clean, name: m.name ?? 'photo.jpg' };
    }
    const same = m.sha256 && sha256Buffer(buf) === m.sha256 ? m.sha256 : null;
    // The renderer reads a file (HEIC goes through ffmpeg): written for the render only, removed right after.
    const tmp = tempPath(cfg, `full-${m.id}-${randomUUID()}`);
    try {
      await fs.promises.writeFile(tmp, buf);
      buf = null;
      return { kind: 'buffer', data: (await makeFullCopy(ctx, m.id, same, tmp, look)).data, name: `${baseOf(m)}.jpg` };
    } finally {
      await fs.promises.unlink(tmp).catch(() => {});
    }
  }

  /** Room in data/tmp for a video download and its location-free copy (both are on disk for a moment). */
  async function roomForVideo(m: any): Promise<boolean> {
    const bytes = Number(m.bytes) || 0;
    return (await freeBytes(path.dirname(tempPath(cfg, 'x')))) > bytes * 2.3 + 512 * 1024 * 1024;
  }

  /** A readable stream of what a student gets (a kept copy streams from OneDrive, Range passed on). */
  async function openBest(best: Best, signal: AbortSignal, range?: string | null): Promise<{ body: Readable; size: number | null; status: number; contentRange: string | null }> {
    if (best.kind === 'buffer') return { body: Readable.from([best.data]), size: best.data.length, status: 200, contentRange: null };
    if (best.kind === 'file') {
      const st = await fs.promises.stat(best.file);
      return { body: fs.createReadStream(best.file), size: st.size, status: 200, contentRange: null };
    }
    const got = await ctx.drive.read(best.itemId, { range: range ?? null, signal, patient: false });
    return { body: Readable.fromWeb(got.body as any), size: got.size, status: got.status, contentRange: got.contentRange };
  }

  /**
   * A kept download copy turned out to be gone from OneDrive (deleted there by hand): a photo's full copy loses its
   * row, a video's location-free copy its key (the trigger queues the item; one already gone counts as done) and the
   * rebuild job makes a new one. The download itself is then made from the original.
   */
  async function dropKeptCopy(m: any, best: Extract<Best, { kind: 'drive' }>): Promise<void> {
    if (best.full) return forgetFullCopy(ctx, best.itemId);
    await db.query(`update media set clean_key = null, clean_tries = 0 where id = $1 and copy_item(clean_key) = $2`, [m.id, best.itemId]);
    m.clean_key = null;
    await markHot(ctx, m.id);
    kickRebuild(ctx);
  }

  async function eventBySlug(slug: string): Promise<any> {
    const e = (await db.query(`select ${EVENT_COLS}, e.crowd_folder_id, e.album_passcode_hash from events e where e.slug = $1`, [slug])).rows[0];
    if (!e) throw bad(404, 'not_found', 'This event does not exist.');
    return e;
  }

  /** The phone's row for this event. Created on first use. */
  async function guestOf(req: Request, event: any): Promise<Guest> {
    const token = String(req.headers['x-device'] ?? '');
    if (!DEVICE.test(token)) throw bad(400, 'no_device', 'This phone has no device token yet. Reload the page.');
    const hash = sha256Hex(token);
    const row = await db.query<Guest>(
      `insert into guests (event_id, device_token_hash) values ($1, $2)
       on conflict (event_id, device_token_hash) do update set device_token_hash = excluded.device_token_hash
       returning id, album_ok, upload_count, consent_at, keep_updated, (embedding is not null) as has_vector`,
      [event.id, hash],
    );
    return row.rows[0];
  }

  const isOpen = (e: any) => e.status === 'live' || e.status === 'closed';
  /** The event's face data was deleted (expiry, or by an organiser): face search is over, the photos stay. */
  const faceEnded = (e: any) => e.face_deleted_at != null;
  /** Keep me updated is offered for this event. */
  const keepAvailable = (e: any) => cfg.keepUpdated && isOpen(e) && !!e.face_enabled && !faceEnded(e);

  /** The event as the one link shows it, with what this phone has new (Keep me updated) and whether face search ended. */
  async function eventFor(e: any, mine: number, fresh: number): Promise<any> {
    const out = await publicEvent(ctx, e, mine);
    const ended = faceEnded(e);
    return {
      ...out,
      mine_new: isOpen(e) ? fresh : 0,
      face_ended: ended,
      options: { ...out.options, find: out.options.find && !ended },
    };
  }

  /** Keep me updated for this phone in this event. */
  async function keepState(e: any, guestId: string): Promise<{ available: boolean; on: boolean; push: boolean; consent_version: string }> {
    const g = (
      await db.query<{ on: boolean; push: boolean }>(
        `select (g.keep_updated and g.embedding is not null) as on,
                exists (select 1 from push_subscriptions s where s.guest_id = g.id) as push
           from guests g where g.id = $1`,
        [guestId],
      )
    ).rows[0];
    return { available: keepAvailable(e), on: !!g?.on, push: !!g?.push, consent_version: KEEP_CONSENT_VERSION };
  }

  /** The phone's newest removal request in this event, or null. */
  async function removalState(e: any, guestId: string): Promise<any> {
    const r = (
      await db.query(
        `select q.id, q.status, q.created_at, q.resolved_at, (select count(*)::int from request_media rm where rm.request_id = q.id) as count
           from requests q where q.guest_id = $1 and q.event_id = $2 and q.kind = 'removal'
          order by q.created_at desc limit 1`,
        [guestId, e.id],
      )
    ).rows[0];
    return r ? { id: r.id, status: r.status, count: r.count, created_at: r.created_at, resolved_at: r.resolved_at } : null;
  }
  const albumOpenFor = (e: any, g: Guest) => isOpen(e) && (!e.album_passcode_hash || g.album_ok);
  /** One photo or video as the web app gets it. A video's thumb and web are its poster; video is the MP4 to play. */
  const photo = (m: any, extra: Record<string, unknown> = {}) => ({
    id: m.id,
    type: m.type === 'video' ? 'video' : 'photo',
    duration_ms: m.type === 'video' ? (m.duration_ms ?? null) : null,
    thumb: imageUrl(cfg, m.id, 't'),
    web: imageUrl(cfg, m.id, 'w'),
    video: m.type === 'video' && m.video_key ? imageUrl(cfg, m.id, 'v') : null,
    width: m.width,
    height: m.height,
    taken_at: m.taken_at,
    by: m.source === 'crowd' ? (m.uploader_name ?? 'a student') : null,
    /** solo | duo | group: how many main people are in it (People rules). */
    kind: m.kind ?? null,
    /** A video in your results: where your face is seen in it, in milliseconds (the player starts just before). */
    at_ms: m.type === 'video' && m.at_ms != null ? m.at_ms : null,
    ...extra,
  });

  /** A phone's saved result. A match that pointed at a copy shows the photo that is shown instead. */
  async function minePhotos(guestId: string): Promise<any[]> {
    const rows = await db.query(
      `select m.id, m.width, m.height, m.taken_at, m.source, m.uploader_name, m.name, m.web_key, m.type, m.duration_ms, m.video_key,
              m.clean_key, m.bytes, m.onedrive_item_id, m.look, m.sha256, ${KIND_SQL} as kind,
              bool_or(mt.tier = 'sure') as sure, max(mt.similarity) as score, bool_or(mt.fresh and mt.tier = 'sure') as fresh,
              (array_agg(mt.at_ms order by mt.similarity desc))[1] as at_ms
         from matches mt
         join media o on o.id = mt.media_id
         join media m on m.id = coalesce(o.duplicate_of, o.id)
        where mt.guest_id = $1 and ${VISIBLE}
        group by m.id
       having not bool_or(mt.not_me)
        order by m.taken_at nulls last, m.id`,
      [guestId],
    );
    return rows.rows;
  }

  /** The one rule for loading a photo: it is visible, and it is in this phone's results or the album is open to it. */
  async function mayFetch(event: any, guest: Guest, mediaId: string): Promise<any> {
    if (!UUID.test(mediaId) || !isOpen(event)) throw bad(404, 'not_found', 'This photo is not available.');
    const m = (await db.query(`select m.* from media m where m.id = $1 and m.event_id = $2 and ${VISIBLE}`, [mediaId, event.id])).rows[0];
    if (!m) throw bad(404, 'not_found', 'This photo is not available.');
    if (albumOpenFor(event, guest)) return m;
    if ((await minePhotos(guest.id)).some((p) => p.id === mediaId)) return m;
    throw bad(403, 'passcode_needed', 'Enter the album passcode to open this photo.');
  }

  // ---- the one link ---------------------------------------------------------------
  /**
   * For each event, how many photos this phone's last selfie found (plan, screen A1), and how many of them Keep me
   * updated added that the phone has not seen yet. Nothing is created for a phone that only looks.
   */
  async function mineCounts(req: Request): Promise<Map<string, { n: number; fresh: number }>> {
    const token = String(req.headers['x-device'] ?? '');
    if (!DEVICE.test(token)) return new Map();
    const rows = await db.query<{ event_id: string; n: number; fresh: number }>(
      `select x.event_id, count(*)::int as n, (count(*) filter (where x.fresh))::int as fresh from (
         select g.event_id, m.id, bool_or(mt.fresh and mt.tier = 'sure') as fresh
           from guests g
           join matches mt on mt.guest_id = g.id
           join media o on o.id = mt.media_id
           join media m on m.id = coalesce(o.duplicate_of, o.id)
          where g.device_token_hash = $1 and ${VISIBLE}
          group by g.event_id, m.id
         having bool_or(mt.tier = 'sure') and not bool_or(mt.not_me)
       ) x group by x.event_id`,
      [sha256Hex(token)],
    );
    return new Map(rows.rows.map((r) => [r.event_id, { n: r.n, fresh: r.fresh }]));
  }

  /** The campuses, for the tabs on the home page. */
  r.get('/campuses', async (_req, res) => {
    const campuses = await db.knex('campuses').select('id', 'name', 'slug').where({ org_id: ctx.orgId }).orderBy([{ column: 'sort' }, { column: 'name' }]);
    res.json({ campuses });
  });

  r.get('/events', async (req, res) => {
    // ?campus=<slug>: only that campus's events.
    const campus = typeof req.query.campus === 'string' && /^[a-z0-9-]{1,60}$/.test(req.query.campus) ? req.query.campus : null;
    const rows = (
      await db.query(
        `select ${EVENT_COLS} from events e
          where e.listed and e.status in ('draft', 'live', 'closed')
            and ($1::text is null or e.campus_id = (select c.id from campuses c where c.org_id = e.org_id and c.slug = $1))
          order by e.starts_on desc nulls last, e.created_at desc`,
        [campus],
      )
    ).rows;
    const org = (await db.query(`select name from orgs where id = $1`, [ctx.orgId])).rows[0];
    const mine = await mineCounts(req);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ org: org?.name ?? null, contact: cfg.contact || null, events: await Promise.all(rows.map((e) => eventFor(e, mine.get(e.id)?.n ?? 0, mine.get(e.id)?.fresh ?? 0))) });
  });

  r.get('/e/:slug', async (req, res) => {
    const e = await eventBySlug(req.params.slug);
    res.setHeader('Cache-Control', 'no-store');
    if (e.status === 'archived') {
      res.json({
        contact: cfg.contact || null,
        event: {
          slug: e.slug,
          title: e.title,
          state: 'archived',
          strip: [],
          photos: 0,
          mine: 0,
          mine_new: 0,
          face_ended: faceEnded(e),
          options: { find: false, album: false, album_locked: false, upload: false, download: false },
        },
      });
      return;
    }
    const counts = (await mineCounts(req)).get(e.id);
    res.json({ contact: cfg.contact || null, event: await eventFor(e, counts?.n ?? 0, counts?.fresh ?? 0) });
  });

  /** Start (or resume) this phone's session for the event. The only thing ever asked is the album passcode, if one is set. */
  r.post('/e/:slug/session', async (req, res) => {
    const e = await eventBySlug(req.params.slug);
    let g = await guestOf(req, e);
    const { passcode } = parse(z.object({ passcode: z.string().max(64).optional() }), req.body ?? {});
    if (passcode !== undefined && e.album_passcode_hash && !g.album_ok) {
      // Counted before the check, so tries sent all at once are counted too.
      if (!(await passcodeTries.allow(g.id))) throw bad(429, 'slow_down', 'Too many tries. Wait a few minutes.');
      if (!(await verifyPassword(passcode, e.album_passcode_hash))) throw bad(403, 'wrong_passcode', 'That passcode is not right.');
      await passcodeTries.clear(g.id);
      if (needsRehash(e.album_passcode_hash)) await db.query(`update events set album_passcode_hash = $2 where id = $1`, [e.id, await hashPassword(passcode)]);
      await db.query(`update guests set album_ok = true where id = $1`, [g.id]);
      g = { ...g, album_ok: true };
    }
    const mine = await minePhotos(g.id);
    const searched = (await db.query(`select 1 from search_log where guest_id = $1 limit 1`, [g.id])).rows.length > 0;
    res.json({
      contact: cfg.contact || null,
      event: e.status === 'archived' ? null : await eventFor(e, mine.filter((m) => m.sure).length, mine.filter((m) => m.sure && m.fresh).length),
      me: { album_open: albumOpenFor(e, g), searched, my_photos: mine.length, uploads_left: Math.max(0, cfg.uploadsPerPhone - g.upload_count) },
    });
  });

  // ---- Find my photos ---------------------------------------------------------------
  r.post('/e/:slug/selfie', express.raw({ type: () => true, limit: '10mb' }), async (req, res) => {
    const e = await eventBySlug(req.params.slug);
    if (!isOpen(e)) throw bad(403, 'not_open', 'Photos for this event are not open yet.');
    if (!e.face_enabled) throw bad(403, 'face_off', 'Face search is switched off for this event. Use the full album.');
    if (faceEnded(e)) throw bad(403, 'face_ended', FACE_ENDED);
    const g = await guestOf(req, e);
    if (req.headers['x-consent'] !== CONSENT_VERSION) throw bad(400, 'consent_needed', 'Please read the line under the selfie button first.');
    if (!Buffer.isBuffer(req.body) || req.body.length < 1000) throw bad(400, 'no_selfie', 'No selfie was received.');

    // Search limit, counted per phone: a whole campus Wi-Fi shares one IP address.
    const used = (
      await db.query<{ recent: number; today: number }>(
        `select (count(*) filter (where created_at > now() - interval '10 minutes'))::int as recent,
                (count(*) filter (where created_at > now() - interval '24 hours'))::int as today
           from search_log where guest_id = $1`,
        [g.id],
      )
    ).rows[0];
    if (used.recent >= cfg.searchesPer10Min) throw bad(429, 'slow_down', 'That is a lot of selfies. Try again in a few minutes.');
    if (used.today >= cfg.searchesPerDay) throw bad(429, 'slow_down', 'You have reached today\'s selfie limit for this event. Your photos are still here.');
    const network = cfg.searchesPerIp10Min > 0 ? networkOf(req.ip, cfg.trustProxy) : null;
    if (network && !(await searchesFromIp.allow(network))) throw bad(429, 'slow_down', 'Many selfies were sent from this network just now. Try again in a few minutes.');

    const found = await ctx.face.selfie(req.body); // the selfie stays in memory and is dropped after this request
    if (!found) throw bad(422, 'no_face', "We couldn't see your face, try again.");
    const hits = await searchEvent(ctx, e.id, found.vector);
    await db.tx(async (q) => {
      await q.query(`delete from matches where guest_id = $1`, [g.id]); // a retake replaces the earlier result
      for (let i = 0; i < hits.length; i += 200) {
        const chunk = hits.slice(i, i + 200);
        const params: unknown[] = [g.id];
        const values = chunk.map((h, k) => {
          params.push(h.mediaId, h.score, h.tier, h.atMs);
          return `($1, $${k * 4 + 2}, $${k * 4 + 3}, $${k * 4 + 4}, $${k * 4 + 5})`;
        });
        await q.query(`insert into matches (guest_id, media_id, similarity, tier, at_ms) values ${values.join(', ')} on conflict do nothing`, params);
      }
      await q.query(`update guests set consent_version = $2, consent_at = now() where id = $1`, [g.id, CONSENT_VERSION]);
      await q.query(`insert into search_log (event_id, guest_id, ip_hash, result_count) values ($1, $2, $3, $4)`, [e.id, g.id, sha256Hex(`${cfg.sessionSecret}|${req.ip}`).slice(0, 32), hits.length]);
    });
    // The selfie's vector is not kept here: only POST /keep keeps one, after its own consent (Keep me updated).
    const mine = await minePhotos(g.id);
    warmSoon(ctx, e.id, 't');
    res.json({ faces_in_selfie: found.faces, ...splitMine(mine), images_ok: await imagesOk() });
  });

  /** False while OneDrive could not give photos a moment ago: the album says so instead of showing empty tiles. */
  const imagesOk = async () => !(await hasFlag(ctx, 'drive:down'));

  const splitMine = (rows: any[]) => ({
    sure: rows.filter((m) => m.sure).map((m) => photo(m, { fresh: !!m.fresh })),
    maybe: rows.filter((m) => !m.sure).map((m) => photo(m)),
  });

  r.get('/e/:slug/mine', async (req, res) => {
    const e = await eventBySlug(req.params.slug);
    const g = await guestOf(req, e);
    const last = (await db.query<{ at: Date }>(`select max(created_at) as at from search_log where guest_id = $1`, [g.id])).rows[0]?.at ?? null;
    const mine = isOpen(e) ? await minePhotos(g.id) : [];
    const newer =
      last && isOpen(e) ? (await db.query<{ n: number }>(`select count(*)::int as n from media m where m.event_id = $1 and ${VISIBLE} and m.processed_at > $2`, [e.id, last])).rows[0].n : 0;
    // "My photos shows what is ready and says more are coming" while the organiser's photos are still being read.
    const coming =
      isOpen(e) && (ctx.syncing.has(e.id) || (await db.query(`select 1 from media where event_id = $1 and type in ('photo', 'video') and status in ('found', 'processing') limit 1`, [e.id])).rows.length > 0);
    if (mine.length) warmSoon(ctx, e.id, 't'); // the links of the whole album in one listing, before the phone asks
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      images_ok: await imagesOk(),
      searched: !!last,
      new_photos: newer,
      more_coming: coming,
      download: e.allow_download,
      ...splitMine(mine),
      keep: await keepState(e, g.id),
      removal: await removalState(e, g.id),
      fresh_count: isOpen(e) ? await freshCount(db, g.id) : 0,
    });
  });

  /** My prints showed the new photos: their "New" marks are cleared. */
  r.post('/e/:slug/mine/seen', async (req, res) => {
    const e = await eventBySlug(req.params.slug);
    const g = await guestOf(req, e);
    await markSeen(db, g.id);
    res.json({ ok: true });
  });

  // ---- Keep me updated ---------------------------------------------------------------
  // Turning it on sends a selfie again (the one just taken, still in the phone's memory): its face vector is the only
  // thing kept, for this event only, after the student ticked the box with its own consent line. The selfie is not.
  r.post('/e/:slug/keep', express.raw({ type: () => true, limit: '10mb' }), async (req, res) => {
    const e = await eventBySlug(req.params.slug);
    if (!cfg.keepUpdated) throw bad(403, 'keep_off', 'Keep me updated is switched off on this server.');
    if (!isOpen(e)) throw bad(403, 'not_open', 'Photos for this event are not open yet.');
    if (!e.face_enabled) throw bad(403, 'face_off', 'Face search is switched off for this event. Use the full album.');
    if (faceEnded(e)) throw bad(403, 'face_ended', FACE_ENDED);
    const g = await guestOf(req, e);
    if (req.headers['x-keep-consent'] !== KEEP_CONSENT_VERSION) throw bad(400, 'consent_needed', 'Please read the line next to the box first.');
    if (!Buffer.isBuffer(req.body) || req.body.length < 1000) throw bad(400, 'no_selfie', 'No selfie was received.');
    if (!(await db.query(`select 1 from search_log where guest_id = $1 limit 1`, [g.id])).rows.length) throw bad(409, 'not_searched', 'Find your photos first.');
    if (!(await keepTries.allow(g.id))) throw bad(429, 'slow_down', 'Try again in a few minutes.');
    const found = await ctx.face.selfie(req.body); // in memory only, dropped after this request
    if (!found) throw bad(422, 'no_face', "We couldn't see your face, try again.");
    // The event changed while the selfie was read (face data deleted, archived, face search off): nothing is kept.
    if (!(await keepVector(ctx, g.id, found.vector))) {
      const now = await eventBySlug(req.params.slug);
      if (!isOpen(now)) throw bad(403, 'not_open', 'Photos for this event are not open yet.');
      if (!now.face_enabled) throw bad(403, 'face_off', 'Face search is switched off for this event. Use the full album.');
      throw bad(403, 'face_ended', FACE_ENDED);
    }
    res.json({ keep: await keepState(e, g.id) });
  });

  /** Turn Keep me updated off: the face code and the push subscriptions go, the results stay. */
  r.delete('/e/:slug/keep', async (req, res) => {
    const e = await eventBySlug(req.params.slug);
    const g = await guestOf(req, e);
    await stopKeeping(db, g.id);
    res.json({ keep: await keepState(e, g.id) });
  });

  /** The key the browser subscribes to pushes with (VAPID public key), or null when Keep me updated is off. */
  r.get('/push/key', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ key: cfg.keepUpdated ? loadVapid(cfg).publicKey : null });
  });

  r.post('/e/:slug/push', async (req, res) => {
    const e = await eventBySlug(req.params.slug);
    const g = await guestOf(req, e);
    const sub = parse(SUBSCRIPTION, req.body ?? {});
    if (!cfg.keepUpdated || !g.keep_updated || !g.has_vector) throw bad(409, 'keep_off_for_you', 'Turn on Keep me updated first.');
    if (!(await saveSubscription(db, g.id, sub))) throw bad(409, 'keep_off_for_you', 'Turn on Keep me updated first.');
    res.status(201).json({ ok: true });
  });

  r.delete('/e/:slug/push', async (req, res) => {
    const e = await eventBySlug(req.params.slug);
    const g = await guestOf(req, e);
    const b = parse(z.object({ endpoint: z.string().max(1000).optional() }), req.body ?? {});
    await removeSubscriptions(db, g.id, b.endpoint);
    res.json({ ok: true });
  });

  r.post('/e/:slug/mine/:mediaId/not-me', async (req, res) => {
    const e = await eventBySlug(req.params.slug);
    const g = await guestOf(req, e);
    if (!UUID.test(req.params.mediaId)) throw bad(404, 'not_found', 'This photo is not available.');
    const n = (
      await db.query(
        `update matches set not_me = true
          where guest_id = $1 and media_id in (select o.id from media o where coalesce(o.duplicate_of, o.id) = $2)`,
        [g.id, req.params.mediaId],
      )
    ).rowCount;
    if (!n) throw bad(404, 'not_found', 'That photo is not in your results.');
    res.json({ ok: true });
  });

  /** Download all: a ZIP of the originals of "Your photos". Answers with a short-lived link the phone can open once. */
  r.post('/e/:slug/zip', async (req, res) => {
    const e = await eventBySlug(req.params.slug);
    const g = await guestOf(req, e);
    if (!e.allow_download) throw bad(403, 'downloads_off', 'Downloads are switched off for this event.');
    if (!(await zipLinks.allow(g.id))) throw bad(429, 'slow_down', 'That is a lot of downloads. Try again in a few minutes.');
    const count = isOpen(e) ? (await minePhotos(g.id)).filter((m) => m.sure).length : 0;
    if (!count) throw bad(400, 'nothing_to_download', 'There are no photos to download yet.');
    res.json({ count, url: `/api/e/${e.slug}/zip/${signJwt(ctx.jwt, { g: g.id, e: e.id }, { audience: 'zip', ttlSeconds: ZIP_LINK_SECONDS })}` });
  });

  r.get('/e/:slug/zip/:token', async (req, res) => {
    const e = await eventBySlug(req.params.slug);
    const t = verifyJwt<{ g: string; e: string }>(ctx.jwt, req.params.token, 'zip');
    if (!t || t.e !== e.id || !isOpen(e) || !e.allow_download) throw bad(403, 'link_expired', 'This download link has expired. Tap Download all again.');
    const rows = (await minePhotos(t.g)).filter((m) => m.sure && (m.onedrive_item_id || m.clean_key || (m.type === 'video' ? m.video_key : m.web_key)));
    if (!rows.length) throw bad(404, 'nothing_to_download', 'There are no photos to download.');
    // Each ZIP fetches every original from OneDrive again, so: one at a time for a phone, a few at a time for the
    // server, and each link works once. A link refused for "busy" is not used up: the phone can try it again.
    const mine = `zip:active:${t.g}`;
    if ((await ctx.redis.set(mine, '1', 'EX', 30 * 60, 'NX')) !== 'OK') {
      throw bad(429, 'zip_running', 'Your photos are already being downloaded. Wait for that download to finish.');
    }
    const slot = zipSlots.take();
    try {
      if (!slot) throw bad(503, 'busy', 'Many downloads are running right now. Try again in a minute.');
      const first = await ctx.redis.set(`zip:used:${t.jti}`, '1', 'EX', ZIP_LINK_SECONDS + 60, 'NX');
      if (first !== 'OK') throw bad(403, 'link_used', 'This download link was already used. Tap Download all again.');
    } catch (err) {
      slot?.();
      await ctx.redis.del(mine).catch(() => {});
      throw err;
    }
    const zip = new yazl.ZipFile();
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${e.slug}-my-photos.zip"`);
    res.setHeader('Cache-Control', 'private, no-store');
    zip.outputStream.pipe(res);
    let gone = false;
    const stop = new AbortController(); // the phone went away: the original being fetched stops too
    const left = new Promise<void>((resolve) => res.once('close', () => ((gone = true), stop.abort(), resolve())));
    const used = new Set<string>();
    const nameFor = (m: any, i: number, ext: string) => {
      const base = String(m.name ?? `photo-${i + 1}`).replace(/\.[^.]+$/, '').replace(/[^\w.() -]+/g, '_').slice(0, 80) || `photo-${i + 1}`;
      let name = `${base}.${ext}`;
      for (let n = 2; used.has(name.toLowerCase()); n++) name = `${base} (${n}).${ext}`;
      used.add(name.toLowerCase());
      return name;
    };
    // The originals from OneDrive, best quality, one at a time (bestQuality): a photo cleaned in memory or its kept
    // full-quality copy, a video's location-free copy streamed from OneDrive. Only when an original cannot be fetched
    // does the ZIP take the copy the album shows (the web-size photo, or the video's preview MP4), from OneDrive too.
    try {
      for (const [i, m] of rows.entries()) {
        if (gone) break;
        const small: string | null = m.type === 'video' ? m.video_key : m.web_key;
        let entry: { body: Readable; name: string; after?: () => Promise<void> } | null = null;
        try {
          const open = async (b: Best) =>
            openBest(b, stop.signal).catch(async (err) => {
              if (b.kind === 'file') await fs.promises.rm(b.file, { force: true });
              throw err;
            });
          let best = await bestQuality(e, m, stop.signal);
          let opened;
          try {
            opened = await open(best);
          } catch (err) {
            if (!(best.kind === 'drive' && err instanceof DriveNotFoundError)) throw err;
            // Its kept copy was deleted in OneDrive: this download is made from the original, and the copy again later.
            await dropKeptCopy(m, best);
            best = await bestQuality(e, m, stop.signal);
            opened = await open(best);
          }
          const ext = best.name.includes('.') ? best.name.slice(best.name.lastIndexOf('.') + 1).toLowerCase() : m.type === 'video' ? 'mp4' : 'jpg';
          entry = { body: opened.body, name: nameFor(m, i, ext), after: best.kind === 'file' ? () => fs.promises.rm(best.file, { force: true }) : undefined };
        } catch (err) {
          if (gone) break;
          ctx.log(`Download all: the original of ${m.name ?? m.id} could not be fetched (${(err as Error).message}); the album copy goes in instead.`);
          if (isDriveKey(small)) {
            try {
              const got = await ctx.drive.read(itemOf(small), { signal: stop.signal, patient: false });
              entry = { body: Readable.fromWeb(got.body as any), name: nameFor(m, i, extOf(small) || (m.type === 'video' ? 'mp4' : 'webp')) };
            } catch {
              entry = null;
            }
          } else {
            const abs = legacyPath(cfg, small);
            const fh = abs ? await fs.promises.open(abs).catch(() => null) : null;
            if (fh) entry = { body: fh.createReadStream(), name: nameFor(m, i, path.extname(abs!).slice(1).toLowerCase() || 'jpg') };
          }
        }
        if (!entry) continue;
        const { body, name, after } = entry;
        body.on('error', (err) => {
          // The ZIP cannot go on without this entry: the phone sees a failed download instead of one that never ends.
          ctx.log(`Download all: ${name} could not be read: ${err.message}`);
          res.destroy(err);
        });
        const done = new Promise<void>((resolve) => body.once('close', () => resolve()));
        zip.addReadStream(body, name, { compress: false });
        await Promise.race([done, left]); // written into the ZIP, or the phone went away
        if (gone) body.destroy();
        await after?.().catch(() => {});
      }
      zip.end();
    } finally {
      slot!();
      await ctx.redis.del(mine).catch(() => {});
    }
  });

  /** Delete my selfie data and results for this event. */
  r.delete('/e/:slug/me', async (req, res) => {
    const e = await eventBySlug(req.params.slug);
    const g = await guestOf(req, e);
    await db.query(`delete from guests where id = $1`, [g.id]); // matches go with it; the search log keeps only counts
    res.json({ ok: true });
  });

  // ---- Full event album ---------------------------------------------------------------
  r.get('/e/:slug/album', async (req, res) => {
    const e = await eventBySlug(req.params.slug);
    const g = await guestOf(req, e);
    if (!isOpen(e)) throw bad(403, 'not_open', 'Photos for this event are not open yet.');
    if (!albumOpenFor(e, g)) throw bad(403, 'passcode_needed', 'Enter the album passcode.');
    const q = parse(z.object({ offset: z.coerce.number().int().min(0).optional(), limit: z.coerce.number().int().min(1).max(120).optional() }), req.query);
    const rows = (
      await db.query(
        `select m.id, m.width, m.height, m.taken_at, m.source, m.uploader_name, m.type, m.duration_ms, m.video_key, ${KIND_SQL} as kind from media m
          where m.event_id = $1 and ${VISIBLE}
          order by m.taken_at nulls last, m.id offset $2 limit $3`,
        [e.id, q.offset ?? 0, q.limit ?? 60],
      )
    ).rows;
    const total = (await db.query<{ n: number }>(`select count(*)::int as n from media m where m.event_id = $1 and ${VISIBLE}`, [e.id])).rows[0].n;
    if (rows.length) warmSoon(ctx, e.id, 't'); // the links of the whole album in one listing, before the phone asks
    res.setHeader('Cache-Control', 'no-store');
    res.json({ total, download: e.allow_download, images_ok: await imagesOk(), photos: rows.map((m) => photo(m)) });
  });

  /** Report a photo to the organiser. */
  r.post('/e/:slug/report', async (req, res) => {
    const e = await eventBySlug(req.params.slug);
    const g = await guestOf(req, e);
    const b = parse(z.object({ media_id: z.string().regex(UUID), reason: z.string().trim().max(300).optional() }), req.body);
    await mayFetch(e, g, b.media_id);
    const today = (await db.query<{ n: number }>(`select count(*)::int as n from requests where guest_id = $1 and created_at > now() - interval '24 hours'`, [g.id])).rows[0].n;
    if (today >= REQUESTS_PER_DAY) throw bad(429, 'slow_down', 'You have sent many reports today. Tell the help desk instead.');
    const dup = (await db.query(`select 1 from requests where guest_id = $1 and media_id = $2 and status = 'open'`, [g.id, b.media_id])).rows.length;
    if (!dup) await db.query(`insert into requests (event_id, media_id, guest_id, kind, reason) values ($1, $2, $3, 'report', $4)`, [e.id, b.media_id, g.id, b.reason || null]);
    res.status(201).json({ ok: true });
  });

  /**
   * Remove me: the student asks the organisers to take the photos they are in (their sure matches now, as My prints
   * shows them) out of the album. The organisers check it in Requests. One open request per phone per event.
   */
  r.post('/e/:slug/removal', async (req, res) => {
    const e = await eventBySlug(req.params.slug);
    if (!isOpen(e)) throw bad(403, 'not_open', 'Photos for this event are not open yet.');
    const g = await guestOf(req, e);
    const b = parse(z.object({ note: z.string().trim().max(300).optional() }), req.body ?? {});
    const today = (await db.query<{ n: number }>(`select count(*)::int as n from requests where guest_id = $1 and created_at > now() - interval '24 hours'`, [g.id])).rows[0].n;
    if (today >= REQUESTS_PER_DAY) throw bad(429, 'slow_down', 'You have sent many requests today. Tell the help desk instead.');
    const open = () => bad(409, 'removal_open', 'You already asked. Your removal request is waiting.');
    if ((await db.query(`select 1 from requests where guest_id = $1 and event_id = $2 and kind = 'removal' and status = 'open'`, [g.id, e.id])).rows.length) throw open();
    const ids = (await minePhotos(g.id)).filter((m) => m.sure).map((m) => m.id as string);
    if (!ids.length) throw bad(400, 'nothing_to_remove', 'We have not found you in any photos of this event yet.');
    try {
      await db.tx(async (q) => {
        const made = (
          await q.query<{ id: string }>(`insert into requests (event_id, media_id, guest_id, kind, reason) values ($1, null, $2, 'removal', $3) returning id`, [e.id, g.id, b.note || null])
        ).rows[0];
        for (let i = 0; i < ids.length; i += 500) {
          await q.query(`insert into request_media (request_id, media_id) select $1, unnest($2::uuid[]) on conflict do nothing`, [made.id, ids.slice(i, i + 500)]);
        }
      });
    } catch (err: any) {
      if (err?.code === '23505') throw open(); // two sent at the same moment: the one open request per phone holds
      throw err;
    }
    res.status(201).json({ removal: await removalState(e, g.id) });
  });

  /**
   * The original, at its best quality (bestQuality), sent without where it was taken. Always through this server:
   * the metadata check must happen here (fail-closed), the name is ours, and no OneDrive link of a download copy ever
   * leaves the server. A copy kept in OneDrive is streamed (Range passed on, so a download can resume).
   */
  r.get('/e/:slug/original/:mediaId', async (req, res) => {
    const e = await eventBySlug(req.params.slug);
    if (!e.allow_download) throw bad(403, 'downloads_off', 'Downloads are switched off for this event.');
    // Opened by the browser as a plain link, so the device token may come in the address.
    if (!req.headers['x-device'] && typeof req.query.d === 'string') req.headers['x-device'] = req.query.d;
    const g = await guestOf(req, e);
    const m = await mayFetch(e, g, req.params.mediaId);
    if (!(await originalsPerPhone.allow(g.id))) throw bad(429, 'slow_down', 'That is a lot of downloads. Try again in a few minutes.');
    if (!m.onedrive_item_id && !(m.type === 'video' && isDriveKey(m.clean_key))) throw bad(410, 'original_gone', 'Original no longer available.');
    const slot = originalSlots.take();
    if (!slot) throw bad(503, 'busy', 'Many downloads are running right now. Try again in a minute.');
    const stop = new AbortController();
    res.once('close', () => stop.abort());
    let best: Best | null = null;
    const fetchBest = async (): Promise<Best> => {
      try {
        return await bestQuality(e, m, stop.signal);
      } catch (err) {
        if (m.type === 'video' && !(err instanceof DriveNotFoundError) && !DRIVE_TROUBLE.includes((err as Error)?.name) && (err as Error)?.name !== 'HttpError' && !(err as any)?.status) {
          ctx.log(`a video could not be made ready for download: ${(err as Error).message}`);
          throw bad(503, 'original_unavailable', 'This video cannot be downloaded right now. Try again later.');
        }
        throw err;
      }
    };
    try {
      best = await fetchBest();
      const range = best.kind === 'drive' && typeof req.headers.range === 'string' ? req.headers.range : null;
      let opened;
      try {
        opened = await openBest(best, stop.signal, range);
      } catch (err) {
        if (best.kind === 'drive' && err instanceof DriveNotFoundError) {
          // The kept copy (a photo's full copy, a video's location-free copy) was deleted in OneDrive: this download
          // is made from the original, and the copy is made again.
          await dropKeptCopy(m, best);
          best = await fetchBest();
          opened = await openBest(best, stop.signal);
        } else throw err;
      }
      await sendDownload(res, best.name, opened);
    } catch (err) {
      if (err instanceof DriveNotFoundError) throw bad(410, 'original_gone', 'Original no longer available.');
      if (DRIVE_TROUBLE.includes((err as Error)?.name)) {
        ctx.log(`an original could not be fetched: ${(err as Error).message}`);
        if (err instanceof DriveBusyError) res.setHeader('Retry-After', String(Math.ceil(err.retryAfterMs / 1000)));
        throw bad(503, 'original_unavailable', 'The original is not available right now. Save the web-size copy instead.');
      }
      throw err;
    } finally {
      slot();
      if (best?.kind === 'file') await fs.promises.rm(best.file, { force: true });
    }
  });

  /** Send one download: its name, its type from the name, never cached, Range answered when it came from OneDrive. */
  function sendDownload(res: Response, name: string, opened: { body: Readable; size: number | null; status: number; contentRange: string | null }): Promise<void> {
    res.status(opened.status);
    res.attachment(name);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Accept-Ranges', opened.status === 206 || opened.contentRange ? 'bytes' : 'none');
    if (opened.size !== null) res.setHeader('Content-Length', String(opened.size));
    if (opened.contentRange) res.setHeader('Content-Range', opened.contentRange);
    return new Promise<void>((resolve) => {
      opened.body.once('error', () => {
        res.destroy();
        resolve();
      });
      res.once('close', () => {
        opened.body.destroy();
        resolve();
      });
      opened.body.pipe(res);
    });
  }

  // ---- Add your photos ---------------------------------------------------------------
  // Nothing of the body is read until the event, the phone's limit and the server's room have been checked.
  r.post('/e/:slug/uploads', async (req, res) => {
    const e = await eventBySlug(req.params.slug);
    if (!(e.status === 'draft' || e.status === 'live') || !e.crowd_uploads) throw bad(403, 'uploads_off', 'Adding photos is closed for this event.');
    if (!e.onedrive_folder_id) throw bad(403, 'uploads_off', 'Adding photos opens once the organiser has set up the event folder.');
    const mime = mimeOf(req);
    // A video is not held in memory: it streams to a file (up to UPLOAD_VIDEO_MAX_MB), then into OneDrive in pieces.
    const video = videoTypeOk(mime);
    if (!video && !uploadTypeOk(mime)) throw bad(415, 'unsupported', 'Photos (JPG, PNG or WebP) or videos (MP4, MOV or WebM) only.');
    // Less than TEMP_MIN_FREE_GB free on this Mac: refused before any of the body is read (507 disk_full).
    await assertRoomForUploads(cfg, 'student');
    const g = await guestOf(req, e);
    if (!(await uploadsFromIp.allow(String(req.ip ?? '')))) throw bad(429, 'slow_down', 'Many photos were sent from this network just now. Try again in a few minutes.');
    const slot = uploadSlots.take();
    if (!slot) throw bad(503, 'busy', 'Many photos are being added right now. Try again in a minute.');
    res.once('close', slot);
    // The phone's limit counts the uploads still arriving too, so many sent at once cannot all be received in full
    // only to be refused afterwards. The count is given back as soon as the body is in (the upload itself is
    // counted for good when it is saved).
    const arriving = `uploads:arriving:${g.id}`;
    const n = Number((await ctx.redis.multi().incr(arriving).expire(arriving, 3 * 60 * 60).exec())?.[0]?.[1] ?? 1);
    let received = false;
    const arrived = async () => {
      if (received) return;
      received = true;
      await ctx.redis.decr(arriving).catch(() => {});
    };
    try {
      const saved = (await db.query<{ upload_count: number }>(`select upload_count from guests where id = $1`, [g.id])).rows[0]?.upload_count ?? g.upload_count;
      if (saved + n > cfg.uploadsPerPhone) throw bad(429, 'limit_reached', `This phone has added ${cfg.uploadsPerPhone} photos to this event, which is the limit.`);
      // A video is on this Mac while it is read: room for about 2.3 times its size on top (507 disk_full).
      if (video) await assertRoomForUploads(cfg, 'student', { video: true, bytes: Math.min(Number(req.headers['content-length']) || cfg.uploadVideoMaxBytes, cfg.uploadVideoMaxBytes) });
      if (!video) await readRaw(req, res, cfg.uploadMaxBytes);
    } catch (err) {
      await arrived();
      throw err;
    }
    if (!video && (!Buffer.isBuffer(req.body) || req.body.length < 500)) {
      await arrived();
      throw bad(400, 'bad_photo', 'That file could not be read as a photo.');
    }
    let name: string | null = null;
    try {
      name = decodeURIComponent(String(req.headers['x-uploader-name'] ?? '')).trim().slice(0, 40) || null;
    } catch {
      name = null;
    }
    let file: string | null = null;
    if (video) {
      file = tempPath(cfg, `upload-${randomUUID()}`);
      try {
        await receiveToFile(req, file, cfg.uploadVideoMaxBytes, `Videos can be up to ${Math.round(cfg.uploadVideoMaxBytes / 1048576)} MB.`);
      } finally {
        await arrived();
      }
    }
    await arrived();
    let out;
    try {
      out = file ? await ingestVideoUpload(ctx, e, g.id, file, mime, name) : await ingestUpload(ctx, e, g.id, req.body, mime, name);
      file = null; // the video's file belongs to the ingest now
    } catch (err: any) {
      if (file) await fs.promises.rm(file, { force: true });
      if (err?.name === 'BadVideoError') throw bad(400, 'bad_video', 'That file could not be read as a video.');
      if (err?.name === 'VideoTooLongError') throw bad(400, 'video_too_long', err.message);
      if (err?.name === 'VideoToolsError') throw bad(503, 'busy', 'Adding videos is not available right now. Try again later.');
      if (/Cannot read this file|unsupported image format|Input buffer/i.test(err?.message ?? '')) throw bad(400, 'bad_photo', 'That file could not be read as a photo.');
      if (err instanceof DriveNotFoundError || err?.name === 'DriveAuthError') {
        // The event folder is gone, or OneDrive needs reconnecting: the organiser sees why on the sync screen.
        ctx.log(`a student's photo could not be saved: ${err.message}`);
        await db.query(`update events set sync_error = $2 where id = $1`, [e.id, err instanceof DriveNotFoundError ? 'The event folder is no longer in OneDrive.' : 'Reconnect OneDrive.']);
        throw bad(503, 'busy', 'Adding photos is not available right now. Try again later.');
      }
      throw err;
    }
    if (out.result === 'limit') throw bad(429, 'limit_reached', `This phone has added ${cfg.uploadsPerPhone} photos to this event, which is the limit.`);
    res.status(out.result === 'added' ? 201 : 200).json({ ...out, uploads_left: Math.max(0, cfg.uploadsPerPhone - g.upload_count - (out.result === 'added' ? 1 : 0)) });
  });

  return r;
}
