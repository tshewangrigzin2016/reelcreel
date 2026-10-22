#!/usr/bin/env bash
# =============================================================================
# Reelcreel - VPS entrypoint
# =============================================================================
#
# THIS IS THE DOCUMENTED VPS START COMMAND.  `bun run start` remains the plain
# local command (it assumes yt-dlp/ffmpeg are already installed system-wide and
# does not touch PATH). Use this script when you want the app to bootstrap its
# own toolchain:
#
#     bash scripts/start.sh          # or: bun run start:vps
#
# WHAT IT DOES, IN ORDER
#   1. Resolves the repo root from this file's location, so it can be launched
#      from any working directory (systemd, cron, a shell in /root, ...).
#   2. Prepends "$ROOT/.bin" to PATH. This is the whole mechanism behind the
#      project-local toolchain: server/lib/resolve-binary.ts only scans $PATH,
#      so whatever this script installed into ./.bin is found first, with no
#      database settings involved.
#   3. Runs scripts/setup-linux.sh, which installs/refreshes yt-dlp, ffmpeg +
#      ffprobe, a JS runtime and bun. That script is idempotent and exits 0 by
#      contract even when it cannot install something, so a broken bootstrap
#      never blocks startup. The call is guarded anyway.
#   4. Reads ./.bin/.js-runtime (written by setup) to decide the JS runtime for
#      yt-dlp. If it says "deno" and the operator has not already chosen a
#      runtime, exports YTD_JS_RUNTIME=deno. The server honours that variable as
#      an override of its `jsRuntime` setting default.
#   5. execs `bun run server/index.ts` so the app replaces this shell and
#      receives signals (Ctrl+C, SIGTERM from systemd/docker) directly.
#
# ENVIRONMENT VARIABLES
#   YTD_AUTO_UPDATE=1     passed through to setup-linux.sh: re-download
#                         ./.bin/yt-dlp when it is older than 24h.
#   YTD_JS_RUNTIME=...    node|deno. An explicit value is NEVER overridden by
#                         this script; only an unset value is filled in from the
#                         .js-runtime marker.
#   PORT, YTD_DATA_DIR    passed through unchanged to the server.
#
# TYPICAL SYSTEMD UNIT
#   [Service]
#   WorkingDirectory=/srv/reelcreel
#   ExecStart=/usr/bin/env bash /srv/reelcreel/scripts/start.sh
#   Environment=YTD_AUTO_UPDATE=1
#   Restart=on-failure
#
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BIN_DIR="$ROOT/.bin"
RUNTIME_MARKER="$BIN_DIR/.js-runtime"

cd "$ROOT"

# Project-local tools first. Everything setup-linux.sh installs lands in .bin
# and must shadow a possibly-stale system copy.
export PATH="$BIN_DIR:$PATH"

# --- 1. Bootstrap (never fatal) ---------------------------------------------
# setup-linux.sh exits 0 by contract. `|| true` covers the contract being
# broken by a future edit: the app must still attempt to start.
if [ -f "$ROOT/scripts/setup-linux.sh" ]; then
  bash "$ROOT/scripts/setup-linux.sh" || true
else
  printf '[start] warning: %s is missing; starting without a toolchain check.\n' \
    "$ROOT/scripts/setup-linux.sh" >&2
fi

# --- 2. JS runtime selection -------------------------------------------------
# The marker is the only durable channel out of the setup script (which runs as
# a child process and cannot export into this shell). An operator-provided
# YTD_JS_RUNTIME always wins.
if [ -z "${YTD_JS_RUNTIME:-}" ] && [ -f "$RUNTIME_MARKER" ]; then
  marker="$(tr -d '[:space:]' < "$RUNTIME_MARKER" 2>/dev/null || true)"
  case "$marker" in
    deno|node) export YTD_JS_RUNTIME="$marker" ;;
    *) printf '[start] warning: ignoring unrecognised .js-runtime marker: %s\n' "$marker" >&2 ;;
  esac
fi

# --- 3. Sanity checks --------------------------------------------------------
if ! command -v bun >/dev/null 2>&1; then
  # The installer drops bun in ~/.bun/bin and only edits shell profiles, which
  # a non-interactive shell never sources.
  if [ -x "${HOME:-/root}/.bun/bin/bun" ]; then
    export PATH="${HOME:-/root}/.bun/bin:$PATH"
  else
    printf '[start] error: bun is not installed. Run: bash scripts/setup-linux.sh\n' >&2
    printf '[start]        or install it from https://bun.sh\n' >&2
    exit 127
  fi
fi

if [ ! -f "$ROOT/server/index.ts" ]; then
  printf '[start] error: %s not found; is this the Reelcreel repo root?\n' "$ROOT/server/index.ts" >&2
  exit 1
fi

if [ ! -d "$ROOT/node_modules" ]; then
  printf '[start] error: node_modules/ is missing. Run: bun install\n' >&2
  exit 1
fi

# --- 4. Start ----------------------------------------------------------------
printf '[start] repo   : %s\n' "$ROOT"
if [ -n "${YTD_JS_RUNTIME:-}" ]; then
  printf '[start] js runtime for yt-dlp: %s\n' "$YTD_JS_RUNTIME"
else
  printf '[start] js runtime for yt-dlp: node (server default)\n'
fi
printf '[start] exec   : bun run server/index.ts\n'

# exec: replace this shell so signals reach the server directly.
exec bun run server/index.ts
