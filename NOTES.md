# Build notes (kept current while building)

Status (16 Nov 2026)
- Phases 1 to 5 (the MVP) are built: server, student app, admin console, face service.
- 150 API tests pass on PostgreSQL 16 and on the built-in database (PGlite). The flow also ran in a real browser
  (fake camera feed) and with the real face models on sample pictures.
- Not tested: a real Microsoft 365 tenant (Graph adapter runs only against test/helpers/mock-graph.ts), real phones, real event photos.
- Next: Phase 6 pilot on one real event; then version 1.1 (sections, videos, Remove me, select-and-download, Keep me updated, stats, poster, face-data expiry job, HEIC).

Large faces (found while testing end to end, 16 Nov 2026)
- YuNet reads a face well only when it is about 24 to 320 px wide in the picture it is given. Measured with the real models
  on a 4096 px working copy: at 480 px the match score drops, at 640 px it no longer matches, from 900 px the face is not found.
  Selfies had the same problem from about 640 px in a 960 x 1280 frame. Close-ups and phone selfies have faces that large.
- Fix: face-service/app.py (and scripts/proof_test.py, version 3) read every picture at three sizes (full, 1/4, 1/16) and take
  each face from the size where it is 320 px wide or less. Faces up to 320 px come out exactly as before.
  After the fix, faces 40 to 2200 px wide score 0.81 to 0.99 against the same face at its own size. Cost: about 13% more time on camera-size photos (62 down to about 50 to 54 a minute on 2 cores).
- face-service/check_sizes.py repeats this measurement. Run it after any change to the face code.

When something stops
- Face service not answering: FaceDownError. Selfies and uploads answer 503 "try again in a few minutes"; a sync stops with a
  message on the sync screen and the photos stay "found" (not "failed"); the next sync carries on.
- Server killed in the middle of a sync: on start, rows left "processing" go back to "found" and the timer starts the sync again.

Second check against the plan (16 Nov 2026): what was missing or wrong, now fixed
- A report approved after the reported photo had become a copy hid only the copy: the picture stayed up. Take-downs now act on the photo that is shown.
- A picture hidden as a student's upload came back when the organiser's original of it was synced. The original now arrives hidden (Unhide brings it back).
- A rejected upload whose file OneDrive could not delete at that moment came back at the next sync as a new, approved photo.
  The row now keeps the file's ID until the delete worked, and the sync tries the delete again.
- Anything that turns up in the Crowd uploads folder by itself now follows the students' rules (waits for review, copies never shown).
- One phone sending many photos at the same moment could pass its limit. The count and the reservation are one step now.
- OneDrive answering "not found" for a file it listed a moment ago made the app drop the photo, and with it that it was hidden.
  The photo now waits and the next sync's listing decides.
- A removed organiser stayed signed in for up to 12 hours. Sessions are checked against the users table on every request.
- Added from the plan: the count "N are yours" on the one link, "more photos are coming", zoom in the viewer, the privacy page with a
  named contact (CONTACT), the notice text in the share kit, team management, Read every photo again, the audit list.
- Archiving also deletes every phone's saved results for the event, not only the face vectors.
- A Closed (or Archived) event is never synced: not by the timer, not by Sync now, not by Retry. Its album lives on from the display
  copies after the originals are moved or deleted in OneDrive; one sync there would have emptied it. Live syncs it again.
- Changing the folder of an event that already has photos asks twice: the album follows the folder, so the old folder's photos
  (and their matches and hidden flags) leave at the next sync.

OneDrive: what is known and what is not
- Not yet run against a real Microsoft 365. Microsoft's hosts are not reachable from the workspace this was built in.
- Microsoft's reference pages list Files.ReadWrite.AppFolder for personal accounts only on the special-folder page; the app-folder
  concept page does not restrict it. So the app tries the app folder first and, if Microsoft refuses, offers the wider permission
  (Files.ReadWrite, a top-level folder named Event Photos) with one button. The mode is stored with the connection (connections.root_mode, scope).
