#!/bin/bash
# Event Photos: double-click to start. Close this window (or press Ctrl+C) to stop.
#
# It needs Node.js 22.18 or newer. If this Mac has none, the official one is downloaded from
# nodejs.org into the .tools folder here (checksum checked, no admin rights needed).
# Everything else happens in scripts/start.ts. What it prints is also kept in logs/start.log.

cd "$(dirname "$0")" || exit 1
ROOT="$(pwd)"
mkdir -p "$ROOT/logs"
LOG="$ROOT/logs/start.log"
say() { echo "$*"; echo "$(date '+%H:%M:%S') $*" >> "$LOG"; }

say ""
say "== Event Photos, $(date '+%d %b %Y %H:%M') =="

node_ok() {
  [ -n "$1" ] && [ -x "$1" ] &&
    "$1" -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=18)?0:1)' >/dev/null 2>&1
}

NODE=""
for c in "$(command -v node 2>/dev/null)" /opt/homebrew/bin/node /usr/local/bin/node "$HOME/.volta/bin/node" \
  "$HOME"/.nvm/versions/node/*/bin/node "$HOME/.local/share/fnm/aliases/default/bin/node" \
  "$HOME/Library/Application Support/fnm/aliases/default/bin/node" "$ROOT/.tools/node/bin/node"; do
  if node_ok "$c"; then NODE="$c"; break; fi
done

if [ -z "$NODE" ]; then
  case "$(uname -m)" in arm64|aarch64) A=arm64 ;; x86_64) A=x64 ;; *) A="" ;; esac
  case "$(uname -s)" in Darwin) O=darwin ;; Linux) O=linux ;; *) O="" ;; esac
  if [ -z "$A" ] || [ -z "$O" ]; then
    say "Install Node.js 22 or newer from https://nodejs.org, then double-click this file again."
    exit 1
  fi
  say "Node.js 22 or newer is not on this computer."
  say "Downloading the official Node.js 22 from nodejs.org into this folder (about 50 MB) ..."
  BASE="https://nodejs.org/dist/latest-v22.x"
  LINE="$(curl -fsSL "$BASE/SHASUMS256.txt" | grep " node-v[0-9.]*-$O-$A.tar.gz\$" | head -n 1)"
  FILE="${LINE##* }"
  SUM="${LINE%% *}"
  if [ -z "$LINE" ] || [ -z "$FILE" ]; then
    say "Could not reach nodejs.org. Check the internet connection, or install Node.js from https://nodejs.org, then double-click this file again."
    exit 1
  fi
  mkdir -p "$ROOT/.tools"
  if ! curl -fL --progress-bar -o "$ROOT/.tools/$FILE" "$BASE/$FILE"; then
    say "The download stopped. Double-click this file again."
    rm -f "$ROOT/.tools/$FILE"
    exit 1
  fi
  GOT="$( (shasum -a 256 "$ROOT/.tools/$FILE" 2>/dev/null || sha256sum "$ROOT/.tools/$FILE") | cut -d ' ' -f 1)"
  if [ "$GOT" != "$SUM" ]; then
    say "The download did not match the checksum nodejs.org publishes, so it was not used. Double-click this file again."
    rm -f "$ROOT/.tools/$FILE"
    exit 1
  fi
  rm -rf "$ROOT/.tools/node" "$ROOT/.tools/${FILE%.tar.gz}"
  tar -xzf "$ROOT/.tools/$FILE" -C "$ROOT/.tools" && mv "$ROOT/.tools/${FILE%.tar.gz}" "$ROOT/.tools/node"
  rm -f "$ROOT/.tools/$FILE"
  NODE="$ROOT/.tools/node/bin/node"
  if ! node_ok "$NODE"; then
    say "Node.js could not be set up. Install it from https://nodejs.org, then double-click this file again."
    exit 1
  fi
fi

say "Using Node.js $("$NODE" -v) ($NODE)"
export PATH="$(dirname "$NODE"):$PATH"
exec "$NODE" "$ROOT/scripts/start.ts" "$@"
