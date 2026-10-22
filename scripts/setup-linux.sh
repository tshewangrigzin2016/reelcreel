#!/usr/bin/env bash
# =============================================================================
# Reelcreel - Linux / VPS toolchain bootstrap
# =============================================================================
#
# WHAT THIS IS
#   This is THE documented setup path for running Reelcreel on a Linux box
#   (VPS, container without its own image, bare metal). It makes sure the five
#   things the server needs actually work:
#
#     1. yt-dlp   (--version)      the downloader itself
#     2. ffmpeg   (-version)       muxing / post-processing
#     3. ffprobe  (-version)       file inspection (ships with ffmpeg)
#     4. a JS runtime (node or deno) - yt-dlp's EJS challenge solver needs it
#     5. bun                       the app runtime
#
#   It also checks yt-dlp's EJS (challenge solver) component, because the
#   /api/health panel only turns green when yt-dlp reports it. A yt-dlp that
#   cannot solve YouTube's challenge still downloads *nothing*, so this check
#   is the difference between "installed" and "working".
#
# HOW BINARIES ARE FOUND BY THE APP
#   server/lib/resolve-binary.ts walks every directory on $PATH, spawns each
#   candidate with its version flag, and keeps the first one that exits 0. It
#   has NO concept of a project-local bin directory and nothing here writes to
#   the SQLite settings table. Therefore:
#
#     ./.bin works purely because this script (and scripts/start.sh) puts
#     "$ROOT/.bin" at the FRONT of $PATH. Anything dropped in ./.bin wins over
#     a system copy, and deleting a file from ./.bin restores the system copy.
#
#   ffprobe gets special treatment in server/lib/ffprobe.ts: it looks for an
#   ffprobe sitting NEXT TO the resolved ffmpeg first, then falls back to
#   $PATH. That is why the static ffmpeg fallback installs BOTH binaries into
#   ./.bin as siblings.
#
# ENVIRONMENT VARIABLES
#   YTD_AUTO_UPDATE=1
#       Re-download ./.bin/yt-dlp when the copy there is older than 24 hours
#       (mtime based). A stale yt-dlp is what actually breaks downloads: YouTube
#       changes its player constantly, so a months-old binary silently starts
#       returning "no formats". Unset/anything else = never touch ./.bin/yt-dlp
#       beyond a normal install.
#
#   YTD_JS_RUNTIME=node|deno
#       Which JS runtime to select for yt-dlp. The server's `jsRuntime` setting
#       defaults to "node"; server/lib/db.ts honours this environment variable
#       as an override of that default (see the VPS notes in the repo). When
#       this script installs Deno it writes "deno" to ./.bin/.js-runtime and
#       scripts/start.sh exports YTD_JS_RUNTIME=deno from that marker, so a
#       plain `bash scripts/start.sh` selects the runtime that was installed.
#       An explicit YTD_JS_RUNTIME from the operator always wins over the
#       auto-detection below.
#
#   PATH / HOME / NO_COLOR
#       Read as usual. PATH is exported with ./.bin prepended. HOME is where
#       the Bun installer drops ~/.bun/bin (never installed with sudo).
#
# CONTRACT (important for the entrypoint)
#   * Idempotent and cheap on repeat runs: every tool is probed with its
#     version flag first, and anything already working is skipped. Safe to run
#     on every boot.
#   * This script NEVER fails app startup. Any unrecoverable problem prints a
#     clear warning and the script still exits 0. Only a genuinely broken
#     invocation (wrong OS, unreadable repo root) exits non-zero.
#   * It must not require root. Package managers are used opportunistically via
#     passwordless `sudo -n`; when that is unavailable every install falls back
#     to a user-space download into ./.bin, or is skipped with a warning.
#
# USAGE
#   bash scripts/setup-linux.sh      # one-off / on every boot
#   bun run setup:linux              # same thing through npm scripts
#   YTD_AUTO_UPDATE=1 bun run start:vps   # daily yt-dlp refresh + start
#
# =============================================================================

set -euo pipefail

# ---------------------------------------------------------------------------
# Layout. Resolved from this file's own location so the script works from any
# working directory (cron, systemd, a shell sitting in /root, ...).
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BIN_DIR="$ROOT/.bin"
RUNTIME_MARKER="$BIN_DIR/.js-runtime"

# ---------------------------------------------------------------------------
# Logging. Colours only on a terminal, and NO_COLOR always wins.
# ---------------------------------------------------------------------------
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  C_RESET=$'\033[0m'
  C_DIM=$'\033[2m'
  C_BOLD=$'\033[1m'
  C_RED=$'\033[31m'
  C_GREEN=$'\033[32m'
  C_YELLOW=$'\033[33m'
  C_CYAN=$'\033[36m'
