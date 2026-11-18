/**
 * Three sample events, so every screen has something to show on the first run.
 * The pictures have no people in them; the Mona Lisa (a public-domain painting) plays a student,
 * so "Find my photos" can be tried by holding a picture of her up to the camera.
 *
 *   Art Fest 2026        Live, 17 photos, three student uploads (one a copy, one approved, one waiting)
 *   Tech Fest 2026       Draft, shown as "coming soon"
 *   Freshers Party 2026  Closed, 8 photos
 *
 * Used by scripts/start.ts. On its own: node scripts/samples.ts <app address> <admin email> <password> <stand-in folder>
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const PLAN = [
  { title: 'Art Fest 2026', starts_on: '2026-11-14', venue: 'Fine arts block', folder: '2026-11-14 Art Fest', pictures: 'art-fest', status: 'live' },
  { title: 'Tech Fest 2026', starts_on: '2026-11-07', venue: 'Block C auditorium', folder: '2026-11-07 Tech Fest', pictures: null, status: 'draft' },
  { title: 'Freshers Party 2026', starts_on: '2026-08-14', venue: 'Open air theatre', folder: '2026-08-14 Freshers Party', pictures: 'freshers', status: 'closed' },
];

/** Returns true when the samples were added, false when the app already had events. Throws on a failed step. */
interface SampleOptions {
  base: string;
  email: string;
  password: string;
  driveDir: string;
  samplesDir?: string;
  say?: (line: string) => void;
}
type Reply = { status: number; body: any };

export async function loadSamples({ base, email, password, driveDir, samplesDir = path.resolve(here, '../samples'), say = console.log }: SampleOptions): Promise<boolean> {
  let cookie = '';
  async function call(method: string, url: string, body?: unknown, headers: Record<string, string> = {}): Promise<Reply> {
    const h: Record<string, string> = { ...headers };
    if (cookie) h.cookie = cookie;
    let data = body as BodyInit | undefined;
    if (body !== undefined && !(body instanceof Uint8Array)) {
      data = JSON.stringify(body);
      h['content-type'] = 'application/json';
    }
    const r = await fetch(base + url, { method, headers: h, body: data });
    for (const c of r.headers.getSetCookie?.() ?? []) if (c.startsWith('ep_admin=')) cookie = c.split(';')[0];
    const text = await r.text();
    let json: any = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      /* not JSON */
    }
    return { status: r.status, body: json };
  }
  const must = (r: Reply, what: string): any => {
    if (r.status >= 300) throw new Error(`${what}: ${r.status} ${r.body?.message ?? r.body?.error ?? ''}`.trim());
    return r.body;
  };

  must(await call('POST', '/api/admin/login', { email, password }), 'sign in');
  if ((must(await call('GET', '/api/admin/events'), 'list events').events ?? []).length) return false;

  const ids = {};
  for (const p of PLAN) {
    const dest = path.join(driveDir, p.folder);
    fs.mkdirSync(dest, { recursive: true });
    if (p.pictures) for (const n of fs.readdirSync(path.join(samplesDir, p.pictures)).sort()) fs.copyFileSync(path.join(samplesDir, p.pictures, n), path.join(dest, n));
    const ev = must(await call('POST', '/api/admin/events', { title: p.title, starts_on: p.starts_on, venue: p.venue }), `create ${p.title}`).event;
    ids[p.title] = ev;
    const folder = (must(await call('GET', '/api/admin/onedrive/folders'), 'list folders').folders ?? []).find((f) => f.name === p.folder);
    if (!folder) throw new Error(`the folder ${p.folder} is not in the stand-in folder`);
    must(await call('PATCH', `/api/admin/events/${ev.id}`, { onedrive_folder_id: folder.id }), `link ${p.title}`);
    if (!p.pictures) continue;
    must(await call('POST', `/api/admin/events/${ev.id}/sync`), `sync ${p.title}`);
    let progress: any = {};
    for (let i = 0; i < 600; i++) {
      progress = must(await call('GET', `/api/admin/events/${ev.id}/progress`), 'progress');
      if (!progress.syncing && (progress.last_sync_at || progress.sync_error)) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    if (progress.sync_error) throw new Error(`sync ${p.title}: ${progress.sync_error}`);
    say(`  ${p.title}: ${progress.counts?.shown ?? 0} photos, ${progress.counts?.faces ?? 0} faces`);
    must(await call('PATCH', `/api/admin/events/${ev.id}`, { status: 'live' }), `${p.title} live`);
    if (p.status === 'closed') must(await call('PATCH', `/api/admin/events/${ev.id}`, { status: 'closed' }), `${p.title} closed`);
  }

  // Three student uploads to Art Fest: a chat-app copy of an official photo (skipped as a copy) and two new ones.
  const art = ids['Art Fest 2026'];
  const slug = art.slug ?? String(art.link).split('/e/')[1];
  const device = `sample-device-${Date.now().toString(36)}-0000000000`;
  for (const n of fs.readdirSync(path.join(samplesDir, 'crowd')).sort()) {
    const bytes = new Uint8Array(fs.readFileSync(path.join(samplesDir, 'crowd', n)));
    await call('POST', `/api/e/${slug}/uploads`, bytes, { 'x-device': device, 'content-type': 'image/jpeg', 'x-uploader-name': 'Priya' });
  }
  let review: any[] = [];
  for (let i = 0; i < 60 && review.length < 2; i++) {
    await new Promise((r) => setTimeout(r, 500));
    review = must(await call('GET', `/api/admin/events/${art.id}/media?filter=review`), 'review list').media ?? [];
  }
  if (review.length) must(await call('PATCH', '/api/admin/media', { ids: [review[0].id], action: 'approve' }), 'approve one');
  return true;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [base, email, password, driveDir] = process.argv.slice(2);
  if (!driveDir) {
    console.log('node scripts/samples.mjs <app address> <admin email> <password> <stand-in folder>');
    process.exit(1);
  }
  loadSamples({ base, email, password, driveDir: path.resolve(driveDir) }).then(
    (added) => console.log(added ? 'Sample events added.' : 'The app already has events, so nothing was added.'),
    (e) => {
      console.error(`Samples not added: ${e.message}`);
      process.exit(1);
    },
  );
}
