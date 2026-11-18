#!/usr/bin/env node
/**
 * End-to-end run against the RUNNING app with the REAL face engine and real photos (TypeScript, run by Node).
 * It plays one event the way people will use it and prints what happened:
 *
 *   organiser: sign in -> create event -> link folder -> connection test -> sync -> go Live
 *   students : add photos (copies should be skipped) -> organiser approves
 *   students : one selfie each -> their photos
 *
 * Use the same folders as the proof test:
 *
 *   npm run e2e -- --photos ./event_photos --selfies ./selfies --crowd ./student_photos
 *
 * Options
 *   --url        where the app runs            (default http://localhost:3000)
 *   --email      organiser sign-in             (default $ADMIN_EMAIL)
 *   --password                                 (default $ADMIN_PASSWORD)
 *   --drive-dir  the stand-in drive folder     (default ./data/drive; used when DRIVE=local)
 *   --folder     with OneDrive (DRIVE=graph): the name of a folder inside Event Photos that
 *                already holds the photos; --photos is then not needed
 *   --title      event name                    (default "E2E run <time>")
 *   --cleanup    delete the event at the end   (default: keep it, so you can open it)
 */
import fs from 'node:fs';
import path from 'node:path';

const args: Record<string, string | true> = Object.fromEntries(
  process.argv.slice(2).reduce<[string, string | true][]>((acc, a, i, all) => {
    if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true]);
    return acc;
  }, []),
);
const URL_BASE = String(args.url || 'http://localhost:3000').replace(/\/+$/, '');
const EMAIL = args.email || process.env.ADMIN_EMAIL;
const PASSWORD = args.password || process.env.ADMIN_PASSWORD;
const DRIVE_DIR = path.resolve(String(args['drive-dir'] || './data/drive'));
const IMAGE = /\.(jpe?g|png|webp)$/i;
const MIME: Record<string, string> = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };

const results: boolean[] = [];
const check = (label, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
};
const listImages = (dir) => (dir && fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => IMAGE.test(n)).sort() : []);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let cookie = '';
interface CallOptions {
  json?: unknown;
  body?: BodyInit;
  headers?: Record<string, string>;
  device?: string;
}
async function call(method: string, route: string, { json, body, headers = {}, device }: CallOptions = {}): Promise<{ status: number; data: any }> {
  const h: Record<string, string> = { ...headers };
  if (cookie) h.cookie = cookie;
  if (device) h['x-device'] = device;
  if (json !== undefined) h['content-type'] = 'application/json';
  const res = await fetch(`${URL_BASE}/api${route}`, { method, headers: h, body: json !== undefined ? JSON.stringify(json) : body });
  const set = res.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

async function main() {
  if (!EMAIL || !PASSWORD) throw new Error('Give the organiser sign-in: --email and --password (or ADMIN_EMAIL and ADMIN_PASSWORD).');
  if (!args.selfies) throw new Error('Give a folder of selfies: --selfies ./selfies');

  // ---- organiser -------------------------------------------------------------------------
  const login = await call('POST', '/admin/login', { json: { email: EMAIL, password: PASSWORD } });
  if (login.status !== 200) throw new Error(`Could not sign in at ${URL_BASE}: ${login.data.message || login.status}`);
  const me = (await call('GET', '/admin/me')).data;
  check('organiser signs in', true, me.user.email);
  check('face engine is running', me.face_service === true);

  const title = String(args.title || `E2E run ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`);
  let folderName = args.folder ? String(args.folder) : title.replace(/[\\/:*?"<>|]/g, '-');
  if (me.drive === 'local') {
    if (!args.photos) throw new Error('Give a folder of event photos: --photos ./event_photos');
    const dest = path.join(DRIVE_DIR, folderName);
    fs.mkdirSync(dest, { recursive: true });
    for (const n of fs.readdirSync(String(args.photos))) {
      const src = path.join(String(args.photos), n);
      if (fs.statSync(src).isFile()) fs.copyFileSync(src, path.join(dest, n));
    }
    console.log(`      copied ${fs.readdirSync(dest).length} files into the stand-in drive: ${dest}`);
  } else if (!args.folder) {
    throw new Error('This server uses OneDrive. Put the photos in a folder inside Event Photos and pass its name: --folder "2026-11-20 Annual Day"');
  }

  const made = await call('POST', '/admin/events', { json: { title, starts_on: new Date().toISOString().slice(0, 10), venue: 'End-to-end run' } });
  if (made.status !== 201) throw new Error(`Could not create the event: ${made.data.message}`);
  const event = made.data.event;
  const folders = (await call('GET', '/admin/onedrive/folders')).data.folders ?? [];
  const folder = folders.find((f) => f.name === folderName);
  if (!folder) throw new Error(`No folder named "${folderName}" inside Event Photos.`);
  const linked = await call('PATCH', `/admin/events/${event.id}`, { json: { onedrive_folder_id: folder.id } });
  check('event created and folder linked', linked.status === 200, `${title} <- ${folderName}`);

  const test = (await call('POST', '/admin/onedrive/test', { json: { folder_id: folder.id } })).data;
  check('connection test: list, download one photo, save and remove a test file', test.ok === true, (test.steps ?? []).filter((s) => !s.ok).map((s) => s.detail).join('; '));

  const t0 = Date.now();
  await call('POST', `/admin/events/${event.id}/sync`);
  let progress;
  for (;;) {
    await sleep(700);
    progress = (await call('GET', `/admin/events/${event.id}/progress`)).data;
    if (!progress.syncing && progress.counts.waiting + progress.counts.processing === 0) break;
    process.stdout.write(`\r      syncing: ${progress.counts.shown + progress.counts.copies} of ${progress.counts.total} processed   `);
  }
  const syncSec = (Date.now() - t0) / 1000;
  const c = progress.counts;
  console.log(`\r      sync: ${c.total} files, ${c.shown} shown, ${c.copies} marked as copies, ${c.skipped} skipped, ${c.failed} failed, ${c.faces} faces, ${syncSec.toFixed(1)} s`);
  check('first sync finished without an error', !progress.sync_error && c.total > 0, progress.sync_error || '');
  check('no photo failed', c.failed === 0, c.failed ? `${c.failed} failed: see OneDrive sync in the admin console` : '');
  check('faces were found', c.faces > 0, `${c.faces} faces in ${c.shown} photos, ${(c.total / Math.max(syncSec, 0.1) * 60).toFixed(0)} photos a minute`);

  const again = Date.now();
  await call('POST', `/admin/events/${event.id}/sync`);
  for (;;) {
    await sleep(300);
    progress = (await call('GET', `/admin/events/${event.id}/progress`)).data;
    if (!progress.syncing) break;
  }
  check('second sync finds nothing new', progress.counts.total === c.total && progress.counts.shown === c.shown, `${((Date.now() - again) / 1000).toFixed(1)} s`);

  await call('PATCH', `/admin/events/${event.id}`, { json: { status: 'live' } });
  const publicList = (await call('GET', '/events')).data.events ?? [];
  check('the event is on the one link, Live', publicList.some((e) => e.slug === event.slug && e.state === 'live'));

  // ---- students add photos -------------------------------------------------------------------
  const crowd = listImages(args.crowd && String(args.crowd));
  if (crowd.length) {
    let added = 0;
    let skipped = 0;
    let failed = 0;
    for (const [i, n] of crowd.entries()) {
      const r = await call('POST', `/e/${event.slug}/uploads`, {
        body: fs.readFileSync(path.join(String(args.crowd), n)),
        headers: { 'content-type': MIME[path.extname(n).toLowerCase()], 'x-uploader-name': encodeURIComponent(`Student ${1 + (i % 5)}`) },
        device: `e2e-student-${Math.floor(i / 40)}-device-token-0001`,
      });
      if (r.data.result === 'added') added++;
      else if (r.data.result === 'skipped') skipped++;
      else {
        failed++;
        console.log(`      ${n}: ${r.data.message || r.status}`);
      }
    }
    console.log(`      student photos: ${crowd.length} sent, ${added} added, ${skipped} skipped as copies, ${failed} refused`);
    check('student photos were taken in with no login', failed === 0 && added + skipped === crowd.length);
    for (;;) {
      await sleep(500);
      progress = (await call('GET', `/admin/events/${event.id}/progress`)).data;
      if (progress.counts.processing + progress.counts.waiting === 0) break;
    }
    check('they wait for review and are not shown yet', progress.counts.review === added && progress.counts.shown === c.shown, `${progress.counts.review} waiting`);
    const approved = (await call('POST', `/admin/events/${event.id}/approve-all`)).data.approved;
    progress = (await call('GET', `/admin/events/${event.id}/progress`)).data;
    check('after Approve all they are in the album', approved === added && progress.counts.shown === c.shown + added, `${progress.counts.shown} photos shown`);
  }

  // ---- students find their photos ----------------------------------------------------------------
  const names = new Map();
  for (let offset = 0; ; offset += 200) {
    const page = (await call('GET', `/admin/events/${event.id}/media?filter=shown&limit=200&offset=${offset}`)).data;
    for (const m of page.media) names.set(m.id, m.source === 'crowd' ? `student photo by ${m.uploader_name}` : m.name);
    if (offset + 200 >= page.total) break;
  }
  let slowest = 0;
  for (const n of listImages(String(args.selfies))) {
    const person = path.parse(n).name;
    const device = `e2e-${person.replace(/[^a-z0-9]/gi, '')}-device-token-000001`;
    const t = Date.now();
    const r = await call('POST', `/e/${event.slug}/selfie`, {
      body: fs.readFileSync(path.join(String(args.selfies), n)),
      headers: { 'content-type': 'image/jpeg', 'x-consent': 'v1' },
      device,
    });
    const sec = (Date.now() - t) / 1000;
    slowest = Math.max(slowest, sec);
    if (r.status !== 200) {
      console.log(`      ${person.padEnd(18)} ${r.data.message || r.status}`);
      continue;
    }
    console.log(`      ${person.padEnd(18)} sure: ${String(r.data.sure.length).padStart(3)}   maybe: ${String(r.data.maybe.length).padStart(3)}   ${sec.toFixed(2)} s`);
    for (const p of r.data.sure.slice(0, 12)) console.log(`          ${names.get(p.id) ?? p.id}`);
    if (r.data.sure.length > 12) console.log(`          ... and ${r.data.sure.length - 12} more`);
    const saved = (await call('GET', `/e/${event.slug}/mine`, { device })).data;
    if (saved.sure.length !== r.data.sure.length) check(`${person}: the saved result matches`, false);
  }
  check('every selfie search answered in under 30 seconds', slowest > 0 && slowest < 30, `slowest ${slowest.toFixed(2)} s`);

  const album = (await call('GET', `/e/${event.slug}/album?limit=1`, { device: 'e2e-album-viewer-device-token-01' })).data;
  progress = (await call('GET', `/admin/events/${event.id}/progress`)).data;
  check('the full album shows every visible photo once', album.total === progress.counts.shown, `${album.total} photos`);

  if (args.cleanup) {
    await call('DELETE', `/admin/events/${event.id}`);
    console.log('      event deleted (--cleanup)');
  } else {
    console.log(`\nOpen it: ${URL_BASE}/e/${event.slug}     admin: ${URL_BASE}/admin/events/${event.id}`);
  }
  const failedCount = results.filter((x) => !x).length;
  console.log(failedCount ? `\n${failedCount} of ${results.length} checks FAILED` : `\nAll ${results.length} checks passed`);
  console.log('Now look at the names under each selfie: are they really that person? That part needs your eyes.');
  process.exit(failedCount ? 1 : 0);
}

main().catch((e) => {
  console.error(`\nStopped: ${e.message}`);
  process.exit(1);
});