else
  C_RESET='' C_DIM='' C_BOLD='' C_RED='' C_GREEN='' C_YELLOW='' C_CYAN=''
fi

log()  { printf '%s[setup]%s %s\n' "$C_CYAN" "$C_RESET" "$*"; }
ok()   { printf '%s[ ok ]%s %s\n' "$C_GREEN" "$C_RESET" "$*"; }
skip() { printf '%s[skip]%s %s\n' "$C_DIM" "$C_RESET" "$*"; }
warn() { printf '%s[warn]%s %s\n' "$C_YELLOW" "$C_RESET" "$*" >&2; }
fail() { printf '%s[fail]%s %s\n' "$C_RED" "$C_RESET" "$*" >&2; }

# ---------------------------------------------------------------------------
# Exit handling. Two rules:
#   1. Always clean up temp dirs.
#   2. Always exit 0 unless HARD_FAIL is set (broken invocation only), so a
#      failed bootstrap can never take the app down.
# ---------------------------------------------------------------------------
CLEANUP_DIRS=()
HARD_FAIL=0

cleanup() {
  local code=$?
  local d
  for d in ${CLEANUP_DIRS[@]+"${CLEANUP_DIRS[@]}"}; do
    [ -n "$d" ] && rm -rf "$d" 2>/dev/null || true
  done
  if [ "$HARD_FAIL" -eq 1 ]; then
    exit 1
  fi
  if [ "$code" -ne 0 ]; then
    warn "setup stopped early (internal exit $code). The app can still start if"
    warn "its tools are already installed; check /api/health after booting."
  fi
  exit 0
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
# Preconditions. These are the only conditions allowed to exit non-zero:
# this script manipulates Linux binaries and cannot be meaningfully run
# anywhere else (e.g. accidentally invoked from Windows git-bash).
# ---------------------------------------------------------------------------
UNAME_S="$(uname -s 2>/dev/null || echo unknown)"
if [ "$UNAME_S" != "Linux" ]; then
  fail "This script targets Linux; detected '$UNAME_S'."
  fail "On Windows/macOS install yt-dlp, ffmpeg and bun yourself and run 'bun run start'."
  HARD_FAIL=1
  exit 1
fi

if [ ! -d "$ROOT" ] || [ ! -f "$ROOT/package.json" ]; then
  fail "Could not locate the Reelcreel repo root (expected package.json in '$ROOT')."
  HARD_FAIL=1
  exit 1
fi

# .bin first on PATH for this script and, via start.sh, for the app itself.
mkdir -p "$BIN_DIR" 2>/dev/null || {
  fail "Cannot create $BIN_DIR (read-only checkout?). Falling back to system tools only."
}
export PATH="$BIN_DIR:$PATH"

# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------

# tool_ok <name> <version-flag>
# Resolves <name> on $PATH and spawns it with the version flag. This mirrors
# exactly what resolve-binary.ts does, so "works here" means "works for the app".
tool_ok() {
  local name="$1" flag="$2" path
  path="$(command -v "$name" 2>/dev/null || true)"
  [ -n "$path" ] || return 1
  [ -x "$path" ] || return 1
  "$path" "$flag" >/dev/null 2>&1
}

# exec_ok <abs-path> <version-flag>
# Runs THAT EXACT FILE, bypassing $PATH. This distinction matters: `tool_ok`
# answers "is some working copy reachable?", while this answers "does this
# specific file run here?". A downloaded glibc binary on musl/Alpine, or a
# partially written one, must be rejected BEFORE it is moved into ./.bin --
# otherwise it shadows a perfectly good system copy and breaks every download.
exec_ok() {
  local path="$1" flag="$2"
  [ -f "$path" ] || return 1
  [ -x "$path" ] || return 1
  "$path" "$flag" >/dev/null 2>&1
}

# read_version <path> <flag> [field]
# First line of the version output, optionally a single whitespace-separated
# field (ffmpeg prints "ffmpeg version 6.1.1-... Copyright ...", so field 3).
# awk is used instead of `head` on purpose: closing the pipe early would trip
# `set -o pipefail` with SIGPIPE on chatty binaries.
read_version() {
  local path="$1" flag="$2" field="${3:-0}" out
  out="$("$path" "$flag" 2>/dev/null | awk -v f="$field" 'NR==1 { if (f > 0) print $f; else print }')" || out=""
  out="${out%%$'\r'*}"
  [ -n "$out" ] || out="?"
  printf '%s' "$out"
}

# fetch <url> <dest>  -> 0 on success, non-zero on any failure.
fetch() {
  local url="$1" dest="$2"
  rm -f "$dest" 2>/dev/null || true
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --retry 3 --retry-delay 2 --connect-timeout 20 -o "$dest" "$url" || true
  elif command -v wget >/dev/null 2>&1; then
    wget -q --tries=3 --timeout=25 -O "$dest" "$url" || true
  else
    return 1
  fi
  if [ -s "$dest" ]; then
    return 0
  fi
  rm -f "$dest" 2>/dev/null || true
  return 1
}

# unzip_to <archive> <dir>. Minimal images often ship no `unzip`, so fall back
# to bsdtar / busybox / python3 before giving up.
unzip_to() {
  local archive="$1" dir="$2"
  mkdir -p "$dir" 2>/dev/null || return 1
  if command -v unzip >/dev/null 2>&1; then
    unzip -q -o "$archive" -d "$dir" >/dev/null 2>&1 && return 0
  fi
  if command -v bsdtar >/dev/null 2>&1; then
    bsdtar -xf "$archive" -C "$dir" >/dev/null 2>&1 && return 0
  fi
  if command -v busybox >/dev/null 2>&1; then
    busybox unzip -q -o "$archive" -d "$dir" >/dev/null 2>&1 && return 0
  fi
  if command -v python3 >/dev/null 2>&1; then
    python3 -m zipfile -e "$archive" "$dir" >/dev/null 2>&1 && return 0
  fi
  return 1
}

# mktemp dir that cleanup() removes on exit.
new_tmp() {
  local d
  d="$(mktemp -d 2>/dev/null || mktemp -d -t reelcreel)"
  CLEANUP_DIRS+=("$d")
  printf '%s' "$d"
}

# run_privileged <cmd...>: root, or passwordless sudo, or 127 = no path.
# 127 tells the caller "no privilege available, use the user-space fallback".
run_privileged() {
  if [ "$(id -u 2>/dev/null || echo 1)" -eq 0 ]; then
    "$@"
    return $?
  fi
  if command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then
    sudo -n "$@"
    return $?
  fi
  return 127
}

have_root() {
  [ "$(id -u 2>/dev/null || echo 1)" -eq 0 ] && return 0
  command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1
}

detect_pm() {
  local pm
  for pm in apt-get dnf yum apk pacman; do
    if command -v "$pm" >/dev/null 2>&1; then
      printf '%s' "$pm"
      return 0
    fi
  done
  return 1
}

# Normalised CPU architecture. Drives which static assets we can fetch.
detect_arch() {
  local machine
  machine="$(uname -m 2>/dev/null || echo unknown)"
  case "$machine" in
    x86_64|amd64)   printf 'amd64' ;;
    aarch64|arm64)  printf 'arm64' ;;
    armv7l|armv6l)  printf 'armhf' ;;
    *)              printf '%s' "$machine" ;;
  esac
}