- Every Graph request has a time limit. No answer is tried 3 times, then DriveDownError (the work waits). 429/503/509 wait for Retry-After up to
  5 times, then DriveDownError. 500/502/504 are tried twice more. A download asks for a fresh link each try.
- A sign-in as a different account is refused while events have folders (WrongAccount), unless /admin/onedrive/connect?switch=1.
- Settings > Check everything (server/src/drive/check.ts) is the real test: ten steps on real files, removed afterwards.

Things worth knowing before changing code
- Hide acts on the shown photo: hiding a row marked as a copy hides the photo it copies.
- A student's upload is decided (copy or not) and its row reserved inside the event lock, before the file is saved to the drive.
- The sync job reads what it knows BEFORE listing the folder, so an upload that lands mid-sync is never taken for a deleted file.
- Image links (/img) are signed, expire, and check visibility on every request; admin links carry a=1 and skip the visibility check.
- Selfie bytes are never written to disk and the selfie vector is not stored (Keep me updated is v1.1).
- "Show anyway" sets media.keep_both so a later sync does not mark the photo as a copy again.
- The sign-in cookie is marked Secure when the sign-in request came over HTTPS (req.secure, with trust proxy on).
- The red pencil circle keeps its thickness at any frame size (non-scaling stroke), so its dash length is measured on screen
  in PencilCircle. With a fixed dash length the circle stopped short on large frames.
- The page must never be wider than the phone: #root has overflow-x: clip because the strip animation once pushed it wider.

