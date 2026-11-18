import fs from 'node:fs';
import express from 'express';
import sharp from 'sharp';
import { z } from 'zod';
import { audit, type Ctx } from '../context.js';
import { vectorToBuffer } from '../face/index.js';
import { bad, parse } from '../lib/http.js';
import { imageUrl } from '../lib/links.js';
import { Router } from '../lib/router.js';
import { emptyCopyTrashSoon, isDriveKey, legacyPath, putPeopleRef, removeLegacy } from '../media/copies.js';
import { copyUrl } from '../media/copyurls.js';
import { personFolderName, PEOPLE_FOLDER, refilePerson, type Kind } from '../people/filing.js';
import type { AdminUser } from './auth.js';

const PersonIn = z.object({
  name: z.string().trim().min(2).max(80),
  role: z.string().trim().max(60).default(''),
  campus_id: z.string().uuid().nullable().optional(),
});
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** People: the university's main people and their folders (see people/filing.ts). Every organiser can manage them. */
export function peopleRoutes(ctx: Ctx) {
  const { knex } = ctx.db;
  const r = Router();
  const me = (res: any) => res.locals.admin as AdminUser;
  const refUrl = (refId: string) => `/api/admin/people/refs/${refId}.jpg`;

  async function personOr404(id: string) {
    if (!UUID.test(id)) throw bad(404, 'not_found', 'That person is not in People.');
    const p = await knex('people').where({ id, org_id: ctx.orgId }).first();
    if (!p) throw bad(404, 'not_found', 'That person is not in People.');
    return p;
  }

  async function describe(ids?: string[]) {
    const q = knex('people as p')
      .select(
        'p.id',
        'p.name',
        'p.role',
        'p.sort',
        'p.drive_folder_name',
        knex.raw(`(select json_build_object('id', c.id, 'name', c.name, 'slug', c.slug) from campuses c where c.id = p.campus_id) as campus`),
        knex.raw(`(select r.id from person_refs r where r.person_id = p.id and r.thumb_key is not null order by r.created_at limit 1) as first_ref`),
        knex.raw(`(select count(*)::int from person_refs r where r.person_id = p.id) as refs`),
        knex.raw(`(select count(*)::int from person_media pm where pm.person_id = p.id and pm.kind = 'solo') as solo`),
        knex.raw(`(select count(*)::int from person_media pm where pm.person_id = p.id and pm.kind = 'duo') as duo`),
        knex.raw(`(select count(*)::int from person_media pm where pm.person_id = p.id and pm.kind = 'group') as "group"`),
      )
      .where('p.org_id', ctx.orgId)
      .orderBy([{ column: 'p.sort' }, { column: 'p.created_at' }]);
    if (ids) q.whereIn('p.id', ids);
    return (await q).map((p: any) => ({
      id: p.id,
      name: p.name,
      role: p.role,
      campus: p.campus ?? null,
      photo: p.first_ref ? refUrl(p.first_ref) : null,
      refs: p.refs,
      counts: { solo: p.solo, duo: p.duo, group: p.group },
      folder: p.drive_folder_name ? `${PEOPLE_FOLDER} › ${p.drive_folder_name}` : null,
    }));
  }
  const one = async (id: string) => (await describe([id]))[0];

  /** Look through every event for this person again, in the background (the photo work line). */
  const refileLater = (personId: string) =>
    void ctx.work.push(async () => {
      try {
        await refilePerson(ctx, personId);
      } catch (e) {
        ctx.log(`People folders: could not file for one person: ${(e as Error).message}`);
      }
    });

  const campusOk = async (id: string | null | undefined) => {
    if (id && !(await knex('campuses').where({ id, org_id: ctx.orgId }).first())) throw bad(400, 'no_campus', 'That campus does not exist.');
  };

  r.get('/people', async (_req, res) => {
    res.json({ people: await describe() });
  });

  r.post('/people', async (req, res) => {
    const b = parse(PersonIn, req.body);
    await campusOk(b.campus_id);
    const sort = ((await knex('people').where({ org_id: ctx.orgId }).max('sort as m').first()) as any)?.m ?? -1;
    const [p] = await knex('people').insert({ org_id: ctx.orgId, name: b.name, role: b.role, campus_id: b.campus_id ?? null, sort: Number(sort) + 1 }).returning('id');
    await audit(ctx, me(res).email, 'person.add', p.id, { name: b.name, role: b.role });
    res.status(201).json({ person: await one(p.id) });
  });

  r.get('/people/:id', async (req, res) => {
    const p = await personOr404(req.params.id);
    const refs = await knex('person_refs').select('id', 'thumb_key').where({ person_id: p.id }).orderBy('created_at');
    // A face photo whose small copy is gone (it was on the Mac before photos lived in OneDrive) still matches: the
    // console asks for it again (thumb null).
    res.json({ person: await one(p.id), refs: refs.map((x: any) => ({ id: x.id, thumb: x.thumb_key ? refUrl(x.id) : null })) });
  });

  r.patch('/people/:id', async (req, res) => {
    const p = await personOr404(req.params.id);
    const b = parse(PersonIn.partial().extend({ sort: z.number().int().min(0).max(10000).optional() }), req.body);
    await campusOk(b.campus_id);
    const set: Record<string, unknown> = {};
    for (const k of ['name', 'role', 'campus_id', 'sort'] as const) if (b[k] !== undefined) set[k] = b[k];
    if (Object.keys(set).length) await knex('people').where({ id: p.id }).update(set);
    // A new name or role renames the person's OneDrive folder too.
    if ((b.name !== undefined || b.role !== undefined) && p.drive_folder_id) {
      const name = personFolderName({ name: b.name ?? p.name, role: b.role ?? p.role });
      try {
        const renamed = await ctx.drive.rename(p.drive_folder_id, name);
        await knex('people').where({ id: p.id }).update({ drive_folder_name: renamed.name });
      } catch (e) {
        ctx.log(`People: could not rename the folder of ${p.name}: ${(e as Error).message}`);
      }
    }
    await audit(ctx, me(res).email, 'person.update', p.id, b);
    res.json({ person: await one(p.id) });
  });

  /**
   * The person leaves People. Their OneDrive folder and the copies in it stay: they are the college's photos.
   * Added again under the same name and role, they get the same folder back, and the copies already in it are
   * taken over rather than copied a second time (people/filing.ts, copyInto).
   */
  r.delete('/people/:id', async (req, res) => {
    const p = await personOr404(req.params.id);
    const refs = await knex('person_refs').select('thumb_key').where({ person_id: p.id });
    await knex('people').where({ id: p.id }).delete(); // its reference thumbnails in OneDrive are queued for deletion with the rows
    emptyCopyTrashSoon(ctx);
    await removeLegacy(ctx.cfg, refs.map((x: any) => x.thumb_key));
    await audit(ctx, me(res).email, 'person.remove', p.id, { name: p.name });
    res.json({ ok: true });
  });

  /** A reference photo: one person, face clearly visible. Every event is then looked through for them. */
  r.post('/people/:id/photos', express.raw({ type: () => true, limit: '15mb' }), async (req, res) => {
    const p = await personOr404(req.params.id);
    if (!Buffer.isBuffer(req.body) || !req.body.length) throw bad(400, 'no_photo', 'Choose a photo.');
    let upright: Buffer;
    try {
      upright = await sharp(req.body, { failOn: 'none' }).rotate().resize({ width: 2048, height: 2048, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 92 }).toBuffer();
    } catch {
      throw bad(400, 'bad_photo', 'That file is not a photo we can read. Use a JPG or PNG.');
    }
    const found = await ctx.face.selfie(upright);
    if (!found) throw bad(422, 'no_face', 'No face was found in that photo. Use a clear photo where the face is easy to see.');
    if (found.faces > 1) throw bad(422, 'many_faces', 'That photo has more than one person in it. Use a photo of this person alone.');
    const [ref] = await knex('person_refs').insert({ person_id: p.id, embedding: vectorToBuffer(found.vector), model: ctx.face.model }).returning('id');
    // The small face photo the console shows lives in OneDrive (_app copies (do not edit)/people-refs). Without it the
    // face still matches: the console asks for the photo again.
    try {
      const key = await putPeopleRef(ctx, ref.id, await sharp(upright).resize(320, 320, { fit: 'cover', position: sharp.strategy.attention }).jpeg({ quality: 82 }).toBuffer());
      await knex('person_refs').where({ id: ref.id }).update({ thumb_key: key });
    } catch (e) {
      ctx.log(`People: the face photo could not be saved to OneDrive: ${(e as Error).message}`);
    }
    await audit(ctx, me(res).email, 'person.photo', p.id, { name: p.name });
    refileLater(p.id);
    res.status(201).json({ person: await one(p.id) });
  });

  r.delete('/people/:id/photos/:refId', async (req, res) => {
    const p = await personOr404(req.params.id);
    if (!UUID.test(req.params.refId)) throw bad(404, 'not_found', 'That photo is not there.');
    const had = await knex('person_refs').select('thumb_key').where({ id: req.params.refId, person_id: p.id }).first();
    const n = await knex('person_refs').where({ id: req.params.refId, person_id: p.id }).delete();
    if (!n) throw bad(404, 'not_found', 'That photo is not there.');
    emptyCopyTrashSoon(ctx);
    await removeLegacy(ctx.cfg, [had?.thumb_key]);
    refileLater(p.id);
    res.json({ person: await one(p.id) });
  });

  r.get('/people/refs/:file', async (req, res) => {
    const m = /^([0-9a-f-]{36})\.jpg$/.exec(req.params.file);
    const ref = m ? await knex('person_refs as r').join('people as p', 'p.id', 'r.person_id').select('r.thumb_key').where({ 'r.id': m[1], 'p.org_id': ctx.orgId }).first() : null;
    if (isDriveKey(ref?.thumb_key)) {
      // Admin only: a redirect to the copy in OneDrive, never kept by the browser.
      try {
        const url = await copyUrl(ctx, ref.thumb_key);
        res.set({ 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer' });
        return res.redirect(302, url);
      } catch (e) {
        if ((e as Error)?.name === 'DriveNotFoundError') throw bad(404, 'not_found', 'No such photo.');
        throw bad(503, 'images_unavailable', 'Photos cannot be loaded right now. Try again in a few minutes.');
      }
    }
    // From before the face photos lived in OneDrive: sent from this Mac while it is still here.
    const abs = legacyPath(ctx.cfg, ref?.thumb_key);
    if (!abs || !fs.existsSync(abs)) throw bad(404, 'not_found', 'No such photo.');
    res.setHeader('Cache-Control', 'private, no-store');
    res.sendFile(abs);
  });

  r.get('/people/:id/media', async (req, res) => {
    const p = await personOr404(req.params.id);
    const kind = (['solo', 'duo', 'group'] as Kind[]).find((k) => k === req.query.kind);
    const q = knex('person_media as pm')
      .join('media as m', 'm.id', 'pm.media_id')
      .join('events as e', 'e.id', 'm.event_id')
      .select('m.id', 'm.type', 'm.duration_ms', 'pm.kind', 'pm.similarity', 'pm.drive_item_id', 'e.id as event_id', 'e.title as event_title', 'e.slug as event_slug')
      .where('pm.person_id', p.id)
      .orderBy([{ column: 'e.starts_on', order: 'desc', nulls: 'last' }, { column: 'm.taken_at' }, { column: 'm.created_at' }]);
    if (kind) q.andWhere('pm.kind', kind);
    const rows = await q;
    res.json({
      media: rows.map((m: any) => ({
        id: m.id,
        type: m.type,
        duration_ms: m.duration_ms ?? null,
        thumb: imageUrl(ctx.cfg, m.id, 't'),
        web: imageUrl(ctx.cfg, m.id, 'w'),
        video: m.type === 'video' ? imageUrl(ctx.cfg, m.id, 'v' as any) : null,
        kind: m.kind,
        similarity: Math.round(m.similarity * 1000) / 1000,
        in_onedrive: !!m.drive_item_id,
        event: { id: m.event_id, title: m.event_title, slug: m.event_slug },
      })),
    });
  });

  r.post('/people/:id/refile', async (req, res) => {
    const p = await personOr404(req.params.id);
    const st = await ctx.drive.status();
    if (!st.connected) throw bad(409, 'not_connected', 'OneDrive is not connected, so nothing can be saved into the People folders.');
    const r2 = await refilePerson(ctx, p.id);
    await audit(ctx, me(res).email, 'person.refile', p.id, r2);
    res.json({ filed: r2.filed, removed: r2.removed, person: await one(p.id) });
  });

  return r;
}
