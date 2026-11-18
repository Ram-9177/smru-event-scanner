import './threads.js';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createContext } from './context.js';
import { startScheduler } from './sync/sync.js';
import { recoverInterruptedUploads } from './media/upload.js';
import { cleanTempDir } from './media/files.js';
import { upgradeOldCopies } from './media/upgrade.js';
import { startCopies } from './media/rebuild.js';
import { startBackups } from './backup.js';
import { startAlerts } from './alerts/alerts.js';
import { startExpiry } from './ops/expiry.js';
import { startPush } from './keep/push.js';

const startedAt = new Date();

try {
  process.loadEnvFile?.('.env');
} catch {
  /* no .env file: use the environment as it is */
}

const cfg = loadConfig();
const ctx = await createContext(cfg);

// Anything left "processing" by a restart goes back in the line; an upload cut off before its file reached the
// drive goes (a student's or an organiser's), and a student's phone gets that upload back.
await recoverInterruptedUploads(ctx.db);
// What the stopped server left in data/tmp (uploads waiting in the video line, half-made downloads and previews).
const leftovers = cleanTempDir(cfg, startedAt);
if (leftovers) ctx.log(`removed ${leftovers} file(s) a stopped server left in data/tmp`);

const app = createApp(ctx);
const started = () => {
  ctx.log(`listening on ${cfg.publicUrl} (port ${cfg.port}${cfg.host ? `, ${cfg.host} only` : ''})`);
  ctx.log(`database: PostgreSQL (Knex); cache: Redis; email: ${ctx.mailer.configured ? 'SMTP' : 'saved to data/outbox (no SMTP_URL)'}; sign in with Microsoft: ${cfg.sso.enabled ? 'on' : 'off'}; drive: ${ctx.drive.kind === 'graph' ? 'OneDrive' : `local folder ${cfg.localDriveDir}`}`);
  const host = new URL(cfg.publicUrl).hostname;
  if (!cfg.publicUrl.startsWith('https://') && host !== 'localhost' && host !== '127.0.0.1') {
    ctx.log('PUBLIC_URL is not https. Phones open the camera only on https, so Find my photos will not work on phones until it is.');
  }
  void ctx.face.health().then((ok) => {
    if (!ok) ctx.log(`the face engine did not start: are the model files in ${cfg.faceModelsDir}?`);
  });
};
const server = cfg.host ? app.listen(cfg.port, cfg.host, started) : app.listen(cfg.port, started);
// A 2 GB video from campus Wi-Fi takes far longer than Node's 5-minute default for one request.
server.requestTimeout = 2 * 60 * 60 * 1000;
startScheduler(ctx);
// The database, dumped to BACKUP_DIR a few minutes after start and then every BACKUP_EVERY_HOURS.
const stopBackups = startBackups(ctx);
process.once('exit', stopBackups);
// Alerts for the organisers (console banners, emails, the morning summary), every few minutes.
const stopAlerts = startAlerts(ctx);
// Albums closed on their day, face data deleted when it is due: every hour.
const stopExpiry = startExpiry(ctx);
// Keep me updated: pushes about new photos, sent a little after the photos arrive.
const stopPush = startPush(ctx);
// Photos and videos live only in OneDrive: the copies job makes every missing copy there from the originals (and
// moves up what an older version kept on this Mac), empties the copies trash, and sweeps old temp files.
const stopCopies = startCopies(ctx);
// Stopped with Ctrl+C or by a service manager: stop a running pg_dump too (its half-written file goes), send the
// pushes that are waiting (for a few seconds at most), then stop as usual.
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.once(sig, () => {
    stopBackups();
    stopAlerts();
    stopExpiry();
    stopCopies();
    void Promise.race([stopPush(), new Promise((r) => setTimeout(r, 3000))]).finally(() => process.kill(process.pid, sig));
  });
}
if (!cfg.backupDir) ctx.log('automatic database backups are off (BACKUP_DIR=off)');
// Older albums get the light WebP copies (and each photo its fix) once, in the background.
void upgradeOldCopies(ctx);
