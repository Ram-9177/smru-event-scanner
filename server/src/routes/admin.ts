import fs from 'node:fs';
import express from 'express';
import { Router } from '../lib/router.js';
import QRCode from 'qrcode';
import { z } from 'zod';
import { audit, type Ctx } from '../context.js';
import { VISIBLE } from '../db/schema.js';
import { releaseCopies } from '../media/duplicates.js';
import { classify, tempPath } from '../media/files.js';
import { afterHidden, emptyCopyTrash, emptyCopyTrashSoon, legacyPath, removeLegacy } from '../media/copies.js';
import { purgeKeys, warmSoon } from '../media/copyurls.js';
import { kickRebuild } from '../media/rebuild.js';
import { processFound, rereadPhoto } from '../media/process.js';
import { remakeEventCopies } from '../media/upgrade.js';
import { dropFullCopies } from '../media/fullcopy.js';
import { inVideoLine, processFoundVideo } from '../media/video.js';
import { findBursts } from '../media/bursts.js';
import { ingestOrganiserPhoto, ingestOrganiserVideo, uploadTypeOk, videoTypeOk } from '../media/upload.js';
import { mimeOf, rawUnless, receiveToFile } from '../lib/receive.js';
import { randomUUID } from 'node:crypto';
import { DriveNotFoundError } from '../drive/index.js';
import { checkDrive } from '../drive/check.js';
import { bad, parse, slugify } from '../lib/http.js';
import { imageUrl } from '../lib/links.js';
import { hashPassword, verifyPassword } from '../lib/security.js';
import { Limiter } from '../lib/redis.js';
import { backupStatus } from '../backup.js';
import type { Queryable } from '../db/index.js';
import { ensureEventFolder, eventFolderChoices, isReservedFolder } from '../sync/event-folder.js';
import { emptyPeopleTrashLater } from '../people/filing.js';
import { CLOSED_MESSAGE, startSync } from '../sync/sync.js';
import { authRoutes, makeSetPasswordLink, NewPassword, requireAdmin, requireSuper, setAdminCookie, type AdminUser } from './auth.js';
import { campusRoutes } from './campuses.js';
import { EVENT_COLS } from './events-shared.js';
import { peopleRoutes } from './people.js';
import { mediaChanged } from '../media/after.js';
import { activeAlerts, checkAlerts, lastCheckAt, localDay, sendTestEmail } from '../alerts/alerts.js';
import { assertRoomForUploads, storageReport } from '../ops/disk.js';
import { deleteFaceData, FACE_EXPIRY_SQL } from '../ops/expiry.js';

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'use YYYY-MM-DD');
const EventIn = z.object({
  title: z.string().trim().min(2).max(120),
  starts_on: day.nullable().optional(),
  ends_on: day.nullable().optional(),
  venue: z.string().trim().max(120).nullable().optional(),
  /** Album passcode: a string sets it, null removes it. */
  passcode: z.string().trim().min(4).max(32).nullable().optional(),
  allow_download: z.boolean().optional(),
  face_enabled: z.boolean().optional(),
  listed: z.boolean().optional(),
  crowd_uploads: z.boolean().optional(),
  auto_approve: z.boolean().optional(),
  /** Improve photos: a dark or flat photo gets a gentle fix in the album and in its full-quality download (on by default). */
  improve_photos: z.boolean().optional(),
  /** The campus the event belongs to (its OneDrive folder is made inside that campus's folder). */
  campus_id: z.string().uuid().nullable().optional(),
  /** "Close the album automatically on": a Live event becomes Closed that morning (ops/expiry.ts). null = never. */
  close_on: day.nullable().optional(),
  /** "Delete face data N days after the event". null = keep it until the event is archived. */
  face_days: z.number().int().min(1).max(3650).nullable().optional(),
});
const EventPatch = EventIn.partial().extend({
  status: z.enum(['draft', 'live', 'closed', 'archived']).optional(),
  onedrive_folder_id: z.string().min(1).nullable().optional(),
  cover_media_id: z.string().uuid().nullable().optional(),
});

const COUNTS = `
  count(*)::int as total,
  (count(*) filter (where m.status = 'found'))::int as waiting,
  (count(*) filter (where m.status = 'processing'))::int as processing,
  (count(*) filter (where m.status = 'failed'))::int as failed,
  (count(*) filter (where m.status = 'skipped'))::int as skipped,
  (count(*) filter (where m.status = 'ready' and m.duplicate_of is not null))::int as copies,
  (count(*) filter (where ${VISIBLE}))::int as shown,
  (count(*) filter (where m.status = 'ready' and m.duplicate_of is null and m.review = 'pending'))::int as review,
  (count(*) filter (where m.status = 'ready' and m.duplicate_of is null and m.hidden))::int as hidden,
  (coalesce(sum(m.face_count) filter (where ${VISIBLE}), 0))::int as faces,
  (count(*) filter (where ${VISIBLE} and m.face_count = 0))::int as no_faces,
  (count(*) filter (where m.copies_lost))::int as lost`;

const FILTERS: Record<string, string> = {
  all: 'true',
  shown: VISIBLE,
  review: `m.status = 'ready' and m.duplicate_of is null and m.review = 'pending'`,
  duplicates: `m.duplicate_of is not null`,
  failed: `m.status = 'failed'`,
  skipped: `m.status = 'skipped'`,
  hidden: `m.hidden`,
  nofaces: `${VISIBLE} and m.face_count = 0`,
  /** Copies that cannot be made in OneDrive (the original is gone), or keep failing. */
  lost: `(m.copies_lost or (m.copies_error is not null and m.copies_tries >= 3))`,
};

