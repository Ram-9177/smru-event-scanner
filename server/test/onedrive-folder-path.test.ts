/**
 * The wider permission with MS_ROOT_FOLDER set to a path: the app uses a folder that already exists somewhere
 * in the OneDrive of the account that signs in, instead of a top-level "Event Photos" it makes itself.
 * Then the event folders and the organisers' photos go into that folder, through the OneDrive adapter.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { makeHarness, settle, type Harness } from './helpers/harness.js';
import { startMockGraph, type MockGraph } from './helpers/mock-graph.js';
import { makePhoto } from './helpers/photos.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ep-onedrive-path-'));
const open: { h: Harness; mock: MockGraph }[] = [];

async function setup(rootFolderName: string, make: string[], share?: { link: string; path: string }) {
  const mock = await startMockGraph(path.join(root, `onedrive-${open.length}`), share ? { shares: { [share.link]: share.path } } : {});
  for (const dir of make) fs.mkdirSync(path.join(mock.dir, ...dir.split('/')), { recursive: true });
  const h = await makeHarness(
    {
      drive: 'graph',
      ms: {
        tenantId: 'college-tenant',
        clientId: 'client-1',
        clientSecret: 'mock-secret',
        redirectUri: 'https://photos.college.test/admin/onedrive/callback',
        scope: share ? 'offline_access User.Read Files.ReadWrite.All' : 'offline_access User.Read Files.ReadWrite',
        root: 'folder',
        rootFolderName,
        rootLink: share?.link ?? '',
        graphBase: mock.graphBase,
        loginBase: mock.loginBase,
      },
    },
    { driveDir: mock.dir },
  );
  open.push({ h, mock });
  return { h, mock };
}

async function connect(h: Harness) {
  const go = await h.admin.get('/admin/onedrive/connect').expect(302);
  const atMicrosoft = await fetch(new URL(go.headers.location), { redirect: 'manual' });
  const cb = new URL(atMicrosoft.headers.get('location')!);
  const back = await h.admin.get(`/admin/onedrive/callback${cb.search}`).expect(302);
  const status = (await h.admin.get('/api/admin/onedrive/status').expect(200)).body.status;
  return { back: new URL(back.headers.location, 'http://x').searchParams, status };
}

afterAll(async () => {
  for (const { h, mock } of open) {
    await h.close();
    await mock.close();
  }
  fs.rmSync(root, { recursive: true, force: true });
});

describe('MS_ROOT_FOLDER as a path', () => {
  it('connects to a folder that is inside another folder, and names it by its path', async () => {
    const { h } = await setup('Photos/Event Photos 2026', ['Photos/Event Photos 2026/Annual Day']);
    const { back, status } = await connect(h);
    expect(back.get('onedrive')).toBe('connected');
    expect(status).toMatchObject({ connected: true, mode: 'folder', rootName: 'Photos > Event Photos 2026' });
  });

  it('says which folder is missing instead of making one somewhere else', async () => {
    const { h } = await setup('Photos/Not There', ['Photos']);
    const { back, status } = await connect(h);
    expect(back.get('onedrive')).toBe('error');
    expect(back.get('reason')).toContain('"Photos > Not There" is not in the OneDrive');
    expect(status.connected).toBe(false);
  });
});

it('a chosen top-level folder that is not in the account is not made: the wrong account gets a clear error', async () => {
  const { h, mock } = await setup('One intigration', ['Something else']);
  const { back, status } = await connect(h);
  expect(back.get('onedrive')).toBe('error');
  expect(back.get('reason')).toContain('"One intigration" is not in the OneDrive');
  expect(status.connected).toBe(false);
  expect(fs.existsSync(path.join(mock.dir, 'One intigration'))).toBe(false);
});

describe('event folders and organisers\' photos on OneDrive', () => {
  it('before OneDrive is connected the event is still made, and says why it has no folder; afterwards "Make the folder" works', async () => {
    const { h, mock } = await setup('Shared/Event Photos', ['Shared/Event Photos']);
    const made = (await h.admin.post('/api/admin/events').send({ title: 'Convocation', starts_on: '2026-12-20' }).expect(201)).body;
    expect(made.event.folder).toBeNull();
    expect(made.folder_error).toMatch(/not connected/);

    await connect(h);
    const fixed = await h.admin.post(`/api/admin/events/${made.event.id}/folder`).expect(200);
    expect(fixed.body.event.folder.name).toBe('2026-12-20 Convocation');
    expect(fs.statSync(path.join(mock.dir, 'Shared', 'Event Photos', '2026-12-20 Convocation')).isDirectory()).toBe(true);
  });

  it('once connected, a new event gets its folder inside the chosen OneDrive folder, and photos added in the console land in it', async () => {
    const { h, mock } = await setup('Shared/Event Photos', ['Shared/Event Photos']);
    await connect(h);
    const { event, folder_error } = (await h.admin.post('/api/admin/events').send({ title: 'Annual Day', starts_on: '2026-12-21' }).expect(201)).body;
    expect(folder_error).toBeNull();
    const dir = path.join(mock.dir, 'Shared', 'Event Photos', '2026-12-21 Annual Day');
    expect(fs.statSync(dir).isDirectory()).toBe(true);

    const res = await h.admin
      .post(`/api/admin/events/${event.id}/photos`)
      .set('content-type', 'image/jpeg')
      .set('x-file-name', encodeURIComponent('IMG_7.jpg'))
      .send(await makePhoto(50))
      .expect(201);
    expect(res.body.result).toBe('added');
    await settle(h);
    expect(fs.readdirSync(dir).filter((n) => /^IMG_7-.+\.jpg$/.test(n))).toHaveLength(1);
    expect((await h.admin.get(`/api/admin/events/${event.id}/progress`).expect(200)).body.counts).toMatchObject({ total: 1, shown: 1 });
  });
});

describe('MS_ROOT_LINK: a folder shared from another person\'s OneDrive', () => {
  const link = 'https://college-my.sharepoint.com/:f:/g/personal/owner_college_test/IgCG6wKeWMk6Tq83UdXAwUc3?e=LYflG6';

  it('connects to the folder behind the link, asks for Files.ReadWrite.All, and names the owner', async () => {
    const { h, mock } = await setup('Event Photos', ['Owner/Planned Photos'], { link, path: 'Owner/Planned Photos' });
    const { back, status } = await connect(h);
    expect(back.get('onedrive')).toBe('connected');
    expect(status).toMatchObject({ connected: true, mode: 'folder', rootName: 'Planned Photos (shared by Srihari Polakam)' });
    expect(mock.scopes.at(-1)).toContain('Files.ReadWrite.All');

    const { event } = (await h.admin.post('/api/admin/events').send({ title: 'Annual Day', starts_on: '2026-12-22' }).expect(201)).body;
    const dir = path.join(mock.dir, 'Owner', 'Planned Photos', '2026-12-22 Annual Day');
    expect(fs.statSync(dir).isDirectory()).toBe(true);
    await h.admin.post(`/api/admin/events/${event.id}/photos`).set('content-type', 'image/jpeg').set('x-file-name', 'stage.jpg').send(await makePhoto(60)).expect(201);
    await settle(h);
    expect(fs.readdirSync(dir).filter((n) => n.startsWith('stage-'))).toHaveLength(1);
  });

  it('says plainly when the link is not shared with the account that signed in', async () => {
    const { h } = await setup('Event Photos', ['Owner/Planned Photos'], { link: 'https://elsewhere.test/not-shared', path: 'Owner/Missing' });
    const { back, status } = await connect(h);
    expect(back.get('onedrive')).toBe('error');
    expect(back.get('reason')).toMatch(/could not be opened with this account/);
    expect(status.connected).toBe(false);
  });
});