# is_older_than_24h <file>  -> 0 when the file exists and is >24h old.
is_older_than_24h() {
  local file="$1" mtime now
  if command -v find >/dev/null 2>&1; then
    if [ -n "$(find "$file" -maxdepth 0 -mmin +1440 -print 2>/dev/null)" ]; then
      return 0
    fi
    return 1
  fi
  # No find: fall back to stat + date. GNU stat first, then BSD/macOS syntax.
  mtime="$(stat -c %Y "$file" 2>/dev/null || stat -f %m "$file" 2>/dev/null || echo 0)"
  now="$(date +%s 2>/dev/null || echo 0)"
  case "$mtime$now" in
    ''|*[!0-9]*) return 1 ;;
  esac
  [ $((now - mtime)) -gt 86400 ]
}

# write_runtime_marker <node|deno>. scripts/start.sh reads this to decide which
# runtime to export as YTD_JS_RUNTIME.
write_runtime_marker() {
  local want="$1" current=""
  if [ -f "$RUNTIME_MARKER" ]; then
    current="$(tr -d '[:space:]' < "$RUNTIME_MARKER" 2>/dev/null || echo '')"
  fi
  if [ "$current" != "$want" ]; then
    printf '%s\n' "$want" > "$RUNTIME_MARKER" 2>/dev/null || warn "Could not write $RUNTIME_MARKER."
  fi
}

ARCH_KIND="$(detect_arch)"
PM="$(detect_pm 2>/dev/null || true)"

# Action labels for the summary table: found | installed | updated | missing.
FFMPEG_ACTION="missing"
YTDLP_ACTION="missing"
JS_ACTION="missing"
BUN_ACTION="missing"
DENO_ACTION="missing"
JS_RUNTIME=""
EJS_STATUS="not checked"
YTDLP_NOTE=""