export function adminRoutes(ctx: Ctx): Router {
  const { db, cfg } = ctx;
  const r = Router();
  const me = (res: any) => res.locals.admin as AdminUser;

  async function eventOr404(id: string): Promise<any> {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw bad(404, 'not_found', 'Event not found.');
    const e = (await db.query(`select ${EVENT_COLS} from events e where e.id = $1 and e.org_id = $2`, [id, ctx.orgId])).rows[0];
    if (!e) throw bad(404, 'not_found', 'Event not found.');
    return e;
  }

  async function adminEvent(e: any): Promise<any> {
    const counts = (await db.query(`select ${COUNTS} from media m where m.event_id = $1`, [e.id])).rows[0];
    // A few frames for the event's card in the console: the chosen cover first, then the earliest photos. Organiser
    // links, so a draft event's photos show too.
    const frames = await db.query<{ id: string }>(
      `select m.id from media m where m.event_id = $1 and ${VISIBLE}
        order by (m.id = $2) desc, m.taken_at nulls last, m.created_at, m.id limit 4`,
      [e.id, e.cover_media_id],
    );
    // "Closed more than 90 days ago. Face data is still kept." on the events list.
    const reminder = (
      await db.query<{ r: boolean }>(
        `select (e.status = 'closed' and coalesce(e.ends_on, e.starts_on, e.created_at::date) < current_date - 90 and e.face_deleted_at is null
                 and (exists (select 1 from faces f where f.event_id = e.id)
                      or exists (select 1 from guests g where g.event_id = e.id and g.keep_updated and g.embedding is not null))) as r
           from events e where e.id = $1`,
        [e.id],
      )
    ).rows[0];
    const { onedrive_folder_id, onedrive_folder_name, cover_media_id, ...rest } = e;
    return {
      ...rest,
      face_reminder: !!reminder?.r,
      folder: onedrive_folder_id ? { id: onedrive_folder_id, name: onedrive_folder_name } : null,
      cover_media_id,
      strip: frames.rows.map((m) => imageUrl(cfg, m.id, 't', true)),
      syncing: ctx.syncing.has(e.id),
      counts,
      link: `${cfg.publicUrl}/e/${e.slug}`,
    };
  }

  // ---- sign in, sign out, forgotten password (routes/auth.ts) -----------------------
  r.use(authRoutes(ctx));

  r.use(requireAdmin(ctx));
  r.use(campusRoutes(ctx));
  r.use(peopleRoutes(ctx));

  r.get('/me', async (_req, res) => {
    const org = (await db.query(`select name from orgs where id = $1`, [ctx.orgId])).rows[0];
    res.json({ user: me(res), org: org?.name, public_url: cfg.publicUrl, drive: ctx.drive.kind, face_service: await ctx.face.health(), contact: cfg.contact || null });
  });

  // ---- my password, and the team (super admin) -----------------------------------
  /**
   * The org's super admins, locked (FOR UPDATE) until the transaction ends. A change that could take away a super
   * admin reads them this way, so two such changes at once wait for each other and the second one sees the first:
   * they cannot both see "two super admins" and leave none.
   */
  const lockSupers = async (tx: Queryable) => (await tx.query<{ id: string }>(`select id from users where org_id = $1 and role = 'super_admin' order by id for update`, [ctx.orgId])).rows.map((x) => x.id);
  // Wrong current passwords in "Change my password": five in 15 minutes, then wait (counted per account).
  const passwordTries = new Limiter(ctx.redis, 'password-change', 5, 15 * 60);
  const member = async (id: string) => {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw bad(404, 'not_found', 'That person is not in the team.');
    const u = (await db.query<any>(`select id, email, role from users where id = $1 and org_id = $2`, [id, ctx.orgId])).rows[0];
    if (!u) throw bad(404, 'not_found', 'That person is not in the team.');
    return u;
  };

  r.post('/password', async (req, res) => {
    const b = parse(z.object({ current: z.string().min(1), password: NewPassword }), req.body);
    // Counted before the check, so a stolen session cannot be used to guess the password at full speed.
    if (!(await passwordTries.allow(me(res).id))) throw bad(429, 'slow_down', 'Too many wrong passwords. Wait 15 minutes and try again.');
    const u = (await db.query<any>(`select password_hash from users where id = $1`, [me(res).id])).rows[0];
    if (!u || !(await verifyPassword(b.current, u.password_hash))) throw bad(403, 'wrong_password', 'The current password is not right.');
    await passwordTries.clear(me(res).id);
    const hash = await hashPassword(b.password);
    await db.query(`update users set password_hash = $2 where id = $1`, [me(res).id, hash]);
    setAdminCookie(ctx, req, res, me(res), hash); // this browser stays signed in; every other session of this account ends
    await audit(ctx, me(res).email, 'password.change');
    res.json({ ok: true });
  });

  r.get('/team', requireSuper, async (_req, res) => {
    const rows = await db.knex('users').select('id', 'email', 'role', 'created_at', 'last_sign_in_at').where({ org_id: ctx.orgId }).orderBy([{ column: 'created_at' }, { column: 'email' }]);
    res.json({ team: rows });
  });

  r.post('/team', requireSuper, async (req, res) => {
    const b = parse(z.object({ email: z.string().trim().toLowerCase().email('that is not an email address'), password: NewPassword, role: z.enum(['organiser', 'super_admin']).optional() }), req.body);
    if ((await db.query(`select 1 from users where email = $1`, [b.email])).rows.length) throw bad(409, 'exists', 'That email address already has an account.');
    const password_hash = await hashPassword(b.password);
    const [row] = await db.knex('users').insert({ org_id: ctx.orgId, email: b.email, password_hash, role: b.role ?? 'organiser' }).returning(['id', 'email', 'role', 'created_at']);
    await audit(ctx, me(res).email, 'team.add', row.id, { email: row.email, role: row.role });
    // An email with the address to sign in at and a link to choose their own password (24 hours, once).
    // The password the super admin typed is never emailed.
    const link = await makeSetPasswordLink(ctx, { id: row.id, password_hash }, 24 * 3600);
    const org = (await db.knex('orgs').select('name').where({ id: ctx.orgId }).first())?.name ?? cfg.orgName;
    const emailed = await ctx.mailer.send({
      to: row.email,
      subject: `You can now manage event photos for ${org}`,
      text: [
        'Hello,',
        '',
        `${me(res).email} added you to Event Photos for ${org} as ${row.role === 'super_admin' ? 'a super admin' : 'an organiser'}.`,
        '',
        `Sign in at ${cfg.publicUrl}/admin with ${row.email}.`,
        '',
        'Choose your own password with this link. It works once, for 24 hours:',
        link,
        ...(cfg.sso.enabled ? ['', `If ${row.email} is your college Microsoft 365 account, you can also press "Sign in with Microsoft".`] : []),
      ].join('\n'),
    });
    res.status(201).json({ member: row, emailed });
  });

  r.patch('/team/:id', requireSuper, async (req, res) => {
    const u = await member(String(req.params.id));
    const b = parse(z.object({ password: NewPassword.optional(), role: z.enum(['organiser', 'super_admin']).optional() }), req.body);
    const password_hash = b.password ? await hashPassword(b.password) : undefined; // slow: done before the lock
    await db.tx(async (tx) => {
      const supers = await lockSupers(tx);
      if (b.role === 'organiser' && supers.includes(u.id) && supers.length <= 1) throw bad(400, 'last_super_admin', 'There has to be one super admin. Make someone else a super admin first.');
      if (password_hash) await tx.query(`update users set password_hash = $2 where id = $1`, [u.id, password_hash]);
      if (b.role) await tx.query(`update users set role = $2 where id = $1`, [u.id, b.role]);
    });
    await audit(ctx, me(res).email, 'team.update', u.id, { email: u.email, password: b.password ? 'reset' : undefined, role: b.role });
    res.json({ ok: true });
  });

  r.delete('/team/:id', requireSuper, async (req, res) => {
    const u = await member(String(req.params.id));
    if (u.id === me(res).id) throw bad(400, 'yourself', 'You cannot remove your own account.');
    // Added again at every start while it is in the settings: removing it here would not last.
    if (u.email === ctx.cfg.adminEmail) {
      throw bad(400, 'settings_organiser', 'This organiser is set in the server settings (ADMIN_EMAIL). Change ADMIN_EMAIL there to remove them.');
    }
    await db.tx(async (tx) => {
      const supers = await lockSupers(tx);
      if (supers.includes(u.id) && supers.length <= 1) throw bad(400, 'last_super_admin', 'There has to be one super admin.');
      await tx.query(`delete from users where id = $1`, [u.id]);
    });
    await audit(ctx, me(res).email, 'team.remove', u.id, { email: u.email });
    res.json({ ok: true });
  });

  // ---- events ----------------------------------------------------------------
  r.get('/events', async (_req, res) => {
    const rows = (await db.query(`select ${EVENT_COLS} from events e where e.org_id = $1 order by e.starts_on desc nulls last, e.created_at desc`, [ctx.orgId])).rows;
    res.json({ events: await Promise.all(rows.map(adminEvent)) });
  });

  const campusOk = async (id: string | null | undefined) => {
    if (id && !(await db.knex('campuses').where({ id, org_id: ctx.orgId }).first())) throw bad(400, 'no_campus', 'That campus does not exist.');
  };

  r.post('/events', async (req, res) => {
    const b = parse(EventIn, req.body);
    await campusOk(b.campus_id);
    const base = slugify(b.title);
    let slug = base;
    for (let n = 2; (await db.query(`select 1 from events where slug = $1`, [slug])).rows.length; n++) slug = `${base}-${n}`;
    const row = (
      await db.query<{ id: string }>(
        `insert into events (org_id, slug, title, starts_on, ends_on, venue, album_passcode_hash, allow_download, face_enabled, listed, crowd_uploads, auto_approve, face_model, campus_id, improve_photos, close_on, face_days)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17) returning id`,
        [
          ctx.orgId,
          slug,
          b.title,
          b.starts_on ?? null,
          b.ends_on ?? null,
          b.venue || null,
          b.passcode ? await hashPassword(b.passcode) : null,
          b.allow_download ?? true,
          b.face_enabled ?? true,
          b.listed ?? true,
          b.crowd_uploads ?? true,
          b.auto_approve ?? false, // photos from people the organisers do not know wait until an organiser approves them
          ctx.face.model,
          b.campus_id ?? null,
          b.improve_photos ?? true,
          b.close_on ?? null,
          // A new event deletes its face data 90 days after it (FACE_DAYS_DEFAULT) unless the organiser says otherwise.
          b.face_days !== undefined ? b.face_days : cfg.faceDaysDefault || null,
        ],
      )
    ).rows[0];
    await db.query(`update events set face_expiry_at = ${FACE_EXPIRY_SQL} where id = $1`, [row.id]);
    await audit(ctx, me(res).email, 'event.create', row.id, { title: b.title });
    // The event's OneDrive folder is made and linked straight away. If that cannot happen now (OneDrive not
    // connected, Microsoft down), the event is still created and the sync tab offers "Make the folder" again.
    let folderError: string | null = null;
    try {
      const folder = await ensureEventFolder(ctx, row.id);
      await audit(ctx, me(res).email, 'event.folder', row.id, { name: folder.name });
      // A folder of that name that was already there with photos in it is read at once.
      if ((await ctx.drive.children(folder.id)).length) startSync(ctx, row.id);
    } catch (e) {
      folderError = (e as Error).message;
      ctx.log(`the folder for "${b.title}" was not made: ${folderError}`);
    }
    res.status(201).json({ event: await adminEvent(await eventOr404(row.id)), folder_error: folderError });
  });

  /** Make and link the event's OneDrive folder now (when it could not be made at creation). */
  r.post('/events/:id/folder', async (req, res) => {
    const e = await eventOr404(req.params.id);
    const folder = await ensureEventFolder(ctx, e.id);
    if (folder.created) {
      await audit(ctx, me(res).email, 'event.folder', e.id, { name: folder.name });
      if ((e.status === 'draft' || e.status === 'live') && (await ctx.drive.children(folder.id)).length) startSync(ctx, e.id);
    }
    res.json({ event: await adminEvent(await eventOr404(e.id)), created: folder.created });
  });

  r.get('/events/:id', async (req, res) => {
    res.json({ event: await adminEvent(await eventOr404(req.params.id)) });
  });

  r.patch('/events/:id', async (req, res) => {
    const e = await eventOr404(req.params.id);
    const b = parse(EventPatch, req.body);
    const set: string[] = [];
    const params: unknown[] = [e.id];
    const put = (col: string, v: unknown) => {
      params.push(v);
      set.push(`${col} = $${params.length}`);
    };
    await campusOk(b.campus_id);
    for (const k of ['title', 'starts_on', 'ends_on', 'allow_download', 'face_enabled', 'listed', 'crowd_uploads', 'auto_approve', 'improve_photos', 'cover_media_id', 'campus_id', 'close_on', 'face_days'] as const) {
      if (b[k] !== undefined) put(k, b[k]);
    }
    if (b.venue !== undefined) put('venue', b.venue || null);
    if (b.passcode !== undefined) put('album_passcode_hash', b.passcode ? await hashPassword(b.passcode) : null);

    if (b.onedrive_folder_id !== undefined) {
      if (b.onedrive_folder_id === null) {
        put('onedrive_folder_id', null);
        put('onedrive_folder_name', null);
        put('crowd_folder_id', null);
      } else {
        // A folder at the top of Event Photos, or one inside a campus's folder (where a campus's events get theirs).
        const folder = (await eventFolderChoices(ctx)).find((f) => f.id === b.onedrive_folder_id);
        if (!folder) throw bad(400, 'no_such_folder', 'That folder is not inside the Event Photos folder.');
        const taken = (await db.query(`select title from events where onedrive_folder_id = $1 and id <> $2`, [folder.id, e.id])).rows[0];
        if (taken) throw bad(400, 'folder_in_use', `That folder already belongs to "${taken.title}".`);
        put('onedrive_folder_id', folder.id);
        put('onedrive_folder_name', folder.name);
        put('crowd_folder_id', null);
      }
      // Another folder has never been synced: the timer picks it up at its next minute.
      if (b.onedrive_folder_id !== e.onedrive_folder_id) {
        put('last_sync_at', null);
        put('sync_error', null);
        put('sync_failures', 0);
      }
    }

    const status = b.status;
    if (status && status !== e.status) {
      const folderAfter = b.onedrive_folder_id !== undefined ? b.onedrive_folder_id : e.onedrive_folder_id;
      if (status === 'live' && !folderAfter) throw bad(400, 'no_folder', 'Make or pick the event folder before opening the event to students.');
      put('status', status);
      // Opened again by hand after its close day: the close day is used up, or the hourly job would close it again.
      if (status === 'live' && b.close_on === undefined && e.close_on && e.close_on <= localDay(new Date())) put('close_on', null);
      // Brought back from the archive: face search can be restored ("Read every photo again"), unless its face
      // data was due to go anyway, or an organiser deleted it on purpose ("Delete face data now", or the expiry, before
      // the archive: their activity-log line is as new as face_deleted_at or newer). Un-archiving never undoes that.
      if (e.status === 'archived' && e.face_deleted_at) {
        set.push(
          `face_deleted_at = case when (e.face_expiry_at is null or e.face_expiry_at > now())
              and not exists (select 1 from audit_log l where l.target = e.id::text and l.action in ('event.face_delete', 'event.face_expired')
                                and l.created_at >= e.face_deleted_at)
            then null else e.face_deleted_at end`,
        );
      }
    }
    if (set.length) await db.query(`update events e set ${set.join(', ')} where e.id = $1`, params);
    if (b.face_days !== undefined || b.starts_on !== undefined || b.ends_on !== undefined) {
      await db.query(`update events set face_expiry_at = ${FACE_EXPIRY_SQL} where id = $1`, [e.id]);
    }
    if (status === 'archived' && e.status !== 'archived') {
      // Archiving deletes the event's face data (plan: "Face data kept forever"): the face vectors, the students'
      // kept vectors (Keep me updated) and their saved results, so nothing about a person is kept for a closed album.
      await deleteFaceData(ctx, e.id, { results: true });
      // Its copies in the People folders stay as they are (people/filing.ts leaves an archived event alone).
      // Full-quality download copies kept for students go too: an archived album is not downloaded from.
      // So do the location-free video copies (the album's display copies stay).
      await dropFullCopies(ctx, (await db.query<{ id: string }>(`select id from media where event_id = $1`, [e.id])).rows.map((x) => x.id));
      await db.query(`update media set clean_key = null where event_id = $1 and clean_key is not null`, [e.id]);
      emptyCopyTrashSoon(ctx);
    }
    // Improve photos switched: the album's copies are made again from the originals, with or without the fix.
    if (b.improve_photos !== undefined && b.improve_photos !== e.improve_photos) remakeEventCopies(ctx, e.id);
    ctx.bump(e.id);
    await audit(ctx, me(res).email, 'event.update', e.id, { ...b, passcode: b.passcode === undefined ? undefined : b.passcode ? 'set' : 'removed' });
    res.json({ event: await adminEvent(await eventOr404(e.id)) });
  });

  // Deleting an event (its album, faces and requests) is for super admins only; organisers can archive.
  r.delete('/events/:id', requireSuper, async (req, res) => {
    const e = await eventOr404(req.params.id);
    if (ctx.syncing.has(e.id)) throw bad(409, 'sync_running', 'Wait for the sync to finish.');
    // The copies of its photos in the People folders are kept by the database in people_trash as the rows go,
    // and removed from OneDrive in the background (later, if OneDrive cannot be reached now).
    // Its copies in OneDrive's app folder go with it: the whole event folder there in one call, queued in the same
    // transaction as the delete (the rows of its single copies, queued by the database as the media rows go, are
    // dropped when the folder is gone). The originals stay in OneDrive.
    const ids = (await db.query<{ id: string }>(`select id from media where event_id = $1`, [e.id])).rows.map((x) => x.id);
    const folders = (await db.query<{ copies_folders: Record<string, string> }>(`select copies_folders from events where id = $1`, [e.id])).rows[0]?.copies_folders ?? {};
    await db.tx(async (q) => {
      if (folders.event) await q.query(`insert into copy_trash (drive_item_id, folder, event_id) values ($1, true, $2) on conflict (drive_item_id) do update set folder = true, event_id = excluded.event_id`, [folders.event, e.id]);
      await q.query(`delete from events where id = $1`, [e.id]);
    });
    await dropFullCopies(ctx, ids);
    emptyCopyTrashSoon(ctx);
    const legacy = legacyPath(cfg, `media/${e.id}`);
    if (legacy) await fs.promises.rm(legacy, { recursive: true, force: true }); // copies kept on this Mac before OneDrive held them
    emptyPeopleTrashLater(ctx);
    ctx.bump(e.id);
    await audit(ctx, me(res).email, 'event.delete', e.id, { title: e.title });
    res.json({ ok: true });
  });

  /** "Delete face data now": face search ends for the event; the photos and the students' saved results stay. */
  r.post('/events/:id/face-data/delete', async (req, res) => {
    const e = await eventOr404(req.params.id);
    const deleted = e.face_deleted_at ? { faces: 0, kept: 0, results: 0 } : await deleteFaceData(ctx, e.id);
    await audit(ctx, me(res).email, 'event.face_delete', e.id, { title: e.title, faces: deleted.faces, kept: deleted.kept });
    res.json({ event: await adminEvent(await eventOr404(e.id)), deleted });
  });

  // ---- OneDrive ----------------------------------------------------------------
  r.get('/onedrive/status', async (_req, res) => {
    res.json({
      status: await ctx.drive.status(),
      // What the settings screen shows for "connect your real OneDrive".
      setup: { redirect_uri: cfg.ms.redirectUri, https: cfg.publicUrl.startsWith('https://'), may_connect: me(res).role === 'super_admin' },
      // The automatic database backups (backup.ts), for super admins only.
      ...(me(res).role === 'super_admin' ? { backup: backupStatus(cfg) } : {}),
    });
  });

  /** Check everything: real files through every call the app makes, in a test folder that is removed again. */
  r.post('/onedrive/check', async (_req, res) => {
    const out = await checkDrive(ctx);
    await audit(ctx, me(res).email, 'onedrive.check', null, { ok: out.ok });
    res.json(out);
  });

  r.get('/onedrive/folders', async (_req, res) => {
    const used = new Map((await db.query(`select onedrive_folder_id as id, title from events where onedrive_folder_id is not null`)).rows.map((x: any) => [x.id, x.title]));
    const folders = (await eventFolderChoices(ctx)).map((f) => ({ id: f.id, name: f.label, campus: f.campus, used_by: used.get(f.id) ?? null }));
    res.json({ folders });
  });

  r.post('/onedrive/folders', async (req, res) => {
    const { name } = parse(z.object({ name: z.string().trim().min(1).max(100).regex(/^[^\\/:*?"<>|]+$/, 'no special characters').regex(/[^.\s]/, 'give the folder a name') }), req.body);
    if (isReservedFolder(name)) throw bad(400, 'reserved_name', `"${name}" is the app's own folder. Pick another name.`);
    const f = await ctx.drive.createFolder(null, name);
    res.status(201).json({ folder: { id: f.id, name: f.name } });
  });

  /** The Phase 1 check: list a folder, download one photo, save one test file back and remove it. */
  r.post('/onedrive/test', async (req, res) => {
    const { folder_id } = parse(z.object({ folder_id: z.string().min(1).nullable().optional() }), req.body ?? {});
    const steps: { step: string; ok: boolean; detail: string }[] = [];
    const run = async (step: string, fn: () => Promise<string>) => {
      try {
        steps.push({ step, ok: true, detail: await fn() });
        return true;
      } catch (e) {
        steps.push({ step, ok: false, detail: (e as Error).message });
        return false;
      }
    };
    let files: Awaited<ReturnType<typeof ctx.drive.children>> = [];
    const ok =
      (await run('Open the Event Photos folder', async () => {
        const st = await ctx.drive.status();
        if (!st.connected) throw new Error('OneDrive is not connected.');
        const n = (await ctx.drive.children(null)).filter((f) => f.isFolder).length;
        return `${st.rootName}: ${n} folder${n === 1 ? '' : 's'}`;
      })) &&
      (await run('List the files in the folder', async () => {
        files = (await ctx.drive.children(folder_id ?? null)).filter((f) => !f.isFolder);
        return `${files.length} file${files.length === 1 ? '' : 's'}`;
      })) &&
      (await run('Download one photo', async () => {
        const photo = files.find((f) => classify(f.name) === 'photo');
        if (!photo) return 'no photo in this folder yet, skipped';
        const tmp = tempPath(cfg, `test-${Date.now()}`);
        try {
          await ctx.drive.download(photo.id, tmp);
          return `${photo.name}, ${fs.statSync(tmp).size} bytes`;
        } finally {
          fs.rmSync(tmp, { force: true });
        }
      })) &&
      (await run('Save one test file and remove it', async () => {
        const name = `event-photos-test-${Date.now()}.txt`;
        const saved = await ctx.drive.upload(folder_id ?? null, name, Buffer.from('Event Photos connection test. Safe to delete.\n'), 'text/plain');
        await ctx.drive.remove(saved.id);
        return `${name} written and removed`;
      }));
    await audit(ctx, me(res).email, 'onedrive.test', null, { ok });
    res.json({ ok, steps });
  });

  // ---- sync and media (Phase 2) -------------------------------------------------
  r.post('/events/:id/sync', async (req, res) => {
    const e = await eventOr404(req.params.id);
    if (!e.onedrive_folder_id) throw bad(400, 'no_folder', 'Pick the event folder first.');
    if (e.status === 'closed' || e.status === 'archived') throw bad(400, 'closed', CLOSED_MESSAGE);
    const started = startSync(ctx, e.id);
    await audit(ctx, me(res).email, 'event.sync', e.id);
    res.status(202).json({ started, syncing: true });
  });

  /**
   * An organiser adds photos from the admin console, one file per request. Each is saved into the event's
   * OneDrive folder (made now if the event has none yet), checked for copies, and processed like a synced photo.
   */
  // Below TEMP_MIN_FREE_GB free on this Mac an upload is refused before any of it is read (507 disk_full).
  // A video is on this Mac while it is read: room for about 2.3 times its size (from Content-Length) on top.
  const roomForUploads = async (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    const video = videoTypeOk(mimeOf(req));
    const bytes = Number(req.headers['content-length']) || cfg.adminVideoMaxBytes;
    await assertRoomForUploads(cfg, 'organiser', video ? { video: true, bytes: Math.min(bytes, cfg.adminVideoMaxBytes) } : {});
    next();
  };
  r.post('/events/:id/photos', roomForUploads, rawUnless(videoTypeOk, cfg.adminUploadMaxBytes), async (req, res) => {
    const e = await eventOr404(req.params.id);
    if (!(e.status === 'draft' || e.status === 'live')) throw bad(400, 'closed', 'Photos can be added while the event is Draft or Live.');
    const mime = mimeOf(req);
    // Videos are not held in memory: the body streams to a file here (up to ADMIN_VIDEO_MAX_MB), then into OneDrive in pieces.
    const video = videoTypeOk(mime);
    if (!video && !uploadTypeOk(mime)) throw bad(415, 'unsupported', 'Photos (JPG, PNG, WebP or iPhone HEIC) or videos (MP4, MOV, WebM, MKV or 3GP) only.');
    if (!video && (!Buffer.isBuffer(req.body) || req.body.length < 500)) throw bad(400, 'bad_photo', 'That file could not be read as a photo.');
    let fileName: string | null = null;
    try {
      fileName = decodeURIComponent(String(req.headers['x-file-name'] ?? '')).slice(0, 200) || null;
    } catch {
      fileName = null;
    }
    const folder = await ensureEventFolder(ctx, e.id);
    if (folder.created) await audit(ctx, me(res).email, 'event.folder', e.id, { name: folder.name });
    const ev = { ...e, onedrive_folder_id: folder.id };
    let file: string | null = null;
    if (video) {
      file = tempPath(cfg, `upload-${randomUUID()}`);
      await receiveToFile(req, file, cfg.adminVideoMaxBytes, `Videos can be up to ${Math.round(cfg.adminVideoMaxBytes / 1048576)} MB.`);
    }
    let out;
    try {
      out = file ? await ingestOrganiserVideo(ctx, ev, file, mime, me(res).email, fileName) : await ingestOrganiserPhoto(ctx, ev, req.body, mime, me(res).email, fileName);
      file = null; // the video's file belongs to the ingest now
    } catch (err: any) {
      if (file) await fs.promises.rm(file, { force: true });
      if (err?.name === 'BadVideoError') throw bad(400, 'bad_video', 'That file could not be read as a video.');
      if (err?.name === 'VideoTooLongError') throw bad(400, 'video_too_long', err.message);
      if (err?.name === 'VideoToolsError') throw bad(503, 'busy', 'Videos cannot be read on this server right now (ffmpeg is missing).');
      if (/Cannot read this file|unsupported image format|Input buffer/i.test(err?.message ?? '')) throw bad(400, 'bad_photo', 'That file could not be read as a photo.');
      if (err instanceof DriveNotFoundError) {
        const why = 'The event folder is no longer in OneDrive. Pick or make one on the OneDrive sync tab.';
        await db.query(`update events set sync_error = $2 where id = $1`, [e.id, why]);
        throw bad(409, 'folder_gone', why);
      }
      if (err?.name === 'DriveAuthError') throw bad(503, 'reconnect', 'OneDrive needs to be connected again (Settings, OneDrive).');
      if (err?.name === 'DriveDownError') throw bad(503, 'drive_down', err.message);
      throw err;
    }
    if (out.result === 'added') {
      ctx.bump(e.id);
      await audit(ctx, me(res).email, 'media.upload', e.id, { name: fileName });
    }
    res.status(out.result === 'added' ? 201 : 200).json(out);
  });

  /** Look through the event's shown photos for the same shot taken twice (for photos that were there before the rule). */
  r.post('/events/:id/duplicates', async (req, res) => {
    const e = await eventOr404(req.params.id);
    const copies = await findBursts(ctx, e.id);
    await audit(ctx, me(res).email, 'media.duplicates', e.id, { count: copies });
    res.json({ copies, event: await adminEvent(await eventOr404(e.id)) });
  });

  r.get('/events/:id/progress', async (req, res) => {
    const e = await eventOr404(req.params.id);
    const counts = (await db.query(`select ${COUNTS} from media m where m.event_id = $1`, [e.id])).rows[0];
    res.json({ syncing: ctx.syncing.has(e.id), last_sync_at: e.last_sync_at, sync_error: e.sync_error, counts });
  });

  r.get('/events/:id/media', async (req, res) => {
    const e = await eventOr404(req.params.id);
    const q = parse(z.object({ filter: z.string().optional(), offset: z.coerce.number().int().min(0).optional(), limit: z.coerce.number().int().min(1).max(200).optional() }), req.query);
    const where = FILTERS[q.filter ?? 'all'];
    if (!where) throw bad(400, 'invalid_input', 'Unknown filter.');
    const rows = (
      await db.query(
        `select m.id, m.name, m.type, m.status, m.status_reason, m.review, m.hidden, m.source, m.duplicate_of, m.face_count, m.width, m.height,
                m.taken_at, m.uploader_name, m.thumb_key, m.web_key, m.duration_ms, m.video_key, m.copies_lost, m.copies_error,
                (select k.name from media k where k.id = m.duplicate_of) as copy_of_name
           from media m where m.event_id = $1 and ${where}
          order by m.taken_at nulls last, m.name, m.id offset $2 limit $3`,
        [e.id, q.offset ?? 0, q.limit ?? 60],
      )
    ).rows;
    const total = (await db.query<{ n: number }>(`select count(*)::int as n from media m where m.event_id = $1 and ${where}`, [e.id])).rows[0].n;
    if (rows.length) warmSoon(ctx, e.id, 't');
    res.json({
      total,
      media: rows.map(({ thumb_key, web_key, video_key, duration_ms, ...m }: any) => ({
        ...m,
        type: m.type === 'video' ? 'video' : 'photo',
        duration_ms: m.type === 'video' ? (duration_ms ?? null) : null,
        copies_lost: !!m.copies_lost,
        copies_error: m.copies_error ?? null,
        thumb: thumb_key ? imageUrl(cfg, m.id, 't', true) : null,
        web: web_key ? imageUrl(cfg, m.id, 'w', true) : null,
        video: m.type === 'video' && video_key ? imageUrl(cfg, m.id, 'v', true) : null,
      })),
    });
  });

  r.post('/events/:id/retry', async (req, res) => {
    const e = await eventOr404(req.params.id);
    if (e.status === 'closed' || e.status === 'archived') throw bad(400, 'closed', CLOSED_MESSAGE);
    const n = (await db.query(`update media set status = 'found', status_reason = null where event_id = $1 and status = 'failed' and type in ('photo', 'video')`, [e.id])).rowCount;
    const started = n > 0 && startSync(ctx, e.id);
    res.status(202).json({ retrying: n, started });
  });

  /**
   * Read every photo again: fresh display copies and face vectors for every shown photo, from the originals in OneDrive.
   * For after a change to the face code or its settings, and after un-archiving. What is hidden or marked as a copy stays as it is.
   */
  r.post('/events/:id/reread', async (req, res) => {
    const e = await eventOr404(String(req.params.id));
    if (!e.onedrive_folder_id) throw bad(400, 'no_folder', 'Pick the event folder first.');
    if (ctx.syncing.has(e.id)) throw bad(409, 'sync_running', 'Wait for the sync to finish.');
    if (!(await ctx.face.health())) throw bad(503, 'busy', 'The face service is not running. Start it first.');
    const ids = (await db.query<{ id: string }>(`select id from media where event_id = $1 and status = 'ready' and duplicate_of is null and type = 'photo' and onedrive_item_id is not null order by created_at, id`, [e.id])).rows.map((x) => x.id);
    ctx.syncing.add(e.id);
    void (async () => {
      let stop: unknown = null;
      try {
        await Promise.all(
          ids.map((id) =>
            ctx.work.push(async () => {
              if (stop) return;
              try {
                await rereadPhoto(ctx, id);
              } catch (err) {
                if (['DriveAuthError', 'DriveDownError', 'FaceDownError'].includes((err as Error)?.name)) stop ??= err;
                else ctx.log(`could not read a photo again: ${(err as Error).message}`);
              }
            }),
          ),
        );
        await db.query(`update events set sync_error = $2 where id = $1`, [e.id, stop ? String((stop as Error).message).slice(0, 300) : null]);
      } finally {
        ctx.syncing.delete(e.id);
        ctx.bump(e.id);
      }
    })();
    await audit(ctx, me(res).email, 'event.reread', e.id, { photos: ids.length });
    res.status(202).json({ photos: ids.length });
  });

  // ---- media manager: hide, review, copies (Phases 4 and 5) ----------------------
  r.patch('/media', async (req, res) => {
    const b = parse(
      z.object({ ids: z.array(z.string().uuid()).min(1).max(500), action: z.enum(['hide', 'unhide', 'approve', 'reject', 'show_anyway', 'rebuild']) }),
      req.body,
    );
    const marks = b.ids.map((_, i) => `$${i + 2}`).join(', ');
    const rows = (
      await db.query<any>(
        `select m.id, m.event_id, m.type, m.source, m.review, m.hidden, m.duplicate_of, m.onedrive_item_id, m.thumb_key, m.web_key, m.video_key, m.scene_key, m.clean_key, m.status
           from media m join events e on e.id = m.event_id where e.org_id = $1 and m.id in (${marks})`,
        [ctx.orgId, ...b.ids],
      )
    ).rows;
    let changed = 0;
    const touched = new Set<string>(); // the photos really changed: for a copy, the one shown in its place
    const hidden: string[] = []; // photos just hidden: their links stop (rekeyCopies)
    let rejected = false;
    for (const m of rows) {
      if (b.action === 'hide' || b.action === 'unhide') {
        // Hide works on the picture: for a photo marked as a copy, the photo that is shown is the one hidden.
        const target: string = m.duplicate_of ?? m.id;
        const n = (await db.query(`update media set hidden = $2 where id = $1 and hidden <> $2`, [target, b.action === 'hide'])).rowCount;
        if (n) touched.add(target);
        if (n && b.action === 'hide') hidden.push(target);
        changed += n;
      } else if (b.action === 'approve') {
        changed += (await db.query(`update media set review = 'approved' where id = $1 and review = 'pending'`, [m.id])).rowCount;
      } else if (b.action === 'reject') {
        // Only a student's photo can be rejected. The app never deletes files you put in OneDrive.
        if (m.source !== 'crowd' || m.review === 'rejected') continue;
        // The copies it has at this moment (an album remake may have just put new ones in place) are the ones that go.
        const had = await ctx.eventLock.run(m.event_id, () =>
          db.tx(async (q) => {
            const cur = (await q.query<{ thumb_key: string | null; web_key: string | null; video_key: string | null }>(`select thumb_key, web_key, video_key from media where id = $1 for update`, [m.id])).rows[0];
            await releaseCopies(q, m.id, m.hidden);
            await q.query(`delete from faces where media_id = $1`, [m.id]);
            await q.query(`delete from matches where media_id = $1`, [m.id]);
            // The row and its two fingerprints stay, so the same picture is refused if it is sent again. Every copy of
            // it in OneDrive is queued for deletion by the database, in this transaction.
            await q.query(
              `update media set review = 'rejected', thumb_key = null, web_key = null, video_key = null, scene_key = null, clean_key = null, face_count = null where id = $1`,
              [m.id],
            );
            await q.query(`delete from full_copies where media_id = $1`, [m.id]);
            return cur;
          }),
        );
        if (m.onedrive_item_id) {
          // The file's ID is forgotten only once the file is really gone. Until then the sync job knows the file
          // and tries the delete again, so a rejected photo can never come back in as a new one.
          try {
            await ctx.drive.remove(m.onedrive_item_id);
            await db.query(`update media set onedrive_item_id = null, ctag = null where id = $1`, [m.id]);
          } catch (e) {
            ctx.log(`could not delete a rejected upload from the drive yet: ${(e as Error).message}`);
          }
        }
        // A link already handed out stops now: the copies leave OneDrive within this request (best effort; the trash
        // keeps what could not go yet).
        await purgeKeys(ctx, [m.thumb_key, m.web_key, m.video_key, m.scene_key, m.clean_key, had?.thumb_key, had?.web_key, had?.video_key]);
        await removeLegacy(cfg, [m.thumb_key, m.web_key, m.video_key, had?.thumb_key, had?.web_key, had?.video_key]);
        await dropFullCopies(ctx, [m.id]);
        rejected = true;
        changed++;
      } else if (b.action === 'rebuild') {
        // "Try again": its copies are made again from the original (the rebuild job).
        changed += (
          await db.query(
            `update media set copies_missing = copies_missing or copies_lost or copies_tries >= 3, copies_lost = false, copies_tries = 0, copies_error = null, clean_tries = 0
              where id = $1 and (copies_lost or copies_tries > 0 or copies_error is not null or clean_tries > 0)`,
            [m.id],
          )
        ).rowCount;
      } else if (b.action === 'show_anyway') {
        if (!m.duplicate_of) continue;
        await db.query(
          `update media set duplicate_of = null, keep_both = true,
                  status = case when web_key is null and status = 'ready' then 'found' else status end
            where id = $1`,
          [m.id],
        );
        // A copy has no web copy (and a video no preview): it is processed again, a video in the video line.
        if (m.type === 'video' ? !m.video_key || !m.web_key : !m.web_key) {
          const job = m.type === 'video' ? inVideoLine(() => processFoundVideo(ctx, m.id)) : ctx.work.push(() => processFound(ctx, m.id));
          void job.catch((e) => ctx.log(`show anyway: ${(e as Error).message}`));
        }
        changed++;
      }
    }
    if (rejected) {
      try {
        await emptyCopyTrash(ctx);
      } catch (e) {
        ctx.log(`the copies of a rejected upload could not be removed from OneDrive yet: ${(e as Error).message}`);
      }
    }
    // New links stop at once; links already handed out die when the copies get new names (in the background).
    await afterHidden(ctx, hidden);
    if (b.action === 'rebuild' && changed) kickRebuild(ctx);
    for (const id of new Set(rows.map((m) => m.event_id as string))) ctx.bump(id);
    await audit(ctx, me(res).email, `media.${b.action}`, null, { count: changed, ids: b.ids.slice(0, 20) });
    await mediaChanged(ctx, [...new Set([...b.ids, ...touched])]); // People folders follow what is shown
    res.json({ changed });
  });

  r.post('/events/:id/approve-all', async (req, res) => {
    const e = await eventOr404(req.params.id);
    const ids = (await db.query<{ id: string }>(`update media set review = 'approved' where event_id = $1 and review = 'pending' returning id`, [e.id])).rows.map((x) => x.id);
    const n = ids.length;
    ctx.bump(e.id);
    await mediaChanged(ctx, ids);
    await audit(ctx, me(res).email, 'media.approve_all', e.id, { count: n });
    res.json({ approved: n });
  });

  // ---- reports and removal requests ------------------------------------------------
  r.get('/requests', async (req, res) => {
    const status = req.query.status === 'all' ? null : 'open';
    const rows = (
      await db.query(
        `select q.id, q.kind, q.reason, q.status, q.created_at, q.resolved_at, q.media_id, e.id as event_id, e.title as event_title,
                m.name as media_name, m.hidden as media_hidden, m.thumb_key, m.type as media_type, m.video_key
           from requests q join events e on e.id = q.event_id left join media m on m.id = q.media_id
          where e.org_id = $1 and ($2::text is null or q.status = $2)
          order by q.created_at desc limit 200`,
        [ctx.orgId, status],
      )
    ).rows;
    // The photos a removal request ("Remove me") lists, in time order.
    const listed = new Map<string, any[]>();
    const removals = rows.filter((q: any) => q.kind === 'removal').map((q: any) => q.id);
    if (removals.length) {
      const rm = (
        await db.query<any>(
          `select rm.request_id, m.id, m.type, m.thumb_key, m.web_key, m.video_key, m.hidden
             from request_media rm join media m on m.id = rm.media_id
            where rm.request_id = any($1::uuid[])
            order by m.taken_at nulls last, m.name, m.id`,
          [removals],
        )
      ).rows;
      for (const m of rm) listed.set(m.request_id, [...(listed.get(m.request_id) ?? []), m]);
    }
    const photo = (m: any) => ({
      id: m.id,
      type: m.type === 'video' ? 'video' : 'photo',
      thumb: m.thumb_key ? imageUrl(cfg, m.id, 't', true) : null,
      web: m.thumb_key || m.web_key ? imageUrl(cfg, m.id, 'w', true) : null,
      video: m.type === 'video' && m.video_key ? imageUrl(cfg, m.id, 'v', true) : null,
      hidden: !!m.hidden,
    });
    res.json({
      requests: rows.map(({ thumb_key, video_key, ...q }: any) => {
        const photos =
          q.kind === 'removal'
            ? (listed.get(q.id) ?? []).map(photo)
            : q.media_id
              ? [photo({ id: q.media_id, type: q.media_type, thumb_key, web_key: thumb_key, video_key, hidden: q.media_hidden })]
              : [];
        return {
          ...q,
          thumb: thumb_key ? imageUrl(cfg, q.media_id, 't', true) : null,
          web: thumb_key ? imageUrl(cfg, q.media_id, 'w', true) : null,
          video: video_key ? imageUrl(cfg, q.media_id, 'v', true) : null,
          count: photos.length,
          photos,
        };
      }),
    });
  });

  r.patch('/requests/:id', async (req, res) => {
    const { status } = parse(z.object({ status: z.enum(['approved', 'declined']) }), req.body);
    if (!/^[0-9a-f-]{36}$/.test(req.params.id)) throw bad(404, 'not_found', 'Request not found.');
    const q = (await db.query<any>(`select q.id, q.kind, q.media_id, q.event_id from requests q join events e on e.id = q.event_id where q.id = $1 and e.org_id = $2`, [req.params.id, ctx.orgId])).rows[0];
    if (!q) throw bad(404, 'not_found', 'Request not found.');
    if (q.kind === 'removal') {
      // "Remove me": Remove from album hides every photo the request lists (the one shown, if it has become a copy),
      // as Hide does; Keep photos changes nothing in the album.
      const result = await db.tx(async (tx) => {
        const targets = (
          await tx.query<{ id: string }>(
            `select distinct coalesce(m.duplicate_of, m.id) as id from request_media rm join media m on m.id = rm.media_id where rm.request_id = $1`,
            [q.id],
          )
        ).rows.map((x) => x.id);
        const changed =
          status === 'approved' && targets.length
            ? (await tx.query<{ id: string }>(`update media set hidden = true where id = any($1::uuid[]) and not hidden returning id`, [targets])).rows.map((x) => x.id)
            : [];
        await tx.query(`update requests set status = $2, resolved_by = $3, resolved_at = now() where id = $1`, [q.id, status, me(res).id]);
        return { targets, changed };
      });
      await afterHidden(ctx, result.changed); // links already handed out stop too, as with Hide
      ctx.bump(q.event_id);
      await audit(ctx, me(res).email, `request.${status}`, q.id, { kind: 'removal', count: result.targets.length });
      await mediaChanged(ctx, result.changed); // hidden photos leave the People folders too
      return res.json({ ok: true, hidden: status === 'approved' ? result.targets.length : 0 });
    }
    // One tap takes the picture down. If the reported photo has since become a copy, the photo shown in its place is the one hidden.
    const hid =
      status === 'approved' && q.media_id
        ? (await db.query<{ id: string }>(`update media set hidden = true where id = (select coalesce(duplicate_of, id) from media where id = $1) returning id`, [q.media_id])).rows.map((x) => x.id)
        : [];
    await db.query(`update requests set status = $2, resolved_by = $3, resolved_at = now() where id = $1`, [q.id, status, me(res).id]);
    await afterHidden(ctx, hid); // links already handed out stop too, as with Hide
    ctx.bump(q.event_id);
    await audit(ctx, me(res).email, `request.${status}`, q.id, { media_id: q.media_id });
    await mediaChanged(ctx, hid); // the picture taken down leaves the People folders too
    res.json({ ok: true });
  });

  // ---- alerts and storage (Settings > Alerts and storage) ------------------------------
  r.get('/alerts', async (_req, res) => {
    // The console asks every minute: look again when the last look is older than that (one look at a time).
    if (Date.now() - lastCheckAt(ctx) > 60_000) {
      try {
        await checkAlerts(ctx);
      } catch (e) {
        ctx.log(`alerts: ${(e as Error).message}`);
      }
    }
    res.json({ alerts: await activeAlerts(ctx, me(res)) });
  });

  const alertSettings = async (user: AdminUser) => {
    const u = (await db.query<{ email: string; alert_emails: boolean }>(`select email, alert_emails from users where id = $1`, [user.id])).rows[0];
    return { smtp: ctx.mailer.configured, email_alerts: !!u?.alert_emails, email: u?.email ?? user.email, digest_hour: cfg.alerts.digestHour >= 0 ? cfg.alerts.digestHour : null };
  };

  r.get('/alerts/settings', requireSuper, async (_req, res) => {
    res.json(await alertSettings(me(res)));
  });

  r.patch('/alerts/settings', requireSuper, async (req, res) => {
    const b = parse(z.object({ email_alerts: z.boolean() }), req.body);
    await db.query(`update users set alert_emails = $2 where id = $1`, [me(res).id, b.email_alerts]);
    await audit(ctx, me(res).email, 'alerts.settings', me(res).id, b);
    res.json(await alertSettings(me(res)));
  });

  // "Send a test email": five an hour per person.
  const testEmails = new Limiter(ctx.redis, 'alert-test-email', 5, 3600);
  r.post('/alerts/test', requireSuper, async (_req, res) => {
    if (!ctx.mailer.configured) throw bad(409, 'no_smtp', 'Email is not set up on this server. Set SMTP_URL in server/.env and restart.');
    if (!(await testEmails.allow(me(res).id))) throw bad(429, 'slow_down', 'That is a lot of test emails. Try again later.');
    const to = me(res).email;
    if (!(await sendTestEmail(ctx, to))) throw bad(502, 'send_failed', 'The email could not be sent. Check SMTP_URL in server/.env.');
    res.json({ sent: true, to });
  });

  r.get('/storage', requireSuper, async (_req, res) => {
    res.json(await storageReport(ctx));
  });

  r.get('/audit', async (_req, res) => {
    const rows = (await db.query(`select actor, action, target, detail, created_at from audit_log order by id desc limit 200`)).rows;
    res.json({ entries: rows });
  });

  // ---- the one QR --------------------------------------------------------------
  /** The QR of one event's own link (/e/<event>), to print on that event's posters. */
  r.get('/events/:id/qr', async (req, res) => {
    const e = await eventOr404(req.params.id);
    const link = `${cfg.publicUrl}/e/${e.slug}`;
    if (req.query.format === 'png') {
      res.type('png').setHeader('Content-Disposition', `inline; filename="${e.slug}-qr.png"`);
      res.send(await QRCode.toBuffer(link, { type: 'png', width: 1200, margin: 2, errorCorrectionLevel: 'M' }));
    } else {
      res.type('image/svg+xml').setHeader('Content-Disposition', `inline; filename="${e.slug}-qr.svg"`);
      res.send(await QRCode.toString(link, { type: 'svg', margin: 2, errorCorrectionLevel: 'M' }));
    }
  });

  /** An organiser downloads the original of any photo or video of the college: a fresh OneDrive link. */
  r.get('/media/:id/original', async (req, res) => {
    if (!/^[0-9a-f-]{36}$/.test(req.params.id)) throw bad(404, 'not_found', 'Not found.');
    const m = (await db.query<any>(`select m.id, m.name, m.onedrive_item_id from media m join events e on e.id = m.event_id where m.id = $1 and e.org_id = $2`, [req.params.id, ctx.orgId])).rows[0];
    if (!m) throw bad(404, 'not_found', 'Not found.');
    if (!m.onedrive_item_id) throw bad(410, 'original_gone', 'The original is no longer in OneDrive.');
    try {
      const url = await ctx.drive.downloadUrl(m.onedrive_item_id);
      if (url) return res.redirect(302, url);
      const tmp = tempPath(cfg, `orig-${m.id}-${Date.now()}`);
      await ctx.drive.download(m.onedrive_item_id, tmp);
      res.download(tmp, m.name ?? 'original', () => fs.rm(tmp, { force: true }, () => {}));
    } catch (err) {
      if (err instanceof DriveNotFoundError) throw bad(410, 'original_gone', 'The original is no longer in OneDrive.');
      throw err;
    }
  });

  /** The one QR (the main link), or with ?campus=<slug> that campus's own QR (/c/<slug>: only its events). */
  r.get('/qr', async (req, res) => {
    const format = req.query.format === 'png' ? 'png' : 'svg';
    let link = cfg.publicUrl;
    let name = 'event-photos-qr';
    if (req.query.campus !== undefined) {
      const slug = typeof req.query.campus === 'string' ? req.query.campus : '';
      const c = /^[a-z0-9-]{1,80}$/.test(slug) ? await db.knex('campuses').where({ org_id: ctx.orgId, slug }).first() : undefined;
      if (!c) throw bad(404, 'not_found', 'Campus not found.');
      link = `${cfg.publicUrl}/c/${c.slug}`;
      name = `event-photos-${c.slug}-qr`;
    }
    if (format === 'png') {
      const png = await QRCode.toBuffer(link, { type: 'png', width: 1200, margin: 2, errorCorrectionLevel: 'M' });
      res.type('png').setHeader('Content-Disposition', `inline; filename="${name}.png"`);
      res.send(png);
    } else {
      const svg = await QRCode.toString(link, { type: 'svg', margin: 2, errorCorrectionLevel: 'M' });
      res.type('image/svg+xml').setHeader('Content-Disposition', `inline; filename="${name}.svg"`);
      res.send(svg);
    }
  });

  return r;
}
