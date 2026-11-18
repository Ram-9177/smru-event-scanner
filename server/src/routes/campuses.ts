import { z } from 'zod';
import { audit, type Ctx } from '../context.js';
import { bad, parse, slugify } from '../lib/http.js';
import { Router } from '../lib/router.js';
import { PEOPLE_FOLDER } from '../people/filing.js';
import { isReservedFolder } from '../sync/event-folder.js';
import { folderNameFor } from '../sync/event-folder.js';
import { requireSuper, type AdminUser } from './auth.js';

const CampusIn = z.object({ name: z.string().trim().min(2).max(60), sort: z.number().int().min(0).max(1000).optional() });

/** The campuses (Hyderabad, Chebrolu, Budampadu ...). Everyone signed in sees them; a super admin changes them. */
export function campusRoutes(ctx: Ctx) {
  const { knex } = ctx.db;
  const r = Router();
  const me = (res: any) => res.locals.admin as AdminUser;
  const list = async () =>
    knex('campuses as c')
      .select('c.id', 'c.name', 'c.slug', 'c.sort', knex.raw('(select count(*)::int from events e where e.campus_id = c.id) as events'))
      .where('c.org_id', ctx.orgId)
      .orderBy([{ column: 'c.sort' }, { column: 'c.name' }]);
  const one = async (id: string) => {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw bad(404, 'not_found', 'Campus not found.');
    const c = await knex('campuses').where({ id, org_id: ctx.orgId }).first();
    if (!c) throw bad(404, 'not_found', 'Campus not found.');
    return c;
  };
  const freeSlug = async (name: string, except?: string) => {
    const slug = slugify(name);
    const taken = await knex('campuses').where({ org_id: ctx.orgId, slug }).whereNot('id', except ?? '00000000-0000-0000-0000-000000000000').first();
    if (taken) throw bad(409, 'exists', `There is already a campus called ${taken.name}.`);
    return slug;
  };

  /**
   * A new name renames the campus's OneDrive folder too, so a later event or campus of the old name cannot be
   * mistaken for it. If a folder of the new name is already there, the folder keeps its old name.
   */
  const renameFolder = async (folderId: string, name: string) => {
    const want = folderNameFor({ title: name, starts_on: null });
    try {
      const clash = (await ctx.drive.children(null)).find((f) => f.id !== folderId && f.name.toLowerCase() === want.toLowerCase());
      if (clash || want.toLowerCase() === PEOPLE_FOLDER.toLowerCase() || isReservedFolder(want)) {
        ctx.log(`Campuses: the folder of ${name} keeps its old name, because a folder called "${want}" is already there.`);
        return;
      }
      await ctx.drive.rename(folderId, want);
    } catch (e) {
      ctx.log(`Campuses: could not rename the folder of ${name}: ${(e as Error).message}`);
    }
  };

  r.get('/campuses', async (_req, res) => {
    res.json({ campuses: await list() });
  });

  r.post('/campuses', requireSuper, async (req, res) => {
    const b = parse(CampusIn, req.body);
    const [c] = await knex('campuses')
      .insert({ org_id: ctx.orgId, name: b.name, slug: await freeSlug(b.name), sort: b.sort ?? (await list()).length })
      .returning(['id', 'name', 'slug', 'sort']);
    await audit(ctx, me(res).email, 'campus.add', c.id, { name: c.name });
    res.status(201).json({ campus: c });
  });

  r.patch('/campuses/:id', requireSuper, async (req, res) => {
    const c = await one(req.params.id);
    const b = parse(CampusIn.partial(), req.body);
    const set: Record<string, unknown> = {};
    if (b.name) Object.assign(set, { name: b.name, slug: await freeSlug(b.name, c.id) });
    if (b.sort !== undefined) set.sort = b.sort;
    if (Object.keys(set).length) await knex('campuses').where({ id: c.id }).update(set);
    if (b.name && b.name !== c.name && c.drive_folder_id) await renameFolder(c.drive_folder_id, b.name);
    await audit(ctx, me(res).email, 'campus.update', c.id, b);
    res.json({ campus: (await list()).find((x: any) => x.id === c.id) });
  });

  /** Events of the campus stay; they simply have no campus any more. */
  r.delete('/campuses/:id', requireSuper, async (req, res) => {
    const c = await one(req.params.id);
    await knex('campuses').where({ id: c.id }).delete();
    await audit(ctx, me(res).email, 'campus.remove', c.id, { name: c.name });
    res.json({ ok: true });
  });
  return r;
}