# ===========================================================================
# Step 1 - ffmpeg + ffprobe
# ===========================================================================
step_ffmpeg() {
  if tool_ok ffmpeg -version && tool_ok ffprobe -version; then
    FFMPEG_ACTION="found"
    skip "ffmpeg + ffprobe already working: $(command -v ffmpeg)"
    return 0
  fi

  # Prefer the distro package: it is signed, patched and pulls ffprobe with it.
  if [ -n "$PM" ]; then
    if ! have_root; then
      warn "No root and no passwordless sudo: skipping '$PM' install of ffmpeg."
    else
      log "Installing ffmpeg via $PM (this also provides ffprobe)..."
      local installed=0
      case "$PM" in
        apt-get)
          run_privileged env DEBIAN_FRONTEND=noninteractive apt-get update -qq >/dev/null 2>&1 || true
          run_privileged env DEBIAN_FRONTEND=noninteractive \
            apt-get install -y -qq --no-install-recommends ffmpeg >/dev/null 2>&1 && installed=1
          ;;
        dnf)
          # Fedora/RHEL need RPM Fusion for ffmpeg; if the repo is missing this
          # fails fast and we drop through to the static build below.
          run_privileged dnf install -y ffmpeg >/dev/null 2>&1 && installed=1
          ;;
        yum)
          run_privileged yum install -y ffmpeg >/dev/null 2>&1 && installed=1
          ;;
        apk)
          run_privileged apk add --no-cache ffmpeg >/dev/null 2>&1 && installed=1
          ;;
        pacman)
          run_privileged pacman -Sy --noconfirm ffmpeg >/dev/null 2>&1 && installed=1
          ;;
      esac
      if [ "$installed" -eq 1 ] && tool_ok ffmpeg -version && tool_ok ffprobe -version; then
        FFMPEG_ACTION="installed"
        ok "ffmpeg + ffprobe installed via $PM: $(command -v ffmpeg)"
        return 0
      fi
      warn "'$PM' could not provide a working ffmpeg/ffprobe; trying a static build."
    fi
  else
    warn "No supported package manager found (apt-get/dnf/yum/apk/pacman)."
  fi

  # Static fallback. Only the amd64 builds are handled here on purpose: the
  # arm64/armhf tarballs exist upstream but are not part of the supported path.
  if [ "$ARCH_KIND" != "amd64" ]; then
    warn "Static ffmpeg fallback is x86_64-only; this host is '$ARCH_KIND'."
    warn "Install ffmpeg manually so that BOTH 'ffmpeg -version' and 'ffprobe -version' work."
    return 1
  fi

  log "Downloading a static ffmpeg build (amd64) into $BIN_DIR ..."
  local tmp archive url
  tmp="$(new_tmp)"
  archive="$tmp/ffmpeg.tar.xz"
  for url in \
    "https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz" \
    "https://github.com/BtbN/FFmpeg-Builds/releases/latest/download/ffmpeg-master-latest-linux64-gpl.tar.xz"
  do
    if ! fetch "$url" "$archive"; then
      warn "Download failed: $url"
      continue
    fi
    # -J needs xz support; plain -xf autodetects compression on modern tar.
    if ! tar -xJf "$archive" -C "$tmp" >/dev/null 2>&1; then
      if ! tar -xf "$archive" -C "$tmp" >/dev/null 2>&1; then
        warn "Could not extract $archive (need tar with xz support)."
        continue
      fi
    fi
    local ffbin pbin
    ffbin="$(find "$tmp" -type f -name ffmpeg -print -quit 2>/dev/null || true)"
    pbin="$(find "$tmp" -type f -name ffprobe -print -quit 2>/dev/null || true)"
    if [ -z "$ffbin" ] || [ -z "$pbin" ]; then
      warn "Archive did not contain both ffmpeg and ffprobe: $url"
      continue
    fi
    # ffprobe must be a SIBLING of ffmpeg: server/lib/ffprobe.ts looks there
    # first, and this pair is what --ffmpeg-location points yt-dlp at.
    # Validate the extracted files BEFORE installing them, so a build that
    # cannot run here (musl libc, wrong arch) never lands in ./.bin and
    # shadows a working system ffmpeg.
    chmod 0755 "$ffbin" "$pbin" 2>/dev/null || true
    if ! exec_ok "$ffbin" -version || ! exec_ok "$pbin" -version; then
      warn "Static ffmpeg downloaded but does not run on this host (musl libc?)."
      continue
    fi
    cp -f "$ffbin" "$BIN_DIR/ffmpeg" 2>/dev/null || { warn "Cannot write $BIN_DIR/ffmpeg."; return 1; }
    cp -f "$pbin" "$BIN_DIR/ffprobe" 2>/dev/null || { warn "Cannot write $BIN_DIR/ffprobe."; return 1; }
    chmod 0755 "$BIN_DIR/ffmpeg" "$BIN_DIR/ffprobe" 2>/dev/null || true
    if exec_ok "$BIN_DIR/ffmpeg" -version && exec_ok "$BIN_DIR/ffprobe" -version; then
      FFMPEG_ACTION="installed"
      ok "Static ffmpeg + ffprobe installed into $BIN_DIR"
      return 0
    fi
    # Installed copy does not run: remove it rather than let it shadow.
    rm -f "$BIN_DIR/ffmpeg" "$BIN_DIR/ffprobe" 2>/dev/null || true
    warn "Static ffmpeg failed after install; removed it from $BIN_DIR."
    continue
  done

  warn "Could not install ffmpeg automatically. Downloads and conversions need it."
  return 1
}

