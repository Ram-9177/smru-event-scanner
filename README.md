# Event Photos

One link and one QR for every college event. A student picks the event, takes one selfie and gets every
photo they are in. No login. The photos live in OneDrive; this app syncs them, finds the faces on your own
server and removes duplicate photos.

Built from the plan "Event Photos PWA — Build Plan", phases 1 to 5 (the MVP):

| Phase | What works | Tests |
| --- | --- | --- |
| 1. Foundation | Admin sign-in, team, events, the one link and QR, OneDrive adapter, folder picker, Check everything | `server/test/phase1.test.ts`, `drive.test.ts`, `onedrive-app.test.ts` |
| 2. Sync and processing | Sync job, display copies, face vectors, duplicate rules, sync screen | `phase2.test.ts` |
| 3. Find my photos | Selfie camera, search, my photos, viewer with zoom, Download all, "Not me", My data and privacy, search limits | `phase3.test.ts` |
| 4. Full album and controls | Album, passcode, hide, report, requests, audit log, installable PWA | `phase4.test.ts` |
| 5. Crowd uploads | Add your photos, limits, save to OneDrive, review, Approve all, auto-approve | `phase5.test.ts` |

## The stack

Everything is TypeScript.

| | |
| --- | --- |
| Server | Node.js + TypeScript, Express 4, PostgreSQL 16 through Knex (migrations in `server/src/db/migrations.ts`), Redis 7 (ioredis), Zod for every input, JWT (RS256) in an HttpOnly cookie + bcrypt for sign-in, OpenID Connect (openid-client) for Sign in with Microsoft, Nodemailer for password-reset and invitation emails, Vitest + Supertest |
| Face engine | Inside the server, in worker threads: YuNet (face detection) and SFace (face vectors) from the OpenCV Zoo through OpenCV 5 (`@techstark/opencv-js`), plus ORB keypoints for finding the same shot taken twice. Nothing leaves the server. |
| Web | React 19 + TypeScript, Vite, Tailwind CSS 4, TanStack Query for all data, React Router 7, the app's own components (`web/src/ui.tsx`, no Radix/shadcn), Vitest + Testing Library |
| Scripts | TypeScript, run directly by Node 22.18+ (`node scripts/start.ts`) |

Not built yet (version 1.1 in the plan): album sections, "Remove me", select-and-download, Keep me updated, stats,
poster PDF, face-data expiry job.

## Photo and video quality

- **Light in the app, full quality on download.** The album shows small copies made on this server: WebP, 400 px
  thumbnails and 1600 px full-screen copies (`THUMB_MAX_PX`, `WEB_MAX_PX`), a fraction of the weight of the originals.
  **Download full quality** and **Download all** give the full-size photo from OneDrive. A video plays as a light
  720p MP4 (H.264, at most 30 frames a second and 2.5 Mbit/s, AAC sound); its download is the original video.
- **Improve photos** (each event, on by default, under More options): a photo that came out clearly dark, hazy or
  washed out gets a gentle fix, measured once when it comes in. The fix changes brightness only (each pixel keeps
  its own colour, nothing is pushed past white), and blacks and whites are measured per colour channel, so a photo
  under coloured stage light, or of saturated clothes, is left as it was taken. Mid-tones are lifted only in a photo
  that is dark all over with nothing bright in it. The album shows the fix, and its download is the same photo,
  fixed, at full size (JPEG quality 93, in the original's own colours: an iPhone's Display P3 stays P3), with the
  camera, lens and date kept and nothing else of the metadata. Photos that are fine (most: none of 27 real iPhone
  photos needed one) are not touched. Their download is the original itself, byte for byte, with only where it was
  taken removed. The originals in OneDrive never change. Switching the setting remakes the album copies in the
  background, one photo at a time, on a line of their own (new photos and uploads never wait behind them).
- **Where a photo was taken never reaches a student.** An original goes out as it is only when every block of its
  metadata could be read and cleaned (EXIF GPS, XMP, IPTC place names, pictures a phone appends such as an HDR gain
  map). Anything else (a drone's own GPS fields, a motion photo's video, AVIF/HEIF) gets the full-quality copy instead.
