/**
 * The organiser named in the settings (ADMIN_EMAIL, ADMIN_PASSWORD): added as a super admin whenever that email has
 * no sign-in yet, also when the database came from another copy and already has its own organisers. An existing
 * sign-in is never changed by the settings, and the app does not let this organiser be removed.
 */
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureSettingsOrganiser } from '../src/context.js';
import { ADMIN, makeHarness, type Harness } from './helpers/harness.js';

let h: Harness;
const signIn = (email: string, password: string) => request(h.app).post('/api/admin/login').send({ email, password });

beforeAll(async () => {
  h = await makeHarness(); // its first start made the settings organiser (ADMIN) as the only one
});
afterAll(async () => {
  await h.close();
});

describe('the organiser in the settings', () => {
  it('is added next to the organisers of a database brought over from another copy, and can sign in', async () => {
    const before = (await h.ctx.db.query<any>(`select count(*)::int as n from users`)).rows[0].n;
    expect(before).toBeGreaterThan(0); // the "brought over" database already has an organiser
    const moved = { adminEmail: 'new.owner@college.test', adminPassword: 'a-new-long-password-1' };
    expect(await ensureSettingsOrganiser(h.ctx.db, h.ctx.orgId, moved)).toBe(true);
    const row = (await h.ctx.db.query<any>(`select role from users where email = $1`, [moved.adminEmail])).rows[0];
    expect(row.role).toBe('super_admin');
    await signIn(moved.adminEmail, moved.adminPassword).expect(200);
    await signIn(ADMIN.email, ADMIN.password).expect(200); // the organiser that came with the database still signs in
    expect(await ensureSettingsOrganiser(h.ctx.db, h.ctx.orgId, moved)).toBe(false); // the next start adds nothing
  });

  it('never changes an existing sign-in: a password changed in the app stays', async () => {
    expect(await ensureSettingsOrganiser(h.ctx.db, h.ctx.orgId, { adminEmail: ADMIN.email, adminPassword: 'some-other-password-2' })).toBe(false);
    await signIn(ADMIN.email, ADMIN.password).expect(200);
    await signIn(ADMIN.email, 'some-other-password-2').expect(401);
  });

  it('cannot be removed in the app (it would only come back at the next start)', async () => {
    // signed in as the other super admin, who could otherwise remove anyone but the last super admin
    const other = request.agent(h.app);
    await other.post('/api/admin/login').send({ email: 'new.owner@college.test', password: 'a-new-long-password-1' }).expect(200);
    const team = (await other.get('/api/admin/team').expect(200)).body.team;
    const settingsOne = team.find((u: any) => u.email === ADMIN.email);
    const res = await other.delete(`/api/admin/team/${settingsOne.id}`).expect(400);
    expect(res.body.error).toBe('settings_organiser');
    // anyone else can still be removed
    await other.post('/api/admin/team').send({ email: 'helper@college.test', password: 'helper-long-password-3', role: 'organiser' }).expect(201);
    const helper = (await other.get('/api/admin/team').expect(200)).body.team.find((u: any) => u.email === 'helper@college.test');
    await other.delete(`/api/admin/team/${helper.id}`).expect(200);
  });
});
