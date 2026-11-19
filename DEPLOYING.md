# Deploying: the live server

The live site is **https://stmarys-event-scanner.supercxo.ai** (organisers: https://stmarys-event-scanner.supercxo.ai/admin).
The app runs on the server from `/home/ubuntu/smru-event-scanner`, behind nginx, with PostgreSQL 16 and Redis 7.
Photos and videos are stored only in Microsoft OneDrive; the server keeps the database, its backups, a small photo
cache (300 MB at most) and each upload for the moment it takes to reach OneDrive.

Everything below is done on the server (EC2 Instance Connect in the AWS console, or SSH as `ubuntu`).

## 1. Once: automatic updates from GitHub

```bash
cd /home/ubuntu/smru-event-scanner
git pull origin main
bash deploy/install-auto-update.sh
```

It ends with "Done. The server now checks GitHub every 2 minutes and updates itself." From then on every push to
`main` is live within about 2 minutes, and an update that fails (install, build, restart, or no health answer) puts
the previous version back by itself. How it works: README, "Automatic updates from GitHub".

**If it stops with a message instead:**

- *"Could not tell how the app is restarted"*: the app is not run by pm2 or systemd. Stop the way it runs now (so
  two copies do not fight over the port), then let pm2 run it:

  ```bash
  sudo npm install -g pm2
  cd /home/ubuntu/smru-event-scanner/server
  pm2 start dist/index.js --name event-photos
  pm2 save
  pm2 startup          # then run the sudo line it prints, so it starts again after a reboot
  cd .. && bash deploy/install-auto-update.sh "pm2 restart event-photos"
  ```

- *`git pull` says local changes would be overwritten*: `git status` shows them. If they are not needed,
  `git stash`, then pull again.
- *"git cannot fetch from GitHub without a password"*: the repository is public, so
  `git remote set-url origin https://github.com/Ram-9177/smru-event-scanner.git` and run the setup again.

**Check:** https://stmarys-event-scanner.supercxo.ai/healthz shows `{"ok":true}`. On the server,
`tail logs/update.log` says what each update did.

## 2. nginx

The site's `server` block (the `listen 443 ssl` and certificate lines certbot added stay as they are):

```nginx
server {
    server_name stmarys-event-scanner.supercxo.ai;

    # Organiser videos go up to 2 GB, student videos to 200 MB, photos to 60 MB (nginx stops at 1 MB by default).
    client_max_body_size 2100m;

    location / {
        proxy_pass http://127.0.0.1:3000;       # the app's PORT in server/.env
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_request_buffering off;            # uploads go straight to the app, which checks its room first
        proxy_buffering off;                    # videos and downloads stream through; nothing piles up on the disk
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }
}
```

Then `sudo nginx -t && sudo systemctl reload nginx`. The app trusts `X-Forwarded-*` only from this machine
(`TRUST_PROXY=loopback`, the default), and `HOST=127.0.0.1` in `server/.env` keeps its port closed to the outside.

## 3. Settings: `server/.env`

Start from `.env.example`. The values that matter on the live server:

```
NODE_ENV=production
PUBLIC_URL=https://stmarys-event-scanner.supercxo.ai
HOST=127.0.0.1
PORT=3000
SESSION_SECRET=...            # at least 32 characters; it also unlocks the OneDrive sign-in kept in the database
DATABASE_URL=postgres://...
REDIS_URL=redis://127.0.0.1:6379
ADMIN_EMAIL=...               # the main organiser's sign-in
ADMIN_PASSWORD=...
MS_TENANT_ID=...              # from the Entra app registration's Overview page
MS_CLIENT_ID=...
MS_CLIENT_SECRET=...          # from Certificates & secrets; set MS_CLIENT_SECRET_EXPIRES=YYYY-MM-DD to be warned in time
MS_ROOT=folder
MS_ROOT_FOLDER=Event Photos
```

The real values are in the private settings file the developer keeps (never in this repository, which is public).

There is no ngrok any more: `PUBLIC_URL` is the one link for QR codes, share links, emails and Microsoft sign-in.
After changing `server/.env`, restart the app (for example `pm2 restart event-photos`).

## 4. After the first update

- **Connect OneDrive:** organiser console, Settings, OneDrive, Connect OneDrive, signing in with the Microsoft account
  that holds the photos. The address Microsoft returns to,
  `https://stmarys-event-scanner.supercxo.ai/admin/onedrive/callback`, is already registered in Entra.
- **Give the server a bigger disk (20 to 30 GB).** It has 6.6 GB in all and 1.9 GB free; a video upload needs about
  2.3 times its size free, plus 1 GB, so today a video over about 390 MB cannot be taken. In the AWS console: EC2,
  Volumes, the server's volume, Modify, a bigger size. Then on the server (check the names with `lsblk`; on most
  current instances they are these):

  ```bash
  sudo growpart /dev/nvme0n1 1
  sudo resize2fs /dev/nvme0n1p1
  df -h /
  ```

## 5. Day to day

- **Updates:** nothing to do. Pushes to `main` go live by themselves. `logs/update.log` says what happened;
  `systemctl list-timers event-photos-update.timer` when it last ran; `sudo systemctl start event-photos-update.service`
  updates now; `sudo systemctl disable --now event-photos-update.timer` stops the automatic updates.
- **Health:** `/healthz` answers 200 `{"ok":true}` when PostgreSQL and Redis answer, 503 otherwise; it suits an
  uptime monitor.
- **Backups:** the app dumps the database every day into `backups/` and keeps the last 14. Copy them off the server
  now and then. Restore: `pg_restore --clean --if-exists --no-owner --no-acl -d "$DATABASE_URL" <file>`, with the app
  stopped.
