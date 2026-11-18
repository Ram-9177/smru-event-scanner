import fs from 'node:fs';
import sharp from 'sharp';
import type { Ctx } from '../context.js';
import { sha256Buffer, sha256File } from '../lib/hashes.js';
import { tempPath } from '../media/files.js';
import { COPIES_FOLDER } from '../media/copies.js';
import type { DriveEntry } from './types.js';

export interface CheckStep {
  step: string;
  ok: boolean;
  /** Passed, but worth reading. */
  warn?: boolean;
  detail: string;
}

/**
 * "Check everything": every kind of call the app makes to the drive, on real files, in a test folder
 * that is removed at the end. It also checks the two things the sync job relies on:
 * a renamed file keeps its identity, and new content in a file is noticed.
 */
export async function checkDrive(ctx: Ctx): Promise<{ ok: boolean; steps: CheckStep[]; report: string }> {
  const { drive, cfg } = ctx;
  const steps: CheckStep[] = [];
  const run = async (step: string, fn: () => Promise<string | { detail: string; warn?: boolean }>): Promise<boolean> => {
    try {
      const out = await fn();
      steps.push(typeof out === 'string' ? { step, ok: true, detail: out } : { step, ok: true, ...out });
      return true;
    } catch (e) {
      steps.push({ step, ok: false, detail: (e as Error).message });
      return false;
    }
  };
  const photo = async (hue: [number, number, number], w = 480, h = 320) =>
    sharp({ create: { width: w, height: h, channels: 3, background: { r: hue[0], g: hue[1], b: hue[2] } } })
      .jpeg({ quality: 80 })
      .toBuffer();
  const gb = (n: number) => `${(n / 1024 ** 3).toFixed(1)} GB`;

  let folder: DriveEntry | null = null;
  let copiesCheck: DriveEntry | null = null;
  let linkType = '';
  const files: { entry: DriveEntry; data: Buffer }[] = [];
  const kind = drive.kind === 'graph' ? 'OneDrive' : 'the local folder';
  let mode = '';
  try {
    const ok =
      (await run('Signed in', async () => {
        const st = await drive.status();
        if (!st.connected) throw new Error(st.needsReconnect ? 'The sign-in has expired. Press Reconnect OneDrive.' : 'OneDrive is not connected yet. Press Connect OneDrive.');
        mode = st.mode === 'folder' ? 'the whole OneDrive (wider permission)' : st.mode === 'approot' ? "the app's own folder only" : 'a folder on this server';
        return `${st.account ?? 'account unknown'}; folder: ${st.rootName}; the app can reach ${mode}`;
      })) &&
      (await run('The sign-in renews itself', async () => {
        await drive.renew();
        return drive.kind === 'graph' ? 'a fresh sign-in was issued without a person' : 'not needed for a local folder';
      })) &&
      (await run('Space', async () => {
        const st = await drive.status();
        if (!st.quota) return drive.kind === 'graph' ? 'Microsoft did not say how much is free (this permission may not show it)' : 'not checked for a local folder';
        const low = st.quota.remaining < 5 * 1024 ** 3;
        return { detail: `${gb(st.quota.remaining)} free of ${gb(st.quota.total)}${low ? ': less than 5 GB, one event needs about 30 GB' : ''}`, warn: low };
      })) &&
      (await run('Make a folder', async () => {
        folder = await drive.createFolder(null, `event-photos-check-${Date.now()}`);
        const again = await drive.createFolder(null, folder.name);
        if (again.id !== folder.id) throw new Error('Asking for the same folder twice made two folders.');
        return folder.name;
      })) &&
      (await run('Save three photos', async () => {
        const colours: [number, number, number][] = [[215, 38, 61], [255, 196, 0], [34, 48, 58]];
        for (const [i, c] of colours.entries()) {
          const data = await photo(c);
          files.push({ entry: await drive.upload(folder!.id, `check-${i + 1}.jpg`, data, 'image/jpeg'), data });
        }
        if (new Set(files.map((f) => f.entry.id)).size !== 3) throw new Error('The three files did not get three different IDs.');
        return `${files.reduce((n, f) => n + f.data.length, 0)} bytes in 3 files`;
      })) &&
      (await run('List them, two a page', async () => {
        const listed = (await drive.children(folder!.id, 2)).filter((e) => !e.isFolder);
        const missing = files.filter((f) => !listed.some((e) => e.id === f.entry.id));
        if (listed.length !== 3 || missing.length) throw new Error(`Expected 3 files, the list has ${listed.length}.`);
        const sizes = files.every((f) => listed.find((e) => e.id === f.entry.id)!.size === f.data.length);
        return { detail: sizes ? '3 files over 2 pages, sizes match' : '3 files over 2 pages; the sizes in the list differ from what was sent', warn: !sizes };
      })) &&
      (await run('Download one and compare', async () => {
        const tmp = tempPath(cfg, `check-${Date.now()}`);
        try {
          await drive.download(files[0].entry.id, tmp);
          if ((await sha256File(tmp)) !== sha256Buffer(files[0].data)) throw new Error('The file that came back is not the file that was sent.');
          return `${fs.statSync(tmp).size} bytes, identical`;
        } finally {
          fs.rmSync(tmp, { force: true });
        }
      })) &&
      (await run('A renamed file keeps its identity', async () => {
        const before = files[1].entry;
        const after = await drive.rename(before.id, 'check-renamed.jpg');
        if (after.id !== before.id) throw new Error('The file got a new ID when it was renamed, so the app would treat a renamed photo as a new one.');
        const same = after.ctag === before.ctag;
        return { detail: same ? 'same ID, same content tag' : 'same ID; the content tag changed, so a renamed photo is processed again (nothing breaks)', warn: !same };
      })) &&
      (await run('New content is noticed', async () => {
        const before = files[2].entry;
        const after = await drive.replace(before.id, await photo([30, 120, 200], 500, 300), 'image/jpeg');
        if (after.id !== before.id) throw new Error('Replacing the content gave the file a new ID.');
        if (after.ctag === before.ctag) throw new Error('The content tag did not change, so the app would not notice an edited photo.');
        return 'same ID, new content tag';
      })) &&
      (await run('Make the copies folder', async () => {
        // The check never makes or removes the real copies folder: the rebuild job, a sync or an upload may be
        // writing copies into it at this very moment. When it is there, the probe goes into it (where the album's
        // links come from); when it is not yet, into the check's own folder.
        const root = (await drive.children(null)).find((e) => e.isFolder && e.name.toLowerCase() === COPIES_FOLDER.toLowerCase());
        copiesCheck = await drive.createFolder(root ? root.id : folder!.id, `check-copies-${Date.now()}`);
        return root
          ? `"${COPIES_FOLDER}" is there: the album's copies live in it`
          : `a folder for copies can be made ("${COPIES_FOLDER}" is made the first time the app keeps a copy)`;
      })) &&
      (await run('A link from a listing opens', async () => {
        // A 4 KB file named like a video preview: the album's videos are played straight from such links, so they
        // must answer a byte range (206) for seeking.
        const probe = await drive.upload(copiesCheck!.id, 'check-link.mp4', Buffer.alloc(4096, 7), 'video/mp4');
        const listed = (await drive.children(copiesCheck!.id, 999, { urls: true })).find((e) => e.id === probe.id);
        if (!listed) throw new Error('The file is not in the listing.');
        if (drive.kind !== 'graph') {
          const r = await drive.read(probe.id, { range: 'bytes=0-3' });
          await r.body.cancel().catch(() => {});
          if (r.status !== 206) throw new Error(`A byte range was answered ${r.status}, not 206.`);
          return 'a link came with the listing; a byte range is answered 206 (videos can seek)';
        }
        if (!listed.url) throw new Error('The listing gave no download link for the file.');
        const res = await fetch(listed.url, { headers: { range: 'bytes=0-3' }, signal: AbortSignal.timeout(30_000) });
        await res.body?.cancel().catch(() => {});
        linkType = res.headers.get('content-type') ?? 'none';
        if (res.status !== 206) {
          return { detail: `the link answered ${res.status}, not 206 to a byte range: videos may not seek. Set VIDEO_VIA=pipe in server/.env.`, warn: true };
        }
        const video = /^video\//.test(linkType);
        return {
          detail: `a byte range is answered 206 (videos can seek); type ${linkType}${video ? '' : ': Safari may not play videos from it. Set VIDEO_VIA=pipe in server/.env if videos do not play on iPhones.'}`,
          warn: !video,
        };
      })) &&
      (await run('Download links allow the browser', async () => {
        if (drive.kind !== 'graph') return 'not needed for a local folder';
        const listed = (await drive.children(copiesCheck!.id, 999, { urls: true })).find((e) => e.name === 'check-link.mp4');
        if (!listed?.url) return { detail: 'no link to try', warn: true };
        const res = await fetch(listed.url, { headers: { origin: cfg.publicUrl, range: 'bytes=0-3' }, signal: AbortSignal.timeout(30_000) });
        await res.body?.cancel().catch(() => {});
        const acao = res.headers.get('access-control-allow-origin');
        const disp = res.headers.get('content-disposition');
        return `for information: Access-Control-Allow-Origin ${acao ?? 'not sent'}; Content-Disposition ${disp ?? 'not sent'} (downloads and shares go through this server either way)`;
      }));
    const cleaned = await run('Remove the test folder', async () => {
      if (copiesCheck) {
        await drive.remove(copiesCheck.id, { permanent: true });
        copiesCheck = null;
      }
      if (!folder) return 'nothing to remove';
      await drive.remove(folder.id);
      const left = (await drive.children(null)).some((e) => e.id === folder!.id);
      if (left) throw new Error(`The folder ${folder.name} is still there. Delete it by hand.`);
      folder = null;
      return 'removed';
    });
    const all = ok && cleaned;
    const lines = [
      `Event Photos: check of ${kind}, ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`,
      ...steps.map((s) => `${s.ok ? (s.warn ? 'NOTE' : 'PASS') : 'FAIL'}  ${s.step}: ${s.detail}`),
      all ? 'Result: everything the app needs works.' : 'Result: stopped at the first FAIL.',
    ];
    return { ok: all, steps, report: lines.join('\n') };
  } finally {
    if (folder) await drive.remove((folder as DriveEntry).id).catch(() => {});
    if (copiesCheck) await drive.remove((copiesCheck as DriveEntry).id, { permanent: true }).catch(() => {});
  }
}
