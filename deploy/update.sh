#!/usr/bin/env bash
# Event Photos on the live server: bring it up to date with GitHub (main), safely.
#
# A systemd timer runs this every 2 minutes (deploy/install-auto-update.sh sets that up once). Each run:
#   1. fetches main, and does nothing when the server already runs it
#   2. leaves the server alone (and says why, once) when files kept in git were changed on it, or it has commits
#      of its own
#   3. keeps the build that runs now, moves to the new commit, installs packages only when they changed, builds
#   4. restarts the app and waits for /healthz to answer {"ok":true}
#   5. if installing, the build, the restart or the health check fails: back to the previous commit and build
#      (restarted if the new one had been started), and that commit is not tried again until main changes
# One run at a time. What it does goes to logs/update.log.
#
# Settings (environment, or .update/settings written by the setup script):
#   UPDATE_RESTART_CMD  required: how this server restarts the app, e.g. "pm2 restart event-photos"
#   UPDATE_HEALTH_URL   default http://127.0.0.1:3000/healthz
#   UPDATE_REMOTE / UPDATE_BRANCH   default origin / main
#   UPDATE_BUILD_CMD    default "npm run build"; UPDATE_INSTALL_CMD default "npm ci --no-audit --no-fund"
#   UPDATE_HEALTH_WAIT  seconds to wait for the health answer, default 90
#   UPDATE_FORCE=1      build and restart even when nothing new came (the first run after setup)
set -Eeuo pipefail

APP_DIR="${UPDATE_APP_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
cd "$APP_DIR"
STATE="$APP_DIR/.update"
mkdir -p "$STATE"
# shellcheck disable=SC1091
if [ -f "$STATE/settings" ]; then . "$STATE/settings"; fi

REMOTE="${UPDATE_REMOTE:-origin}"
BRANCH="${UPDATE_BRANCH:-main}"
BUILD_CMD="${UPDATE_BUILD_CMD:-npm run build}"
INSTALL_CMD="${UPDATE_INSTALL_CMD:-npm ci --no-audit --no-fund}"
HEALTH_URL="${UPDATE_HEALTH_URL:-http://127.0.0.1:3000/healthz}"
HEALTH_WAIT="${UPDATE_HEALTH_WAIT:-90}"
HEALTH_DELAY="${UPDATE_HEALTH_DELAY:-3}"
LOG="${UPDATE_LOG:-$APP_DIR/logs/update.log}"
mkdir -p "$(dirname "$LOG")"

log() { printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >> "$LOG"; }
# The same note is written once, not every 2 minutes.
note() {
  if [ "$(cat "$STATE/last-note" 2>/dev/null)" != "$*" ]; then
    log "$*"
    printf '%s' "$*" > "$STATE/last-note"
  fi
}

if [ -z "${UPDATE_RESTART_CMD:-}" ]; then
  note "UPDATE_RESTART_CMD is not set, so nothing is updated (run deploy/install-auto-update.sh)"
  echo "UPDATE_RESTART_CMD is not set: how does this server restart the app?" >&2
  exit 2
fi

# One run at a time (mkdir is atomic); a lock older than an hour is from a run that died.
LOCK="$STATE/lock"
if ! mkdir "$LOCK" 2>/dev/null; then
  if [ -n "$(find "$LOCK" -maxdepth 0 -mmin +60 2>/dev/null)" ]; then
    rm -rf "$LOCK"
    mkdir "$LOCK"
  else
    exit 0
  fi
fi
trap 'rm -rf "$LOCK"' EXIT

if ! GIT_TERMINAL_PROMPT=0 git fetch --quiet "$REMOTE" "$BRANCH" 2>>"$LOG"; then
  note "could not fetch $REMOTE/$BRANCH from GitHub (no network, or git needs a password here)"
  exit 1
fi
OLD="$(git rev-parse HEAD)"
NEW="$(git rev-parse "$REMOTE/$BRANCH")"
short() { git rev-parse --short "$1"; }
force="${UPDATE_FORCE:-}"