Decisions
- (Superseded 16 Nov 2026 night: see "One stack" below.) TypeScript + Express 5, plain SQL, PGlite when no DATABASE_URL.
- Storage behind `Drive` (server/src/drive): `graph` = OneDrive via Microsoft Graph, `local` = folder stand-in. Graph adapter is tested only against test/helpers/mock-graph.ts.
- Face engine behind `FaceEngine` (server/src/face): real = server/src/face/local.ts (YuNet + SFace + ORB through OpenCV 5 in worker threads; the Python face-service/app.py it replaced is in _backup); tests use test/helpers/stub-face.ts (coloured blocks = people).
- API lives under /api; pages are /, /e/:slug, /admin/*. Microsoft callback is /admin/onedrive/callback (as registered).
- One rule for what students see = VISIBLE in server/src/db/schema.ts. Image links: /img/:id/:size signed + expiring + visibility check.
- Duplicate rules: server/src/media/duplicates.ts (student upload vs anything = skip; your same file twice = shown once; your original beats a student's copy; your look-alikes both stay).

Design direction (web)
- Concept: the contact sheet on a light table. One event = one strip of film (black, sprocket holes, edge print with the event name, frames = real thumbnails). Your photos = frames circled in red grease pencil; "Might be you" = yellow pencil question mark. The selfie is the ticket (ticket-stub button).
- Colours: lightbox #F3F5F4, film #000000, ink #22303A, marker red #D7263D, marker yellow #FFC400, steel #8A9499.
- Type: Archivo variable (width axis: extra-condensed heavy for titles/edge print, normal for text) + Covered By Your Grace (marker hand). No monospace.
- Motion: one moment: strips pull in and frames develop on load; pencil circle draws on select. Reduced motion respected.

## One-step start (16 November 2026, later)

- `Start Event Photos.command` (Mac, double-click) finds Node.js 22.12+ or downloads the official one into `.tools`
  (checksum from nodejs.org), then runs `scripts/start.mjs`, which is also `npm run launch` anywhere.
- `scripts/start.mjs`: npm install when the lock file changed; a Python 3.9+ virtual environment for the face
  service (on a Mac /usr/bin/python3 only when Apple's command line tools are there; otherwise uv brings Python 3.12);
  builds what changed; makes `server/.env` once (free ports, HOST=127.0.0.1, a generated organiser password, the
  stand-in folder `Event Photos (stand-in for OneDrive)`); starts both; adds three sample events once; opens the browser.
  A second double-click while it runs only opens the browser. A port taken by another program moves the app to the next one.
- The server listens on HOST when it is set (the one-step start keeps it to this computer).
- Tested in a clean copy on Linux: first start in about 60 s with downloads, second start in about 10 s, the port
  move, closing the window stops both. The face service also ran on Python 3.9 with OpenCV 5.0 and numpy 2.0.

## One stack: TypeScript only (16 November 2026, night)

The owner fixed the stack. Everything was moved to it; the API and the screens stayed the same.
- Server: Express 4 (async handlers through server/src/lib/router.ts, which passes rejected promises on; query parser
  "simple" as Express 5 had). PostgreSQL 16 through Knex: `db.knex` for the builder, `db.query` runs the older
  `$1` SQL through knex.raw (src/db/index.ts translates `$n` to `?`). Migrations in code (src/db/migrations.ts:
  001_initial = schema.ts, 002_auth = users.last_sign_in_at + users.ms_oid), run at start and by `npm run db:migrate`.
  DATE columns stay 'YYYY-MM-DD' strings and int8 comes back as a number (pg type parsers).
- Redis 7 (ioredis, prefix REDIS_PREFIX): sign-in limit (5 per minute per address+email), revoked JWT ids until they
  expire, password-reset tokens (hash only, one use, 30 min; invitations 24 h), Microsoft sign-in state (10 min),
  album passcode tries (8 per 5 min per phone). This machine has Redis 8.2 (Homebrew); nothing used is newer than 7.
- Sign-in: JWT RS256 in the HttpOnly ep_admin cookie (aud admin, 12 h, sub = user id, k = password stamp, jti).
  Every request still looks the user up, so removal or a new password signs out at once; logout revokes the jti.
  Keys: JWT_PRIVATE_KEY or DATA_DIR/jwt-rs256.pem (made once, 0600). Other JWTs: OneDrive connect state
  (aud onedrive-state), ZIP links (aud zip). Image links keep their short HMAC (a JWT per image URL is too long).
- Passwords: bcrypt cost 12 (max 72 bytes). scrypt hashes from before still verify and are replaced with bcrypt on
  the next right password (users and album passcodes).
- Sign in with Microsoft: openid-client, code + PKCE + nonce, tenant = MS_TENANT_ID only, tid checked, matched to
  Team by Microsoft object id (remembered) or email. Comes back to the already-registered /admin/onedrive/callback;
  a state starting "sso." tells the two flows apart. Nobody gets an account by signing in.
- Email: Nodemailer with SMTP_URL; without it messages go to DATA_DIR/outbox as .eml. Team invitations never contain
  the password the super admin typed: they carry a set-your-password link.
- Face engine: TypeScript port of the Python service, same models and cut-offs; see "Face engine in TypeScript".
- Web: TanStack Query for all fetching (web/src/lib/query.ts), React Router 7, Vitest + Testing Library tests in
  web/src/__tests__. New pages: /admin/forgot, /admin/reset.
- Scripts are .ts run by Node 22.18+ (type stripping): start.ts checks/starts PostgreSQL 16 and Redis via Homebrew,
  makes the database, downloads the face models into server/models.
- Tests: each server test file gets its own schema in event_photos_test and its own Redis prefix, so files run in
  parallel.
- The data of the built-in database (PGlite, server/data/pg) was copied into PostgreSQL once; the old folder is
  kept as server/data/pg-builtin-old.

## Review fixes: uploads, videos, downloads (17 November 2026)

- Originals handed to students (Download all, Save original) stay the best-quality original, byte for byte, except
  for the GPS position of a **photo**: server/src/media/location.ts takes the GPS block out of the EXIF data (and the
  GPS fields out of XMP) in place, in JPEG, PNG and WebP. No pixel is decoded or encoded again; camera details, date
  and orientation stay; the file keeps its size. The file in OneDrive is never changed. Because of this, Save
  original for a photo is now fetched through the server (it used to be a redirect to OneDrive's link).
- Trade-off, videos: the original of a **video** still goes to students as it is in OneDrive (Save original is a
  redirect to OneDrive's own link, Download all copies it unchanged), so a phone video's QuickTime location tag
  (©xyz / com.apple.quicktime.location.ISO6709) reaches them. Taking it out would mean passing every video (up to
  2 GB) through the server and rewriting its moov box (or a remux with ffmpeg -c copy). The album's preview MP4 has
  no metadata at all (-map_metadata -1).
- Videos longer than VIDEO_MAX_MINUTES (default 30) are refused before anything is saved ("This video is longer
  than 30 minutes. Send a shorter clip."), and ffmpeg never works on more than that length (-t), however long the
  file says it is.
- Download all: a link works once (its jti is kept in Redis), one ZIP at a time per phone, three per server, ten
  links per phone in ten minutes. A link refused because the server is busy is not used up.
- Add your photos: the event, the per-phone limit (counting uploads still arriving), a per-address limit (600 per
  10 minutes: a campus Wi-Fi shares one address) and 32 uploads at once per server are checked before the body is
  read; a video also needs twice its maximum size free in data/tmp.
- At start: uploads cut off by a restart are cleaned up for organisers too (a phone gets its upload back), and the
  server's own leftovers in data/tmp go (only files older than the start; adopt-* and check-* of the command-line
  tools are never touched).
- OneDrive copies into People folders: a copy still running when the app stops waiting (2 minutes without
  progress; a copy that keeps moving is waited for) is followed on the next try instead of being started again. This
  is remembered in the running server only: after a restart the next try starts a new copy, and the earlier one,
  if it finished, stays in the folder as "name 1".

## Campuses, People folders, videos, originals (17 November 2026)

- Campuses table (seeded Hyderabad, Chebrolu, Budampadu); an event's folder goes inside its campus's folder.
- People: reference faces (person_refs) -> every VISIBLE item they are in is copied (Graph server-side copy of the
  original) into People/<Name - Role>/<Solo|Duo|Group>. Solo/Duo/Group = faces >= 35% of the widest face (KIND_SQL is the
  same rule in SQL; student results carry `kind`). Every visibility change calls mediaChanged (media/after.ts).
  Copies of a removed photo are queued in people_trash (migration 004, a trigger keeps their ids).
- Videos: ffprobe/ffmpeg; poster + 720p H.264 preview; faces from a frame every 2 s merged per person (cosine 0.6);
  own queue (one at a time); VIDEO_MAX_MINUTES 240; uploads stream to disk then OneDrive upload sessions. Since
  18 November the preview and a location-free copy (clean, made right after the video is shown) are uploaded to
  OneDrive's app folder; nothing of the video stays on the Mac.
- Downloads: previews are small copies; "Download original" and Download all give the originals (photos with GPS
  removed, nothing else changed). Video originals keep their location tags (rewriting 2 GB files was not worth it).
- Student uploads wait for approval again by default (owner, 16 Nov).
- Events whose photos came in through the local stand-in folder were moved into OneDrive once (npm run adopt-local).
- Review of the new server code: 46 confirmed findings fixed (atomic Redis limits, TRUST_PROXY default loopback,
  per-account login limit, SSO tied to the starting browser, worker pool timeouts and pixel caps, restart recovery).
  Known trade-off: the per-account login limit (20 per 15 min) lets someone who knows an organiser's email delay
  their password sign-in; Sign in with Microsoft and Forgot password still work.

## Darkroom design, photo quality, videos you are in (17 November 2026, later)

- Design: the owner's reference page (a darkroom seen through a camera: warm black, paper white, safelight amber, one
  red; Instrument Serif / Instrument Sans / DM Mono / Caveat). Shared parts in web/src/styles.css + darkroom.css,
  per area in public.css, console.css, people.css (imported first, so a rule there that changes a shared part names
  that part too). Photos are never tinted (owner: "color looking little odd"): no sepia, no glow over a picture, film
  grain behind the content.
- Previews: WebP (thumb 400 q72, web 1600 q80, sharpened lightly); older .jpg copies are still served by extension and
  are remade once at start (media/upgrade.ts). Video previews: H.264 medium CRF 27, max 2.5 Mbit/s, 30 fps, AAC 96k.
- "Improve photos" (events.improve_photos, default on): media.look = {lo, hi, gamma, sat} measured once (prepare.ts
  measureLook); only clearly hazy / washed-out / under-exposed photos get one (most real photos measured: none).
  Applied the same to the album copies and to the full-quality download (prepare.ts fullQuality: full size, JPEG q94
  4:4:4, sRGB, camera/lens/date kept through sharp withExif, never GPS). A photo without a look downloads as the
  original byte for byte (GPS stripped in place). Switching the setting remakes the copies (process.ts remakeCopies).
- HEIC/HEIF (iPhone): decoded through ffmpeg 8 (tile grids), taken in from OneDrive and uploads; downloaded as JPEG.
- Videos: matches.at_ms = where the best-matching face is seen; the viewer starts a second before and offers
  "You at m:ss". Checked end to end on a preview copy with a fake camera: the selfie found the video, People filed it.
- Console: event cards show four frames of the event (organiser-signed thumbnail links).

## Review of the photo and video quality work (17 November 2026, late morning)

Four reviewers (correctness, privacy, performance, quality), then a verifier each: 30 findings, 28 confirmed. All
confirmed ones are fixed; the two refuted ones (P3 clipped to sRGB in downloads; sharpening adding bytes) were refuted
as "intended, not a bug", and were improved anyway (downloads keep the original's profile; edges-only sharpening).
- HEIC: ffmpeg cannot read a tiled HEIC (every iPhone photo) from a pipe, so an upload is written to a temp file
  first; ffmpeg drops the colour profile of a tiled HEIC, so prepare.ts decodeHeic puts it back (iCCP chunk in the
  PNG). The PNG is uncompressed (deflate was ~90% of the decode time), capped at its expected size, and the pixel
  count is checked before ffmpeg starts. A HEIC that cannot be read is a bad photo (400), not a 500. Fixture:
  test/fixtures/iphone-grid-p3.heic (made by sips: 6 tiles, Display P3).
- The look: black point from the darkest channel, white point from the brightest (luma made blue/red stage light
  look "dark" and got it stretched until it clipped); gamma only without whites; applied to brightness only
  (prepare.ts applyLook: RGB scaled by f(Y)/Y, capped at white; in steps of a million pixels with event-loop turns).
  Before, the same curve per channel raised saturation ~18% on every fixed photo. Black-point trigger 0.06 -> 0.08,
  at most 0.1.
- Downloads (media/fullcopy.ts): a render line of 2, kept copies by (id, sha256, look, recipe)
  in OneDrive (_app copies/<event>/full, rows in full_copies, LRU within FULL_COPIES_GB; was data/full until
  18 November), streamed through the server; optimiseCoding off (800 MB -> 250 MB peak at 48 MP);
  q93, 4:2:0 unless the original was 4:4:4; the original's ICC kept (APP2 segments written by withJpegIcc after the
  look). /original: 300 per phone per 10 minutes. UV_THREADPOOL_SIZE 16 (src/threads.ts, imported first).
- Privacy: location.ts cleanForHandover fails closed (JPEG: every APPn read, APP13 IPTC place names blanked, extended
  XMP refused, trailing JPEGs cleaned, anything else after EOI refused; PNG/WebP: known chunks only). 84 of 84 real
  originals here still go out byte for byte.
- Queues: remakes (Improve photos switch, start-up upgrade) on their own Queue(1) in media/upgrade.ts; a second switch
  drops what is left of the first; no ctx.bump (faces unchanged); rejected photos never remade; copies written as
  .new and renamed into place inside the event lock; an original that is gone is marked (status_reason) and not
  asked for again. Tests: settle() waits for the remake line too.
- Bursts: every shown photo's scene is described from the neutral sceneCopy at processing (even with the rule off);
  sceneOf falls back to an older album JPEG or the original, never the fixed WebP.
- Smaller: POST /admin/events stores improve_photos; skipped rows of a now-readable kind go back to 'found' at sync;
  without ffmpeg a HEIC is not downloaded (waits with a reason); adopt-local uploads a JPEG of the copy (look null);
  the viewer names a download by the server's Content-Disposition and ignores taps while one runs.
- Video: HDR (HLG/PQ, from ffprobe color_transfer) tone-mapped with a generated 33^3 .cube through lut3d (media/hdr.ts;
  Homebrew ffmpeg has no zscale/libplacebo). Measured on an HLG clip made from a real photo: chroma 0.57x -> 0.99x of
  the original, mean error 20.7 -> 4.3 levels. Colour tags are set with setparams (ffmpeg 8 takes them from frames).
  Preview preset medium up to 10 minutes, veryfast beyond; -threads 4; nice 10.
- Backup before migration 005 went live: server/data/backups/event_photos-2026-11-17-before-005.sql.
- Backups (server/src/backup.ts): pg_dump -Fc into BACKUP_DIR (default <repo>/backups, outside server/data), 2 min after
  start then every BACKUP_EVERY_HOURS, newest BACKUP_KEEP of event_photos-YYYY-MM-DD-HHMM.dump kept (other files left
  alone); written as .<name>.part and renamed; one at a time; nice 10; connection passed as PG* env, never argv.
  pg_dump found from PG_DUMP, then Homebrew/Postgres.app/Linux paths for the server's major (and newer). Status for
  super admins in GET /admin/onedrive/status `backup` {dir, last_at, last_error} (no UI yet).
- DELETE /admin/events/:id is super admin only (organisers archive).
- Selfie search also limited per network address (SEARCHES_PER_IP_10_MIN, 60; Redis Limiter 'search-ip'); loopback
  is never counted (and private addresses too when TRUST_PROXY=false or 0). IPv6 is counted per /64.
- Backup dumps are 0600 in a 0700 folder (they hold emails and password hashes); a pg_dump running over 2 hours is
  stopped so it cannot block later backups.

## Photos and videos only in OneDrive (18 November 2026)

Owner: "Storage should use OneDrive only. The UI and code use the server, but images and videos use only OneDrive."
Design: scratchpad onedrive-only-design.md (with a Deviations section at its end).

- Every media byte the app keeps is in OneDrive, `_app copies (do not edit)/<event id>/{t,w,v,s,clean,full}` plus
  `people-refs/`. Keys `od/<item id>/<name>` in the old columns (thumb_key, web_key, video_key, person_refs.thumb_key)
  and new ones (scene_key, clean_key); `media/...` and `people/...` keys are legacy. Migration 008: copies_missing,
  copies_lost, copies_tries, copies_error, clean_tries, events.copies_folders, full_copies, copy_trash, and triggers that queue
  every od key leaving a row (nulled, replaced, row deleted, event cascade) in copy_trash in the same transaction.
  Every write is a new name (no OneDrive versions); removal is permanentDelete with DELETE as fallback.
- Serving (routes/images.ts): signed link + VISIBLE check first, then 302 to the OneDrive download link
  (`private, max-age=300`; admin `no-store`; `Referrer-Policy: no-referrer`). `pipe=1` streams through (viewer
  share/save, console "open"); Save original and ZIP always stream (place stripped here, fail-closed; links of full
  and clean copies never leave the server). Legacy keys: the file if it is still on the Mac, else 503 copy_preparing
  and the item goes to rebuild:hot.

  | Case | Delivery |
  |---|---|
  | Album `<img>` / `<video>` (t, w, v) | 302 to OneDrive |
  | Viewer share/save (fetch) | pipe=1 (no CORS from SharePoint needed) |
  | Console "open in a new tab" | pipe=1 (OneDrive may send Content-Disposition: attachment) |
  | Save original, Download all | streamed through, never redirected |
  | Organiser original | 302 (as before) |
  | People face photos (admin) | 302, no-store |

- Link cache (media/copyurls.ts): Redis `cu:<item>` until 20 min before the link ends (exp from the tempauth token,
  else 55 min); single flight; 8 lookups at once; in-process LRU when Redis is down. One listing of a copies folder
  (999 a page, at most once per 20 minutes per folder) fills a whole album; the album, results and media list warm
  `t/` before answering. A listing that misses a copy (deleted by hand) marks it copies_missing. 429 on the request
  path: DriveBusyError at once (no sleeping) and `drive:throttled` for Retry-After, answered 503 `busy` with that
  Retry-After (not an outage: no banner); `drive:down` for a minute after OneDrive could not be reached or needs
  signing in (album JSON `images_ok: false`, alert after 5 minutes). Image requests that arrive while a folder
  listing runs wait for it (in-process, at most 5 s) instead of each making a lookup. Student downloads (Save
  original, ZIP, pipe=1) use `patient: false` reads too: a throttled OneDrive answers 503 at once.
- VISIBLE gained `and not m.copies_lost`: a photo whose copies cannot be made (original gone in a closed event, or 3
  failed tries) leaves what students see; "Try again" in the Media manager (filter "Cannot be shown") resets it.
- Rebuild job (media/rebuild.ts, startCopies in index.ts): state only in the DB; 2 at a time, 60 a minute, hot first
  (students waiting), display copies first, live events first, album order. Local legacy files are uploaded as they
  are (no original fetched) and removed; once no legacy key is left data/media, data/people and data/full go
  (app_state copies_local_done). OneDrive down/busy/full (Graph 5xx after retries is DriveDownError, 507 is
  DriveFullError) or ffmpeg/face missing stop a pass without counting a try, and a stop by OneDrive sets
  `rebuild:paused` (2, 4, 8, 10 min) so student kicks do not start passes (the 10-minute pass still looks). Five
  failures in a row stop a pass too. Rounds of 20, so items students wait for move to the front within seconds.
  A video's clean copy that cannot be made counts in clean_tries (3 at most; "Try again" resets), never in
  copies_tries. A kept full or clean copy deleted in OneDrive: Save original / ZIP make the download from the
  original and the copy is made again (clean_key cleared, rebuild:hot). Full copies are kept in the background:
  the download never waits for the upload.
- Every hide (Hide, an approved "Remove me", an approved report) calls afterHidden: cached links purged, then t/w/v
  re-keyed (server-side copy to new names, old ones deleted photo by photo) so links handed out before die in a
  minute or two; a photo whose copies cannot be copied has its old ones deleted anyway and remade by the rebuild job
  (copies_missing); reject deletes every copy within the request; archive drops full and clean copies; event delete queues the
  whole event copies folder (one call). Orphans (uploaded, never committed) older than 2 h are swept per event after a
  rebuild pass and daily at 03:00. Request temp files (zip-, orig-, full-, copy-, clean-) older than 6 h are swept
  hourly; files of long jobs (upload-, .video, .preview.mp4 ...) only at start. copy_trash: an outage counts no try;
  rows past 20 tries are still tried by the 10-minute pass. "Check everything" never makes or removes the real
  copies folder (its probe goes into the folder when it is there, else into the check's own folder).
- Disk: TEMP_MIN_FREE_GB 1 (was UPLOAD_MIN_FREE_GB 3), videos need 2.3x their size on top; disk alerts 5/2 GB (were
  10/3). New alerts: copies_rebuilding, copies_lost (per event), onedrive_space_low, images_unavailable.
- Web: AlbumImg retries a failed album image after 5/20/60 s with `&r=n` and a "Being prepared" tile; the viewer's
  video reloads a fresh link at the same moment when the old one runs out; service worker thumbs v2 caches only
  `basic` 200s (redirected thumbnails are opaque: passed through, not cached; offline thumbnails are given up).
- Tests: LocalDrive signs `/_drive/<id>` links (Range, an hour), so tests take the same 302 path; mock Graph has
  download links with tempauth exp, Range, permanentDelete, Retry-After, and "G"-prefixed ids (real OneDrive ids never
  look like the stand-in's <inode>-<ms>). Every media test file checks afterEach that data/ holds no media and an
  empty tmp (expectNoLocalMedia); test/onedrive-only.test.ts is the end-to-end proof.
- Not verified against a real Microsoft 365 (only the mock): whether SharePoint download links answer Range with 206
  for Safari's `<video>` and with which Content-Type, their real life, CORS and Content-Disposition. "Check
  everything" now measures the first two; VIDEO_VIA=pipe is the fallback.