- **Full-quality copies are made at most two at a time** and kept in OneDrive, in
  `_app copies (do not edit)/<event>/full`, for the next student who asks (a group photo is downloaded by everyone in
  it), within `FULL_COPIES_GB` (50 GB by default; the least recently used go first). A kept copy is streamed from
  OneDrive without fetching the original again. One phone can ask for at most 300 originals in ten minutes.
- **True colours**: the app's darkroom look never tints a photo; the film texture stays on the page around them.
- **iPhone photos (HEIC)**, tiled and in Display P3 as an iPhone saves them, are taken in like any photo (read through
  ffmpeg, from OneDrive or as an upload) in their true colours, and downloaded as full-quality JPEG, which every phone
  and computer opens. HEIC files an older version listed as skipped are taken in at the next sync.
- **HDR videos** (an iPhone's default, HLG; or PQ) are turned into the normal picture for the poster, the album's
  preview and the face search, so they never look washed out. Previews of up to 10 minutes are encoded carefully,
  longer recordings quickly, always at a low priority.
- **Videos you are in** start a second before you are seen, with a **You at 0:42** button to jump there again.
- An older album (made before the WebP copies) is brought up to date once, in the background, after a start.

## Campuses, People folders and videos

- **Campuses**: Hyderabad, Chebrolu and Budampadu are there from the first start (change them in Settings, or set
  `CAMPUSES=` before the first start). An event of a campus gets its OneDrive folder inside the campus's folder:
  `Event Photos › Hyderabad › 2026-11-20 Annual Day`. The home page has a tab per campus.
- **People**: the university's main people (Chairman, CEO, COO, Vice Chancellor ...). Add a person with one to five
  clear photos of their face. Every shown photo and video they are in is copied (a OneDrive copy of the original) into
  `Event Photos › People › <Name - Role> › Solo | Duo | Group`. Solo, duo or group is decided by the main faces in the
  picture (people far in the background do not count). A photo that is hidden, rejected or found to be a duplicate
  leaves the folders again; **File again** on the person's page looks through every event.
- **Videos** (MP4, MOV, WebM ...): uploaded in the console or found in the event folder, like photos. The server
  makes a poster and a light MP4 every browser plays, looks at a frame every two seconds for faces, and a selfie finds
  the videos you are in, starting each one at the moment you appear. Needs ffmpeg (`brew install ffmpeg`), which also
  reads iPhone HEIC photos.
- **Students' uploads wait for approval**: photos and videos from people the organisers do not know appear only after an
  organiser approves them (event tab "Waiting for approval"). An event can switch this off under More options.

## On a Mac: double-click Start Event Photos

1. Keep this folder somewhere that is not synced to iCloud Drive or OneDrive.
2. Double-click **Start Event Photos**. If macOS says it cannot be opened, go to System Settings, Privacy &
   Security, and press Open Anyway.
3. The first start takes a few minutes. It installs what it needs, adds three sample events and opens the
   app in your browser. The Terminal window shows the organiser sign-in.

Close the Terminal window to stop. Double-click again to start; that takes a few seconds.

- It needs Node.js 22.18 or newer, PostgreSQL 16 and Redis 7. When the Mac has no Node.js, the official one is
  downloaded into the `.tools` folder here. PostgreSQL and Redis come from Homebrew (`brew install postgresql@16 redis`
  once); the start script starts them when they are not running, and makes the database `event_photos`.
  The two face model files (about 39 MB) are downloaded once into `server/models` and checked against their checksums.
- **Event Photos (stand-in for OneDrive)** is the folder that plays OneDrive until you connect it: one folder
  per event inside it. Creating an event makes its folder there and links it; put photos in it (or add them on the
  event's Photos tab) and press Sync now.
- The settings are in `server/.env`, the data in `server/data`. To start again with no events, stop the app
  and delete `server/data` (keep `server/.env`).
- On any computer, `npm run launch` does the same as the double-click.
- If the app stops by itself, the start script starts it again (after 2, 5, 10, 30 seconds). If it stops 5 times
  in 10 minutes something is wrong that a restart does not fix: the script stops and says so.
- What it printed is in `logs/start.log` (kept under 5 MB; the one before is `logs/start.log.old`).

## The permanent public link (ngrok)

Students use one link that never changes: your fixed ngrok domain (free plan: one domain, shown in the ngrok
dashboard under Domains). Set it once in `server/.env`, without `https://`:

```
NGROK_DOMAIN=galleried-warless-petronila.ngrok-free.dev
```

- The QR code, the share kit, the links in emails and the Microsoft redirect are then `https://NGROK_DOMAIN`,
  whatever `PUBLIC_URL` says. (If `PUBLIC_URL` is already an ngrok address and `NGROK_DOMAIN` is not set, the start
  script writes it in for you.)
- The start script keeps the tunnel up. It first looks for an ngrok that already runs for this domain (ngrok's own
  page at http://127.0.0.1:4040, then the link itself) and uses that one: it never starts a second. Otherwise it runs
  `ngrok http --url=https://NGROK_DOMAIN <PORT>`, and starts it again if it stops (after 5, 10, 30, 60, 120 seconds,
  then every 2 minutes). An ngrok you started yourself is never stopped by it.
- Every 5 minutes it opens the link the way a phone would. When that fails the log says
  `Public link is DOWN ... Students cannot open it.` (again every hour while it stays down), and
  `Public link works again` when it is back.
- It needs ngrok installed (`brew install ngrok`) and signed in once: `ngrok config add-authtoken <your token>`.
  Without ngrok the app still runs on this Mac and the start script says there is no public link.
- `PUBLIC_TUNNEL=off` in `server/.env` leaves ngrok to you. `NGROK_PATH` points at ngrok if it is somewhere unusual.
- If the start script says the running tunnel "points at" another port, an ngrok is running for an old port:
  stop that ngrok (or quit it in Activity Monitor) and start again.

## Run it all the time

On the Mac that serves the photos, make Event Photos a login service once:

```bash
npm run service install      # starts it now, at every login, and again whenever it stops
npm run service status       # running or not, does the app answer, does the public link answer, last log lines
npm run service stop         # stop it for a while (it starts again at the next login, or with: npm run service start)
npm run service uninstall    # stop it and do not start it at login any more
```

- It runs the same start script as the double-click (`scripts/start.ts --service`), so the app, PostgreSQL, Redis
  and the public link (above) come up together, and the app is started again if it crashes.
- The Mac is kept awake while it runs (`caffeinate`), so the link keeps working with the lid open and nobody at
  it. The screen can still turn off. With the lid closed a MacBook sleeps unless it is on power with a display
  attached. Keep it on power.
- It starts when you log in, so set the Mac to log in to your account by itself after a power cut (System
  Settings, Users & Groups, Automatically log in as) and to start after a power failure (System Settings, Energy).
- What it does goes to `logs/service.log` and `logs/start.log` in this folder.
- If you started the app by hand (double-click) before installing the service, the service watches that one and takes
  over when you close it.
- `npm run service -- install --dry-run` shows the service file (`~/Library/LaunchAgents/local.event-photos.plist`)
  without changing anything.

## Alerts, storage and face data

- **Alerts.** Every 5 minutes the server checks for problems: sync failing for an event (two runs in a row),
  OneDrive needing to be connected again, the OneDrive client secret or sign-in running out within 14 days, the
  database backup failing or older than 2 days, less than 5 GB free on the Mac (critical below 2 GB: it only keeps
  the database, backups and temp files), face recognition not running, OneDrive nearly full (under 10%; critical under
  3% or 5 GB), OneDrive not giving the album's photos for 5 minutes, more than 50 photos waiting over 30 minutes for
  their copies, and photos whose copies cannot be made because their originals are gone. Each problem shows as a banner across the console: super admins see them all,
  organisers see sync and face-recognition problems.
- **Alert emails.** With `SMTP_URL` set, super admins also get an email when a problem starts (at most one per
  problem every 12 hours) and when it is fixed, plus a morning summary at 09:00 when uploads are waiting for
  approval or requests are open. Each super admin turns this on or off in Settings, Alerts and storage, where
  **Send a test email** checks the setup. Put the client secret's end date from Entra in
  `MS_CLIENT_SECRET_EXPIRES=YYYY-MM-DD` to be warned before it runs out. The numbers can be changed in
  `server/.env` (see `.env.example`, "alerts").
- **Storage.** Settings, Alerts and storage shows this Mac (free space, the database, backups, temporary files) and
  OneDrive (its space, the app's copies, copies being rebuilt, photos that cannot be shown). Below 1 GB free for
  temporary files, uploads from students and organisers are refused with a clear message until space is freed
  (`TEMP_MIN_FREE_GB`; the older `UPLOAD_MIN_FREE_GB` still works); a video needs about 2.3 times its size on top.
- **Keep me updated.** After a selfie search a student can tick "Tell me when new photos of me arrive". Only then
  is a code made from their face kept (never the selfie), for that event only. New photos from syncs and approved
  uploads are checked against it, and sure matches are added to their prints. They get a notification if they allow
  it. That needs the https link and, on iPhone, the page added to the Home Screen. Otherwise they see "N new" when
  they come back. One tap on My prints turns it off and deletes the code; so does Delete my results.
  `KEEP_UPDATED=off` switches the feature off.
- **Remove me.** On My prints a student can ask to be removed from the photos found of them. The request appears
  under Requests with those photos. Remove from album hides them all; Keep photos leaves them.
- **Face data expiry.** Each event can delete its face data a number of days after the event (90 for new events;
  `FACE_DAYS_DEFAULT`) and can close its album on a date. An hourly job does both and notes it in the activity log.
  The photos stay, face search ends ("Face search ended — browse all photos"), and the kept codes from Keep me
  updated go too. Archiving an event deletes its face data as well. Closed events older than 90 days that still
  have face data show a reminder in the events list.

## Storage: photos and videos live only in OneDrive

The server runs the app and keeps the database; every photo and video byte is in OneDrive.

- **Your originals** stay where you put them, in the event folders.
- **The app's own copies** are in one folder of the app's OneDrive folder, `_app copies (do not edit)`:
  `<event id>/t` (thumbnails), `w` (web copies and video posters), `v` (video previews), `s` (scene descriptions for
  the duplicate check), `clean` (videos without where they were filmed, for downloads), `full` (full-quality download
  copies), and `people-refs` (People face photos). Every copy gets a new name when it is made (never replaced in
  place, so OneDrive keeps no extra versions), and copies that are no longer needed are deleted for good
  (`permanentDelete`, so they do not fill the recycle bin and the quota).
- **This Mac** keeps the PostgreSQL database (settings, face data), its backups, logs and keys, and temporary files
  that live for one job or one download (removed afterwards, swept at start and every hour).
- **How the album gets them.** Every image link is still signed by the app and checked (the photo must be visible to
  that student) before anything else; then the phone is sent to a short-lived OneDrive link for the copy. Share and
  save in the viewer, and Save original and Download all, go through the app (their place is taken out here, and
  their links never leave the server). Set `VIDEO_VIA=pipe` if videos do not play from OneDrive on iPhones.
- **The copies job.** Missing copies are made again from the originals by themselves: 30 seconds after start, every
  10 minutes, after each sync, and at once when a student is waiting for one ("being prepared"). Two at a time,
  at most `REBUILD_PER_MIN` (60) a minute, live events first. Copies an older version kept on the Mac
  (`server/data/media`) are moved up as they are and then removed. A photo whose original is gone in a closed event
  cannot be rebuilt: it leaves the album and the Media manager lists it under "Cannot be shown" with Try again.
- **Do not edit the copies folder.** Deleting files there only makes the app make them again. If the OneDrive app on
  this Mac syncs the Event Photos folder, set `_app copies (do not edit)` to "Free up space" (online only) or leave it
  out of the sync, or the copies come back down onto the Mac.
- **Check everything** (Settings, OneDrive) also checks the copies folder and that OneDrive's download links answer a
  byte range (video seeking) and what type they send.

## Try it in five minutes (no Microsoft account)

You need Node 22.18 or newer, PostgreSQL 16 and Redis 7 running. (`npm run launch` does these steps for you.)

```bash
npm install
cp .env.example server/.env                       # then set ADMIN_EMAIL and ADMIN_PASSWORD in server/.env
createdb event_photos                             # the tables are made by the migrations at start
npm run demo
```

Open http://localhost:3000/admin and sign in. Then:

1. Create an event. Its folder is made and linked for you: `server/data/drive/<date> <title>/` (this folder stands in
   for OneDrive; with OneDrive connected it is made inside the Event Photos folder there).
2. Add photos: on the event's **Photos** tab press **Choose photos**, or put files into that folder and press **Sync now**.
   Photos added in the admin console are saved into the folder too.
3. To use a folder that is already there instead, open **OneDrive sync**, pick it, press **Use this folder**.
4. Set the event **Live** and open http://localhost:3000 in another tab.

On a phone the camera
needs HTTPS, so try the selfie on the computer first (a laptop camera works on localhost).
While changing code use `npm run dev` instead and open http://localhost:5173.

**To try it on a real phone before you have a server:** a tunnel gives your computer a temporary HTTPS address.
With [cloudflared](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/) installed, run
`cloudflared tunnel --url http://localhost:3000` in a second terminal and open the `trycloudflare.com` address it
prints on the phone. Anyone who has that address can open the app while the tunnel runs, so stop it after the test.

## Connect your college OneDrive (the real test)

This is the one part that could not be tested without your Microsoft 365. It takes about ten minutes
and works on your own computer first, with `npm run demo`.

1. **Register the app** in the [Microsoft Entra admin center](https://entra.microsoft.com): App registrations > New registration.
   Name: Event Photos. Accounts in this organisational directory only. Platform: Web, redirect URI
   `http://localhost:3000/admin/onedrive/callback` (add `https://photos.your-domain/admin/onedrive/callback` later for the real server).
2. **API permissions**: Microsoft Graph, delegated: `Files.ReadWrite.AppFolder` and `offline_access`.
3. **Certificates & secrets**: create a client secret and copy its **Value** at once.
4. Add three lines to `server/.env` and start again with `npm run demo`:

   ```
   MS_TENANT_ID=...        # Directory (tenant) ID
   MS_CLIENT_ID=...        # Application (client) ID
   MS_CLIENT_SECRET=...    # the secret's Value
   ```

5. Open http://localhost:3000/admin/settings, press **Connect OneDrive**, sign in with the college account and accept.
6. Press **Check everything**. It saves three small test photos into a test folder in your OneDrive, lists, downloads,
   renames and changes them, and removes the folder. Ten lines, each PASS or FAIL. **Copy the result** copies them as text.
7. In OneDrive, put a few photos into a folder inside the app's folder, create an event, pick the folder, press Sync now.

What the Settings page may tell you:

| It says | What to do |
| --- | --- |
| Your Microsoft 365 did not open the app's own folder | Microsoft's pages disagree on whether a college account may use `Files.ReadWrite.AppFolder`. In Entra add `Files.ReadWrite` (delegated), then press **Connect with the wider permission**. The app then keeps to one folder named Event Photos. |
| The address Microsoft should come back to is not registered (AADSTS50011) | The redirect URI in Entra must be exactly the one shown on the Settings page. |
| The client secret is wrong (AADSTS7000215) | `MS_CLIENT_SECRET` must be the secret's Value, not its Secret ID. |
| Microsoft does not know this app / this directory (AADSTS700016, AADSTS90002) | Check `MS_CLIENT_ID` and `MS_TENANT_ID`. |
| Your college needs an admin to approve this app (AADSTS90094), or a "Need admin approval" page at Microsoft | Send the admin the note in the plan ("Note for the admin"). |
| You signed in as X, but the event folders are in the OneDrive of Y | Sign in as Y. Nothing was changed. |
| Sign-in expired: reconnect | Press Reconnect OneDrive. Albums keep working meanwhile; syncs and student uploads wait. |

The OneDrive part of the app was tested against an imitation of Microsoft's endpoints built from Microsoft's
documentation (`server/test/onedrive-app.test.ts`, `drive.test.ts`), in tests and in a real browser. It has not
yet talked to a real Microsoft 365: **Check everything** is that test.

## Run it for real

```bash
npm run build                      # builds web/dist and server/dist
npm run db:migrate -w server       # brings the tables up to date (the server also does it at start)
NODE_ENV=production npm start      # serves the web app and the API on PORT; the face engine runs inside it
```

- Set `SESSION_SECRET` (32+ random characters), `DATABASE_URL` (PostgreSQL 16) and `REDIS_URL` (Redis 7).
- Give the sign-in key pair as `JWT_PRIVATE_KEY` (RSA, PEM), or keep `DATA_DIR/jwt-rs256.pem` safe: whoever has it can
  make sign-in tokens. Changing it signs everybody out.
- Set `SMTP_URL` and `MAIL_FROM` so password-reset links and invitations are sent. Without them they are saved in
  `DATA_DIR/outbox`.
- With the three Microsoft values set, organisers can **Sign in with Microsoft** (their email must be in Team). It
  uses the OneDrive redirect URI that is already registered; nothing more to set in Entra.
- Serve it over **HTTPS**: phones only open the camera on HTTPS. Caddy in front of the app is the least work.
  With nginx, pass `X-Forwarded-Proto` so the sign-in cookie is marked HTTPS-only, and set
  `client_max_body_size 25m;` (nginx stops at 1 MB unless told otherwise, and student uploads go up to 20 MB).
- With Caddy or nginx on the same server, set `HOST=127.0.0.1` so the app's port can only be reached through it.
  The app believes `X-Forwarded-For`/`-Proto` only from a proxy on this computer; for a proxy on another machine set
  `TRUST_PROXY` to its address (for example `TRUST_PROXY=10.0.0.5`).
  Through ngrok or another tunnel on the same computer, keep `TRUST_PROXY=loopback` (the default; never `false`), so
  the app sees each visitor's address and not one 127.0.0.1 for everyone.
- Find my photos is limited per phone (`SEARCHES_PER_10_MIN` 5, `SEARCHES_PER_DAY` 20) and, as a phone's token costs
  nothing to change, per network address too: `SEARCHES_PER_IP_10_MIN` (60, room for a class on one Wi-Fi; 0 = off).
  Requests that reach the app from this computer without a visitor's address are not counted.
- Set `PUBLIC_URL` to the HTTPS address. The QR code, the one link and the Microsoft redirect URI are made from it.
  With a fixed ngrok domain set `NGROK_DOMAIN` instead (see "The permanent public link").
- Keep the server running, and PostgreSQL and Redis with it: on a Mac `npm run service install` (see "Run it all the
  time"); on Linux a service manager such as systemd or pm2.
- The database is backed up by the server itself: `pg_dump` two minutes after start and then every
  `BACKUP_EVERY_HOURS` (24), into `BACKUP_DIR` (default: `backups/` at the top of the project, outside `DATA_DIR`, so
  starting over never removes them), keeping the newest `BACKUP_KEEP` (14) as `event_photos-YYYY-MM-DD-HHMM.dump`.
  `BACKUP_DIR=off` switches it off. pg_dump is looked for where Homebrew, Postgres.app and Linux packages put it;
  set `PG_DUMP` to its path if it is elsewhere. Restore with `pg_restore --clean --if-exists -d event_photos <file>`.
  Copy the folder off the server now and then. Redis holds only short-lived things (sign-in limits, signed-out
  tokens, one-time links, cached OneDrive links). No photo or video is kept on this Mac; the app rebuilds its OneDrive
  copies from the originals when they are missing.
- Organisers are added, given a new password and removed under **Settings > Team** by a super admin; a new organiser
  gets an email with a link to choose their own password. **Forgot password?** on the sign-in page emails a one-time
  link (30 minutes). A removed organiser is signed out at once. If the only super admin is locked out:
  `npm run admin:create -w server -- you@college.edu "a long password"`.
- Set `CONTACT` (for example `IT Help Desk, helpdesk@college.edu`): students see it on the My data page.

## Tests

```bash
npm test                 # server (Vitest + Supertest) and web (Vitest + Testing Library). Needs PostgreSQL 16 and Redis.
npm run test:scripts     # the start script's tunnel, restart and login-service logic (a fake ngrok; never the real one)
npm run typecheck        # server, web and scripts
```

The server tests make the database `event_photos_test` (or `TEST_DATABASE_URL`) and give every test file its own schema
and its own Redis key prefix, so the files run side by side and leave nothing behind.

The tests use a stand-in face engine (coloured blocks are "people"), a local folder in place of OneDrive, and an
imitation of Microsoft's endpoints for the OneDrive adapter. So they test the app's rules, not face accuracy and not
your Microsoft 365. Four more checks use the real things:

```bash
# 1. the face engine on real photos (models in server/models), with timings
cd server && npx vitest run test/face-local.test.ts

# 2. a folder of real photos through the running app: sync, student uploads, review, one selfie per person
npm run e2e -- --photos ./event_photos --selfies ./selfies --crowd ./student_photos \
  --email you@college.edu --password "..." --drive-dir server/data/drive

# 3. your real OneDrive: Settings > Check everything (see "Connect your college OneDrive")
```

## What has been tested, and what has not

Tested on 17 November 2026 on the Mac it runs on (TypeScript stack: PostgreSQL 16, Redis, in-process face engine):
- 293 server tests (Vitest + Supertest, real PostgreSQL 16 and Redis) and 53 web tests (Vitest + Testing Library);
- the TypeScript face engine against the Python service it replaced, on 73 real event photos: identical faces, vectors,
  fingerprints and duplicate decisions (`npx tsx scripts/face-parity.ts`, needs the old service from `_backup`);
- an independent review of the server (49 findings, 46 confirmed and fixed, each fix checked again);
- live through the public link: campuses, selfie search with Solo/Duo/Group, original downloads, Download all of originals;

Tested on 16 November 2026 in a cloud workspace (2 CPU cores), before the move to this stack:
- every rule in the plan through the API (150 tests);
- the whole flow in a real browser (Chrome, phone-size, fake camera feed) with the real face models, on sample pictures:
  selfie, my photos, zoom, Download all, Not me, report and take-down, passcode, student uploads and review, the offline page;
- Connect OneDrive in a real browser against an imitation of Microsoft: sign-in round trip, a cancelled permission screen,
  a Microsoft 365 that refuses the app folder (the wider permission then connects), a sign-in Microsoft ended;
- OneDrive trouble: cut connections, 5xx answers, throttling, a download link that breaks, a file that is listed but
  "not found" for a moment (the photo is kept, a hidden photo stays hidden);
- a closed event whose originals were moved out of OneDrive: students still see and open the whole album, and a sync
  asked for anyway is refused; archiving an event and changing its folder each take a second tap;
- camera-size photos (6000 x 4000, about 5 MB): about 50 a minute, so 1,000 photos take about 20 minutes;
- the server killed in the middle of a sync: after the restart the sync carries on by itself, nothing is lost or stuck;
- the face service stopped: students get "try again in a few minutes", syncs pause, no photo is marked failed;
- 300 selfies from 300 phones, 30 at the same moment: all answered correctly, the slowest in 1.3 seconds;
- faces from 40 to 2200 pixels wide are found and matched the same (see "Large faces" in NOTES.md).

Not tested:
- **your college Microsoft 365**. No real Microsoft account was reachable from where this was built. The steps under
  "Connect your college OneDrive" are that test;
- **your event photos**: face accuracy and the duplicate cut-off (checks 1 to 3 above);
- **real phones**: the camera on iPhone and Android, uploads from an iPhone, in-app browsers such as WhatsApp;
- a real crowd: the load figures above come from one small machine with sample pictures.

## Where things are

```
server/src/routes/     admin.ts (console API), public.ts (students), images.ts, onedrive.ts (Connect OneDrive)
server/src/media/      process.ts (one photo's path), duplicates.ts (the duplicate rules), search.ts, upload.ts
server/src/sync/       sync.ts (the sync job and its timer)
server/src/drive/      graph.ts (OneDrive), local.ts (stand-in folder), check.ts (Check everything)
server/src/routes/     auth.ts (sign-in, JWT, forgot password), sso.ts (Sign in with Microsoft)
server/src/face/       local.ts + face-worker.ts: the face engine (YuNet, SFace, ORB) in worker threads
server/src/db/         index.ts (Knex), migrations.ts, schema.ts (the tables, and VISIBLE: what students see)
server/src/lib/        jwt.ts (RS256), redis.ts (limits), mail.ts (Nodemailer), router.ts (async handlers on Express 4)
web/src/               student.tsx (the student app), admin.tsx (the console), ui.tsx, lib/query.ts (TanStack Query)
scripts/               start.ts (one-step start), tunnel.ts (ngrok link), supervisor.ts (restarts), service.ts (login service),
                       dev.ts, e2e-real.ts (end-to-end run with real photos)
NOTES.md               decisions made while building; paste it to your AI assistant with the plan
```

All API routes are under `/api`. Pages are `/`, `/e/<event>` and `/admin`. The Microsoft callback is
`/admin/onedrive/callback` (for both OneDrive and Sign in with Microsoft); Sign in with Microsoft starts at `/auth/microsoft`.

## Running on a server at smru-event-scanner.supercxo.ai

Everything for the server is in `deploy/` (Docker Compose: the app, PostgreSQL 16, Redis 7 and Caddy for HTTPS).

1. DNS: point an `A` record for `smru-event-scanner.supercxo.ai` at the server's IP. Open ports 80 and 443.
2. Microsoft Entra: add this redirect URI to the app registration (OneDrive and Microsoft sign-in both come back
   to it): `https://smru-event-scanner.supercxo.ai/admin/onedrive/callback`.
3. Settings: two private files in `deploy/` on the server (never committed, never put in the image):
   - `deploy/production.env`: start from `deploy/production.env.example`. `PUBLIC_URL` is the domain; leave out
     `NGROK_DOMAIN` (it would replace `PUBLIC_URL`) and `HOST` (Compose sets it).
   - `deploy/.env`: `POSTGRES_PASSWORD=` a long random string of letters and digits.

   `SESSION_SECRET` must be the one the old copy used when you bring its database over (on a Mac started without
   one, it is in `server/data/dev-secret`): it unlocks the OneDrive sign-in kept in the database. With a new
   secret, connect OneDrive again from the organiser page.
4. To bring over the events from the Mac (optional), before the app's first start on the server:
   `docker compose -f deploy/docker-compose.yml up -d db`, then
   `docker compose -f deploy/docker-compose.yml exec -T db pg_restore -U event_photos -d event_photos --no-owner --no-acl < event_photos-<date>.dump`
   with the latest file from `backups/` on the Mac.
5. `docker compose -f deploy/docker-compose.yml up -d --build`

Caddy gets the HTTPS certificate by itself. Photos and videos stay in OneDrive; the server keeps the database,
Redis, temp files and the small view cache. QR codes, share links and emails all use `PUBLIC_URL`, so print new QR
codes from the organiser page after the move. Organisers sign in again once on the new address.