# ===========================================================================
# Step 2 - yt-dlp
# ===========================================================================
# The standalone release binaries are self-contained PyInstaller builds: no
# Python, no pip, one file. They are built with yt-dlp's default dependencies,
# which include the yt-dlp-ejs challenge solver -- the same component the
# /api/health check looks for. That is why this is preferred over the
# `yt-dlp` python zipapp or an old distro package.
install_ytdlp_static() {
  local asset url tmp target
  case "$ARCH_KIND" in
    amd64) asset="yt-dlp_linux" ;;
    arm64) asset="yt-dlp_linux_aarch64" ;;
    *)
      warn "No official standalone yt-dlp build for architecture '$ARCH_KIND'."
      return 1
      ;;
  esac
  url="https://github.com/yt-dlp/yt-dlp/releases/latest/download/$asset"
  tmp="$(new_tmp)"
  target="$BIN_DIR/yt-dlp"
  log "Downloading $asset ..."
  if ! fetch "$url" "$tmp/yt-dlp"; then
    warn "Download failed: $url"
    return 1
  fi
  # Install via a temp file in the same directory, then mv: a killed download
  # must never leave a truncated binary shadowing a working one on $PATH.
  if ! cp -f "$tmp/yt-dlp" "$target.tmp" 2>/dev/null; then
    warn "Cannot write to $BIN_DIR."
    return 1
  fi
  chmod 0755 "$target.tmp" 2>/dev/null || true
  # Validate the candidate itself, not "some yt-dlp on $PATH". On musl/Alpine
  # the glibc standalone build downloads fine and then refuses to exec; moving
  # it into ./.bin would shadow a working system copy and break every download.
  if ! exec_ok "$target.tmp" --version; then
    rm -f "$target.tmp" 2>/dev/null || true
    warn "Downloaded $asset does not execute on this host; discarded."
    return 1
  fi
  mv -f "$target.tmp" "$target" 2>/dev/null || { rm -f "$target.tmp"; return 1; }
  return 0
}

# Last resort only. Distro packages are frequently stale (the exact failure
# mode YTD_AUTO_UPDATE exists to prevent) and may not carry the EJS solver, so
# this is used only after the static binary failed to download or execute.
install_ytdlp_pm() {
  [ -n "$PM" ] || return 1
  have_root || return 1
  warn "Falling back to '$PM' for yt-dlp: the distro package is often outdated"
  warn "and may lack the EJS solver. Check /api/health afterwards."
  case "$PM" in
    apt-get) run_privileged env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq yt-dlp >/dev/null 2>&1 ;;
    dnf)     run_privileged dnf install -y yt-dlp >/dev/null 2>&1 ;;
    yum)     run_privileged yum install -y yt-dlp >/dev/null 2>&1 ;;
    apk)     run_privileged apk add --no-cache yt-dlp >/dev/null 2>&1 ;;
    pacman)  run_privileged pacman -Sy --noconfirm yt-dlp >/dev/null 2>&1 ;;
    *) return 1 ;;
  esac
}

step_ytdlp() {
  # A previous run may have left a binary in ./.bin that this host cannot exec
  # (different libc, corrupted download). Because ./.bin is first on $PATH it
  # would shadow a working system yt-dlp forever, so drop it here.
  if [ -f "$BIN_DIR/yt-dlp" ] && ! exec_ok "$BIN_DIR/yt-dlp" --version; then
    warn "Removing unusable $BIN_DIR/yt-dlp (does not execute on this host)."
    rm -f "$BIN_DIR/yt-dlp" 2>/dev/null || true
  fi

  if tool_ok yt-dlp --version; then
    YTDLP_ACTION="found"
    skip "yt-dlp already working: $(command -v yt-dlp)"
    return 0
  fi

  if install_ytdlp_static && exec_ok "$BIN_DIR/yt-dlp" --version; then
    YTDLP_ACTION="installed"
    ok "yt-dlp installed: $BIN_DIR/yt-dlp ($(read_version "$BIN_DIR/yt-dlp" --version 1))"
    return 0
  fi

  if install_ytdlp_pm && tool_ok yt-dlp --version; then
    YTDLP_ACTION="installed"
    YTDLP_NOTE="distro package - verify EJS support below"
    ok "yt-dlp installed via $PM: $(command -v yt-dlp)"
    return 0
  fi

  warn "yt-dlp is missing. Downloads will fail until it is installed."
  warn "Manual install: curl -fsSL -o .bin/yt-dlp \\"
  warn "  https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux && chmod +x .bin/yt-dlp"
  return 1
}