if [ "$OLD" = "$NEW" ] && [ "$force" != 1 ]; then exit 0; fi
if [ "$OLD" != "$NEW" ] && [ "$force" != 1 ] && [ "$(cat "$STATE/failed" 2>/dev/null)" = "$NEW" ]; then
  note "waiting for a new commit on $BRANCH: $(short "$NEW") did not work (see above)"
  exit 0
fi

changed="$(git status --porcelain --untracked-files=no)"
if [ -n "$changed" ]; then
  note "not updated to $(short "$NEW"): files kept in git were changed on this server ($(printf '%s\n' "$changed" | awk '{print $NF}' | tr '\n' ' ' | sed 's/ $//')). Undo or commit them, and it updates by itself."
  exit 1
fi
if ! git merge-base --is-ancestor "$OLD" "$NEW"; then
  note "not updated to $(short "$NEW"): this server has commits that are not on $REMOTE/$BRANCH"
  exit 1
fi

# The build that runs now, to go back to.
rm -rf "$STATE/previous"
mkdir -p "$STATE/previous"
for d in web/dist server/dist; do
  if [ -d "$d" ]; then
    mkdir -p "$STATE/previous/$(dirname "$d")"
    cp -a "$d" "$STATE/previous/$d"
  fi
done
packages_changed=false
if [ "$OLD" != "$NEW" ] && ! git diff --quiet "$OLD" "$NEW" -- package-lock.json package.json server/package.json web/package.json; then
  packages_changed=true
fi

restart() {
  log "restarting: $UPDATE_RESTART_CMD"
  (eval "$UPDATE_RESTART_CMD") >> "$LOG" 2>&1
}
# strict: the answer must be {"ok":true}. loose: any answer will do (a version from before /healthz existed).
healthy() {
  sleep "$HEALTH_DELAY"
  waited=0
  while [ "$waited" -lt "$HEALTH_WAIT" ]; do
    if [ "$1" = strict ]; then
      if curl -fsS -m 5 "$HEALTH_URL" 2>/dev/null | grep -q '"ok":true'; then return 0; fi
    elif curl -fsS -m 5 -o /dev/null "$HEALTH_URL" 2>/dev/null; then
      return 0
    fi
    sleep 2
    waited=$((waited + 2))
  done
  return 1
}
# $1: what went wrong. $2: "restart" when the new version had been started.
back() {
  log "FAILED: $1. Going back to $(short "$OLD")."
  printf '%s\n' "$NEW" > "$STATE/failed"
  git reset --hard --quiet "$OLD"
  if $packages_changed; then
    (eval "$INSTALL_CMD") >> "$LOG" 2>&1 || log "could not install the previous packages again"
  fi
  for d in web/dist server/dist; do
    rm -rf "$d"
    if [ -d "$STATE/previous/$d" ]; then cp -a "$STATE/previous/$d" "$d"; fi
  done
  if [ "${2:-}" = restart ]; then
    if restart && healthy loose; then log "back on $(short "$OLD"), which answers"; else log "the previous version does not answer either: check the server"; fi
  else
    log "still running $(short "$OLD"): it was not stopped"
  fi
  exit 1
}

rm -f "$STATE/last-note"
if [ "$OLD" != "$NEW" ]; then
  log "updating $(short "$OLD") -> $(short "$NEW"): $(git log -1 --format=%s "$NEW")"
  git merge --ff-only --quiet "$NEW"
else
  log "building and restarting $(short "$NEW") (asked for)"
fi
if $packages_changed; then
  log "packages changed: installing"
  (eval "$INSTALL_CMD") >> "$LOG" 2>&1 || back "installing the packages did not work"
fi
(eval "$BUILD_CMD") >> "$LOG" 2>&1 || back "the build did not work"
restart || back "the restart command did not work" restart
healthy strict || back "the app did not answer $HEALTH_URL with {\"ok\":true} within $HEALTH_WAIT seconds" restart
rm -f "$STATE/failed"
rm -rf "$STATE/previous"
log "now running $(short "$NEW")"
