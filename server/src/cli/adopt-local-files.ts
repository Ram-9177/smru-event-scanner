/**
 * Once, after connecting OneDrive: events whose photos came in through the local stand-in folder (before OneDrive
 * was connected) get their OneDrive folder, and every file is uploaded into it so originals, Download all and the
 * People folders work. The original is taken from the stand-in folder when it is still there; otherwise the best
 * copy the app has (the display copy, or a video's preview) is uploaded, and the report says so. The moved media are
 * marked copies_missing: the app's copies job then makes their copies in OneDrive from the uploaded originals.
 *
 *   npm run adopt-local -w server            (stop the app first)
 */
import fs from 'node:fs';
import sharp from 'sharp';
import { loadConfig } from '../config.js';
import { createContext, type Ctx } from '../context.js';
import { rebuildPass } from '../media/rebuild.js';
import { LocalDrive } from '../drive/local.js';
import { mediaChanged } from '../media/after.js';
import { tempPath } from '../media/files.js';
import { isDriveKey, itemOf, legacyPath } from '../media/copies.js';
import { ensureEventFolder } from '../sync/event-folder.js';
import { CROWD_FOLDER } from '../sync/sync.js';


const LOCAL_ID = /^\d+-\d+$/; // ids the stand-in folder gives (inode-birthtime); OneDrive ids look nothing like it

/** The work of the command, for an app context on OneDrive and the stand-in folder the photos came in through. */
export async function adoptLocalFiles(ctx: Ctx, local: LocalDrive, log: (line: string) => void = console.log): Promise<void> {
  const { cfg } = ctx;
  const events = (
    await ctx.db.query<{ id: string; title: string }>(
      `select distinct e.id, e.title from events e join media m on m.event_id = e.id
        where e.org_id = $1 and m.onedrive_item_id ~ '^[0-9]+-[0-9]+$' order by e.title`,
      [ctx.orgId],
    )
  ).rows;
  if (!events.length) log('Every event already lives in OneDrive. Nothing to do.');

  for (const ev of events) {
    const folder = await ensureEventFolder(ctx, ev.id);
    const crowd = await ctx.drive.createFolder(folder.id, CROWD_FOLDER);
    await ctx.db.query(`update events set crowd_folder_id = $2 where id = $1`, [ev.id, crowd.id]);
    const media = (
      await ctx.db.query<{ id: string; name: string | null; source: string; type: string; onedrive_item_id: string; web_key: string | null; video_key: string | null }>(
        `select id, name, source, type, onedrive_item_id, web_key, video_key from media where event_id = $1 order by created_at`,
        [ev.id],
      )
    ).rows.filter((m) => LOCAL_ID.test(m.onedrive_item_id));
    let originals = 0;
    let copies = 0;
    let missing = 0;
    const moved: string[] = [];
    for (const m of media) {
      const tmp = tempPath(cfg, `adopt-${m.id}`);
      let from: 'original' | 'copy' | null = null;
      try {
        await local.download(m.onedrive_item_id, tmp);
        from = 'original';
      } catch {
        const best = m.type === 'video' ? m.video_key : m.web_key;
        // The album's copy: in the stand-in folder (a copy made while it stood in for OneDrive), or on this computer
        // (a copy from before copies lived in OneDrive).
        let bytes: Buffer | null = null;
        if (isDriveKey(best)) bytes = await local.readAll(itemOf(best), 2 * 1024 ** 3).catch(() => null);
        else {
          const abs = legacyPath(cfg, best);
          bytes = abs && fs.existsSync(abs) ? fs.readFileSync(abs) : null;
        }
        if (bytes) {
          // A photo's album copy is WebP (with its fix already in it): it goes up as a plain JPEG, and the photo is
          // not fixed a second time when it is downloaded.
          if (m.type === 'video') fs.writeFileSync(tmp, bytes);
          else fs.writeFileSync(tmp, await sharp(bytes).jpeg({ quality: 92 }).toBuffer());
          from = 'copy';
        }
      }
      if (!from) {
        missing++;
        continue;
      }
      try {
        // Made from the album copy, a photo is a JPEG now: it goes up (and is known) under a .jpg name, never a .HEIC or .png one.
        const fromCopy = from === 'copy' && m.type !== 'video';
        const name = fromCopy ? `${(m.name || m.id).replace(/\.[^.]+$/, '')}.jpg` : m.name || `${m.id}.${m.type === 'video' ? 'mp4' : 'jpg'}`;
        const mime = m.type === 'video' ? 'video/mp4' : 'image/jpeg';
        const entry = await ctx.drive.uploadFile(m.source === 'crowd' ? crowd.id : folder.id, name, tmp, mime);
        // Its copies were made by the stand-in folder: made again in OneDrive by the copies job (copies_missing).
        if (fromCopy) await ctx.db.query(`update media set onedrive_item_id = $2, ctag = $3, look = null, copies_fixed = false, name = $4, copies_missing = true, copies_tries = 0 where id = $1`, [m.id, entry.id, entry.ctag, name]);
        else await ctx.db.query(`update media set onedrive_item_id = $2, ctag = $3, copies_missing = true, copies_tries = 0 where id = $1`, [m.id, entry.id, entry.ctag]);
        moved.push(m.id);
        if (from === 'original') originals++;
        else copies++;
      } finally {
        fs.rmSync(tmp, { force: true });
      }
    }
    log(`${ev.title}: OneDrive folder "${folder.name}"; ${originals} originals and ${copies} display copies (the original was no longer on this computer) uploaded${missing ? `; ${missing} with no file left at all` : ''}.`);
    await mediaChanged(ctx, moved); // the People folders
  }
}

if (process.argv[1] && /adopt-local-files\.(ts|js)$/.test(process.argv[1])) {
  try {
    process.loadEnvFile?.('.env');
  } catch {
    /* no .env file */
  }
  const cfg = loadConfig();
  if (cfg.drive !== 'graph') {
    console.error('OneDrive is not set up (MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET): nothing to move.');
    process.exit(1);
  }
  const ctx = await createContext(cfg);
  await adoptLocalFiles(ctx, new LocalDrive(cfg.localDriveDir, { secret: cfg.sessionSecret || 'adopt' }));
  // The copies of the moved photos are made in OneDrive now (they are marked copies_missing); the app's copies job
  // does the same by itself after its next start.
  const r = await rebuildPass(ctx);
  console.log(`Copies made in OneDrive: ${r.done}${r.stopped ? ` (paused: ${r.stopped}; the app carries on after its next start)` : ''}.`);
  await ctx.close();
}