# ===========================================================================
# Step 3 - JS runtime for yt-dlp's EJS challenge solver
# ===========================================================================
# Distro Node packages are frequently too old for yt-dlp's EJS solver, so this
# step prefers an already-working node, and otherwise installs the Deno single
# static binary into ./.bin (one file, no root, no package manager). Deno is
# then selected with YTD_JS_RUNTIME=deno / the .js-runtime marker.
install_deno_static() {
  local asset url tmp
  case "$ARCH_KIND" in
    amd64) asset="deno-x86_64-unknown-linux-gnu.zip" ;;
    arm64) asset="deno-aarch64-unknown-linux-gnu.zip" ;;
    armhf) asset="deno-armv7-unknown-linux-gnueabihf.zip" ;;
    *)
      warn "No Deno build for architecture '$ARCH_KIND'."
      return 1
      ;;
  esac
  url="https://github.com/denoland/deno/releases/latest/download/$asset"
  tmp="$(new_tmp)"
  log "Downloading $asset ..."
  if ! fetch "$url" "$tmp/deno.zip"; then
    warn "Download failed: $url"
    return 1
  fi
  if ! unzip_to "$tmp/deno.zip" "$tmp/out"; then
    warn "Cannot extract the Deno archive (no unzip/bsdtar/busybox/python3)."
    return 1
  fi
  local bin
  bin="$(find "$tmp/out" -type f -name deno -print -quit 2>/dev/null || true)"
  if [ -z "$bin" ]; then
    warn "Deno archive did not contain a 'deno' binary."
    return 1
  fi
  cp -f "$bin" "$BIN_DIR/deno.tmp" 2>/dev/null || { warn "Cannot write $BIN_DIR/deno."; return 1; }
  chmod 0755 "$BIN_DIR/deno.tmp" 2>/dev/null || true
  # Same rule as yt-dlp: prove the candidate executes before it can shadow
  # anything on $PATH.
  if ! exec_ok "$BIN_DIR/deno.tmp" --version; then
    rm -f "$BIN_DIR/deno.tmp" 2>/dev/null || true
    warn "Downloaded deno does not execute on this host; discarded."
    return 1
  fi
  mv -f "$BIN_DIR/deno.tmp" "$BIN_DIR/deno" 2>/dev/null || { rm -f "$BIN_DIR/deno.tmp"; return 1; }
  return 0
}

use_runtime() {
  JS_RUNTIME="$1"
  JS_ACTION="$2"
  write_runtime_marker "$JS_RUNTIME"
  if [ "$JS_RUNTIME" = "deno" ] && [ -z "${YTD_JS_RUNTIME:-}" ]; then
    # Only affects children of this script; start.sh re-exports it from the
    # marker file, which is the durable channel.
    export YTD_JS_RUNTIME="deno"
  fi
}

step_js_runtime() {
  # An explicit operator choice wins, as long as that runtime actually works.
  case "${YTD_JS_RUNTIME:-}" in
    deno)
      if tool_ok deno --version; then
        use_runtime deno found
        skip "YTD_JS_RUNTIME=deno and deno works: $(command -v deno)"
        return 0
      fi
      warn "YTD_JS_RUNTIME=deno but deno does not work; auto-detecting instead."
      ;;
    node)
      if tool_ok node --version; then
        use_runtime node found
        skip "YTD_JS_RUNTIME=node and node works: $(command -v node)"
        return 0
      fi
      warn "YTD_JS_RUNTIME=node but node does not work; auto-detecting instead."
      ;;
  esac

  if tool_ok node --version; then
    local node_path node_version major
    node_path="$(command -v node)"
    node_version="$(read_version "$node_path" --version 1)"
    major="${node_version#v}"
    major="${major%%.*}"
    case "$major" in
      ''|*[!0-9]*) ;; # unparseable version: leave it alone
      *)
        if [ "$major" -lt 20 ]; then
          warn "node $node_version is quite old; yt-dlp's EJS solver expects a"
          warn "recent Node. If challenge solving fails, install Deno and set"
          warn "YTD_JS_RUNTIME=deno."
        fi
        ;;
    esac
    use_runtime node found
    skip "node already working: $node_path ($node_version)"
    return 0
  fi

  # No usable node. A Deno left over from an earlier run is good enough.
  if tool_ok deno --version; then
    use_runtime deno found
    DENO_ACTION="found"
    ok "deno already working: $(command -v deno)"
    return 0
  fi

  if install_deno_static && tool_ok deno --version; then
    use_runtime deno installed
    DENO_ACTION="installed"
    ok "deno installed: $BIN_DIR/deno ($(read_version "$BIN_DIR/deno" --version 2))"
    ok "YTD_JS_RUNTIME=deno recorded in $RUNTIME_MARKER"
    return 0
  fi

  warn "No JS runtime available. yt-dlp cannot solve YouTube's challenge without"
  warn "one, so the health panel will stay red. Install node >= 20 or deno."
  return 1
}

