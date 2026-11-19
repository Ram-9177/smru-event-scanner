#!/usr/bin/env bash
# One-time setup on the live server: from now on it updates itself from GitHub (main), checking every 2 minutes.
# Run it in the app folder, as the user that owns it (not root), after pulling this file once by hand:
#
#   cd /home/ubuntu/smru-event-scanner && git pull origin main
#   bash deploy/install-auto-update.sh                              # finds how the app is restarted (pm2 or systemd)
#   bash deploy/install-auto-update.sh "pm2 restart event-photos"   # or say it yourself
#
# It checks that git can fetch from GitHub without a password, writes the settings to .update/settings, installs
# the systemd timer event-photos-update.timer, and runs the first update now (build, restart, health check).
# What each update does: deploy/update.sh. Its log: logs/update.log. To stop it:
#   sudo systemctl disable --now event-photos-update.timer
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$APP_DIR"
if [ "$(id -u)" = 0 ]; then
  echo "Run this as the user that owns $APP_DIR (for example ubuntu), not as root: it asks for sudo where needed." >&2
  exit 1
fi
command -v git >/dev/null && command -v curl >/dev/null && command -v npm >/dev/null || {
  echo "git, curl and npm must be installed and on the PATH." >&2
  exit 1
}

# How this server restarts the app: the argument, or found in pm2 or in a systemd service for this folder.
restart="${1:-}"
if [ -z "$restart" ] && command -v pm2 >/dev/null 2>&1; then
  names="$(pm2 jlist 2>/dev/null | node -e '
    let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
      try { for (const p of JSON.parse(s)) { const e = p.pm2_env || {}; if (`${e.pm_cwd} ${e.pm_exec_path}`.includes(process.argv[1])) console.log(p.name); } } catch {}
    });' "$APP_DIR" || true)"
  if [ "$(printf '%s\n' "$names" | grep -c .)" = 1 ]; then restart="pm2 restart $names"; fi
fi
if [ -z "$restart" ]; then
  units="$(grep -l -F -- "$APP_DIR" /etc/systemd/system/*.service 2>/dev/null | grep -v 'event-photos-update' | xargs -n1 basename 2>/dev/null || true)"
  if [ "$(printf '%s\n' "$units" | grep -c .)" = 1 ]; then restart="sudo systemctl restart $units"; fi
fi
if [ -z "$restart" ]; then
  echo "Could not tell how the app is restarted on this server. Give the command, for example:" >&2
  echo "  bash deploy/install-auto-update.sh \"pm2 restart event-photos\"" >&2
  echo "  bash deploy/install-auto-update.sh \"sudo systemctl restart event-photos\"" >&2
  exit 1
fi

port="$(grep -E '^PORT=' server/.env 2>/dev/null | tail -1 | cut -d= -f2- | tr -d "\"' " || true)"
port="${port:-3000}"
health="http://127.0.0.1:$port/healthz"

if ! GIT_TERMINAL_PROMPT=0 git fetch --quiet origin main; then
  echo "git cannot fetch from GitHub here without a password. Give the server read access first (a deploy key," >&2
  echo "or a token in the remote URL), then run this again." >&2
  exit 1
fi

mkdir -p .update logs
{
  echo "# Written by deploy/install-auto-update.sh on $(date '+%Y-%m-%d %H:%M'). Read by deploy/update.sh."
  printf 'UPDATE_RESTART_CMD=%q\n' "$restart"
  printf 'UPDATE_HEALTH_URL=%q\n' "$health"
  printf 'export PATH=%q\n' "$PATH"
} > .update/settings

sudo tee /etc/systemd/system/event-photos-update.service >/dev/null <<EOF
[Unit]
Description=Event Photos: update from GitHub main ($APP_DIR)
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=$(id -un)
WorkingDirectory=$APP_DIR
ExecStart=/bin/bash $APP_DIR/deploy/update.sh
SuccessExitStatus=1
EOF
sudo tee /etc/systemd/system/event-photos-update.timer >/dev/null <<EOF
[Unit]
Description=Event Photos: check GitHub for a new version every 2 minutes

[Timer]
OnBootSec=2min
OnUnitActiveSec=2min
Unit=event-photos-update.service

[Install]
WantedBy=timers.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable --now event-photos-update.timer >/dev/null

echo "Restart command: $restart"
echo "Health check:    $health"
echo "Running the first update now (build, restart, health check) ..."
if UPDATE_FORCE=1 bash deploy/update.sh; then
  echo "Done. The server now checks GitHub every 2 minutes and updates itself."
else
  echo "The first update did not work, and the server is back on the version it ran. See logs/update.log." >&2
fi
echo "Log: $APP_DIR/logs/update.log    Timer: systemctl list-timers event-photos-update.timer"
tail -n 5 logs/update.log 2>/dev/null || true