# ===========================================================================
# Step 4 - bun (app runtime)
# ===========================================================================
step_bun() {
  if tool_ok bun --version; then
    BUN_ACTION="found"
    skip "bun already working: $(command -v bun)"
    return 0
  fi
  # Never sudo: the official installer is a per-user install in ~/.bun/bin.
  if ! command -v curl >/dev/null 2>&1 && ! command -v wget >/dev/null 2>&1; then
    warn "bun is missing and neither curl nor wget is available to install it."
    return 1
  fi
  log "Installing bun into \$HOME/.bun via https://bun.sh/install ..."
  # Output is left visible: this is a real download on first run and the
  # operator should see progress/failure. Failure is never fatal.
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL https://bun.sh/install | bash || true
  else
    wget -qO- https://bun.sh/install | bash || true
  fi
  if [ -x "${HOME:-/root}/.bun/bin/bun" ]; then
    export PATH="${HOME:-/root}/.bun/bin:$PATH"
    BUN_ACTION="installed"
    ok "bun installed: ${HOME:-/root}/.bun/bin/bun"
    return 0
  fi
  if tool_ok bun --version; then
    BUN_ACTION="installed"
    ok "bun installed: $(command -v bun)"
    return 0
  fi
  warn "bun installation failed. Install it manually from https://bun.sh and rerun."
  return 1
}

# ===========================================================================
# Step 5 - daily yt-dlp refresh (YTD_AUTO_UPDATE=1)
# ===========================================================================
# YouTube changes its player constantly; an outdated yt-dlp is the single most
# common cause of "this video has no formats". With YTD_AUTO_UPDATE=1 the copy
# in ./.bin is re-downloaded whenever it is more than 24 hours old. Because
# ./.bin is first on $PATH this also shadows a system yt-dlp, which is the
# intent: the app then always runs the fresh one.
step_auto_update() {
  if [ "${YTD_AUTO_UPDATE:-0}" != "1" ]; then
    return 0
  fi
  local target="$BIN_DIR/yt-dlp"
  if [ -f "$target" ] && ! is_older_than_24h "$target"; then
    skip "yt-dlp in .bin is younger than 24h; no refresh needed."
    return 0
  fi
  if [ -f "$target" ]; then
    log "yt-dlp in .bin is older than 24h; refreshing (YTD_AUTO_UPDATE=1) ..."
  else
    log "YTD_AUTO_UPDATE=1: placing a fresh yt-dlp in .bin ..."
  fi
  if install_ytdlp_static && exec_ok "$target" --version; then
    YTDLP_ACTION="updated"
    ok "yt-dlp refreshed: $(read_version "$target" --version 1)"
    return 0
  fi
  # install_ytdlp_static validates before replacing, so the old binary is still
  # intact here. Say so explicitly: the operator needs to know the copy being
  # used may be stale rather than assume the refresh worked.
  warn "yt-dlp refresh failed; keeping the existing binary."
  return 1
}

# ===========================================================================
# Step 6 - EJS (challenge solver) diagnostic
# ===========================================================================
# /api/health marks the install unhealthy unless yt-dlp's verbose output
# mentions the EJS component. Reproducing that check here means the operator
# learns about it during setup instead of from a red panel afterwards.
# Non-fatal by design: the app must still boot.
step_ejs_check() {
  local yt out
  yt="$(command -v yt-dlp 2>/dev/null || true)"
  if [ -z "$yt" ]; then
    EJS_STATUS="unknown (yt-dlp missing)"
    return 0
  fi
  out=""
  if command -v timeout >/dev/null 2>&1; then
    out="$(timeout 25 "$yt" --ignore-config --verbose --simulate 2>&1 || true)"
  else
    out="$("$yt" --ignore-config --verbose --simulate 2>&1 || true)"
  fi
  if printf '%s' "$out" | grep -qiE 'yt_dlp_ejs|yt-dlp-ejs|ejs-'; then
    EJS_STATUS="available"
    ok "yt-dlp reports its EJS challenge solver."
  else
    EJS_STATUS="NOT DETECTED"
    warn "yt-dlp does not report an EJS component. The health panel will be red"
    warn "and YouTube downloads may fail. Use the standalone release binary"
    warn "(this script's default) or 'pip install -U yt-dlp yt-dlp-ejs'."
  fi
  return 0
}

# ===========================================================================
# Summary
# ===========================================================================
summary_row() {
  local label="$1" cmd="$2" flag="$3" field="$4" action="$5"
  local path version
  path="$(command -v "$cmd" 2>/dev/null || true)"
  if [ -n "$path" ] && [ -x "$path" ]; then
    version="$(read_version "$path" "$flag" "$field")"
    # ffmpeg reports "9.0.1-full_build-www.gyan.dev"; keep the table aligned by
    # showing the leading release number only.
    version="${version%%-*}"
    if [ "${#version}" -gt 22 ]; then
      version="${version:0:21}~"
    fi
    printf '  %-8s %-11s %-24s %s\n' "$label" "$action" "$version" "$path"
  else
    printf '  %-8s %-11s %-24s %s\n' "$label" "missing" "-" "-"
  fi
}

print_summary() {
  printf '\n'
  printf '%s' "$C_BOLD"
  printf 'Reelcreel toolchain summary\n'
  printf '%s' "$C_RESET"
  printf '  repo root: %s\n' "$ROOT"
  printf '  local bin: %s\n' "$BIN_DIR"
  printf '  package mgr: %s   arch: %s\n' "${PM:-none}" "$ARCH_KIND"
  printf '\n'
  printf '  %-8s %-11s %-24s %s\n' "TOOL" "STATUS" "VERSION" "PATH"
  printf '  %s\n' "-------------------------------------------------------------------------------"
  summary_row "bun"     "bun"     "--version" 1 "$BUN_ACTION"
  summary_row "yt-dlp"  "yt-dlp"  "--version" 1 "$YTDLP_ACTION"
  summary_row "ffmpeg"  "ffmpeg"  "-version"  3 "$FFMPEG_ACTION"
  summary_row "ffprobe" "ffprobe" "-version"  3 "$FFMPEG_ACTION"
  summary_row "node"    "node"    "--version" 1 "$JS_ACTION"
  summary_row "deno"    "deno"    "--version" 2 "$DENO_ACTION"
  printf '\n'
  printf '  yt-dlp EJS solver : %s\n' "$EJS_STATUS"
  printf '  yt-dlp source     : %s\n' "$(command -v yt-dlp 2>/dev/null || echo 'not installed')"
  printf '  js runtime        : %s%s\n' "${JS_RUNTIME:-none}" \
    "$( [ -f "$RUNTIME_MARKER" ] && printf ' (marker: %s)' "$(tr -d '[:space:]' < "$RUNTIME_MARKER" 2>/dev/null)" || true )"
  printf '  YTD_JS_RUNTIME    : %s\n' "${YTD_JS_RUNTIME:-<unset>}"
  printf '  YTD_AUTO_UPDATE   : %s\n' "${YTD_AUTO_UPDATE:-<unset>}"
  if [ -n "$YTDLP_NOTE" ]; then
    printf '  note              : %s\n' "$YTDLP_NOTE"
  fi
  printf '\n'
  if [ -f "$ROOT/node_modules/.bin/vite" ] || [ -d "$ROOT/node_modules" ]; then
    printf '  Start the app: %s%s%s\n' "$C_CYAN" "bash scripts/start.sh   (or: bun run start:vps)" "$C_RESET"
  else
    printf '  node_modules/ is missing - run %s%s%s first.\n' "$C_CYAN" "bun install" "$C_RESET"
    printf '  Start the app: %s%s%s\n' "$C_CYAN" "bash scripts/start.sh   (or: bun run start:vps)" "$C_RESET"
  fi
  printf '\n'
}

# ===========================================================================
# Main
# ===========================================================================
printf '\n'
printf '%s' "$C_BOLD"
printf 'Reelcreel - Linux/VPS setup\n'
printf '%s' "$C_RESET"
log "repo root: $ROOT"
log "local bin: $BIN_DIR (prepended to PATH)"
log "arch: $ARCH_KIND   package manager: ${PM:-none}   root: $(have_root && echo yes || echo no)"
printf '\n'

# Each step is guarded: a failure prints its own warning and the run continues,
# because one missing optional tool must not stop the others from installing.
step_ffmpeg     || warn "ffmpeg step incomplete; see the notes above."
step_ytdlp      || warn "yt-dlp step incomplete; see the notes above."
step_js_runtime || warn "JS runtime step incomplete; see the notes above."
step_bun        || warn "bun step incomplete; see the notes above."
step_auto_update || warn "yt-dlp refresh step incomplete; see the notes above."
step_ejs_check  || true

print_summary

# Reaching here means the bootstrap finished. cleanup() turns this into exit 0.
exit 0
