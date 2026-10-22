# Deploying Reelcreel on a Linux VPS

This is the operator guide for running Reelcreel as a public service: one Bun
process, a reverse proxy with TLS, and media delivered to the visitor's browser
instead of being kept on the server.

It assumes a Debian/Ubuntu VPS. The setup script also handles `dnf`, `yum`,
`apk` and `pacman` hosts, but only the `apt-get` path has been exercised
directly; treat the others as best effort and check `/api/health` afterwards.

## Prerequisites

- A Linux host (x86_64 or arm64). The static-binary fallbacks are x86_64-only,
  so arm hosts need `ffmpeg`/`ffprobe` and `yt-dlp` installed by the distro or
  by hand.
- A domain name with an `A`/`AAAA` record pointing at the host.
- TLS. The Origin check compares against a single `https://` origin, so a
  plain-HTTP deployment means running without the protection it provides.
- About 200 MB of RAM per concurrent transfer, plus disk headroom — see
  [Disk sizing](#disk-sizing-and-the-temp-directory-cap).

You do not need Python, pip, or a database server. yt-dlp's standalone release
binary is self-contained and SQLite is embedded.

## Quick start

Create a dedicated user and clone as that user, so nothing in the checkout ends
up owned by root:

```sh
sudo adduser --system --group --home /srv/reelcreel reelcreel
sudo -u reelcreel -H git clone <your-fork-url> /srv/reelcreel
```

Then, **as `reelcreel`** (use `sudo -u reelcreel -H bash` or log in as that
user), install Bun if it is not already available, then build and start:

```sh
cd /srv/reelcreel
curl -fsSL https://bun.sh/install | bash   # if bun is not already on PATH
export PATH="$HOME/.bun/bin:$PATH"

bun install
bun run build          # required: dist/ is gitignored and not in the repo
bash scripts/start.sh  # or: bun run start:vps
```

Running `bun install` or `bun run build` as root leaves root-owned files under
`node_modules/` and `dist/`, which the service user then cannot rewrite. If that
happens, `sudo chown -R reelcreel:reelcreel /srv/reelcreel`.

`bun run build` matters. `dist/` is in `.gitignore`, so a fresh clone has no
frontend and the server answers `404 Not Found` at `/`. The build is a Vite
production build; run it once after cloning and again after any pull.

`bash scripts/start.sh` is the documented VPS entrypoint. Plain `bun run start`
remains the local command: it assumes the tools are already on `PATH` and does
not touch `PATH` itself.

### What the setup script does

`scripts/start.sh` prepends `./.bin` to `PATH`, runs `scripts/setup-linux.sh`,
selects a JS runtime from `./.bin/.js-runtime` when `YTD_JS_RUNTIME` is unset,
then `exec`s `bun run server/index.ts`. Because it `exec`s, `Ctrl+C` and
`SIGTERM` reach the server directly.

The setup script itself is idempotent: every tool is probed with its version
flag first and anything already working is skipped, so it is cheap to run on
every boot. In order it:

1. **ffmpeg + ffprobe.** Prefers the distro package, which pulls both. If that
   is unavailable, downloads a static amd64 build into `./.bin` and installs
   `ffmpeg` and `ffprobe` as **siblings** — the app looks for `ffprobe` beside
   the resolved `ffmpeg` first. A downloaded build that cannot execute on this
   host (musl, wrong architecture) is discarded rather than left to shadow a
   working system copy.
2. **yt-dlp.** Installs the standalone release binary into `./.bin`. This is
   preferred over the distro package because the standalone build bundles the
   EJS challenge-solver component that `/api/health` requires. Falls back to the
   package manager with a warning if the download fails.
3. **A JS runtime.** Uses a working `node` if there is one, otherwise installs
   the Deno single binary into `./.bin` and records `deno` in
   `./.bin/.js-runtime`. yt-dlp cannot solve YouTube's challenge without one of
   these.
4. **Bun.** Uses the official installer into `~/.bun/bin`, never with `sudo`.
5. **yt-dlp refresh** when `YTD_AUTO_UPDATE=1` and the copy in `./.bin` is more
   than 24 hours old.
6. **The EJS check**, reproducing the app's own health test so a missing
   challenge solver is reported here rather than as a red panel later.

Package-manager installs are attempted only with root or passwordless
`sudo -n`; otherwise every step falls back to a user-space download into
`./.bin`. The script **never fails startup**: a step that cannot complete warns
and the script still exits 0, so a broken bootstrap cannot take the service
down. It only exits non-zero when it is run on a non-Linux host or cannot find
the repo root.

### Reading the summary table

The run ends with a table of `TOOL`, `STATUS`, `VERSION`, `PATH`. Status is one
of `found` (already working, skipped), `installed`, `updated` (the
`YTD_AUTO_UPDATE` refresh) or `missing`. A `missing` row for `ffmpeg` or
`ffprobe` means downloads and conversions will fail; a `missing` row for `node`
or `deno` means YouTube downloads will fail. Below the table:

- `yt-dlp EJS solver` — `available`, `NOT DETECTED`, or `unknown (yt-dlp
  missing)`. `NOT DETECTED` turns the health panel red and YouTube downloads
  generally fail.
- `js runtime` and `YTD_JS_RUNTIME` — what was selected, and whether it came
  from the environment or the marker file.
- `note` — appears when yt-dlp came from a distro package, which is often stale
  and may lack the solver.

## Manual install

If you would rather not use the script:

```sh
# Debian/Ubuntu
sudo apt-get update
sudo apt-get install -y ffmpeg curl unzip

# yt-dlp: static binary (recommended, bundles the EJS solver)
sudo curl -fsSL -o /usr/local/bin/yt-dlp \
  https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux
sudo chmod 0755 /usr/local/bin/yt-dlp

# or, if you prefer pipx
pipx install yt-dlp
```

Then a JS runtime (yt-dlp's EJS solver needs one) and Bun:

```sh
# Node.js 20 or newer (22 LTS recommended). Distro packages are often older;
# the setup script warns below 20 and yt-dlp's solver expects a recent Node.
sudo apt-get install -y nodejs npm

# Deno is a single static binary and an alternative runtime
curl -fsSL https://deno.land/install.sh | sh

# Bun
curl -fsSL https://bun.sh/install | bash
```

**ffprobe must sit beside ffmpeg.** The app resolves `ffprobe` from the
directory containing the `ffmpeg` it selected before falling back to `PATH`.
The distro `ffmpeg` package satisfies this; a hand-assembled pair does not
unless both files are in the same directory.

Verify all five things the health panel checks:

```sh
yt-dlp --version
ffmpeg -version | head -1
ffprobe -version | head -1
node --version    # or: deno --version
bun --version
```

## Environment configuration

Every value below is read from the process environment. Bun also loads a
`.env` file from the working directory automatically, and a real environment
variable wins over the file — but a systemd `Environment=` line is the
supported path and is what the unit below uses.

| Variable | Default | Accepted values | Effect |
|---|---|---|---|
| `HOST` | `127.0.0.1` | Any bind address | Listen address. Anything outside `localhost`, `127.0.0.1`, `::1` counts as public and changes the request rules. |
| `PUBLIC_ORIGIN` | unset | `https://host[:port]` | **Required** whenever `HOST` is not loopback. The one origin allowed to call `/api/*`. Must have no path. A trailing slash is normalized away. |
| `PORT` | `8787` | integer | API listen port. |
| `TRUST_PROXY` | unset | `1` | Read the client address from `X-Forwarded-For` / `X-Real-IP` for the rate limiter and the per-visitor queue cap. Only set behind a proxy you control. |
| `YTD_RATE_LIMIT` | `60` | integer; `0` disables | Requests per minute per address for expensive routes. |
| `YTD_JOBS_PER_IP` | `25` | integer | Maximum unfinished jobs per address. |
| `YTD_DELIVERY_MODE` | `server` | `server`, `browser` | Default delivery mode. A value saved in Settings wins. |
| `YTD_TEMP_DIR` | `./tmp-media` | absolute path | Where finished files wait in browser mode. The Settings dialog shows this path read-only, so this variable is how you move it. |
| `YTD_DATA_DIR` | `./data` | absolute path | Directory holding `yt-downloader.db`. Relative defaults resolve against the working directory. |
| `YTD_JS_RUNTIME` | `node` | `node`, `deno` | JS runtime yt-dlp is given for the challenge solver. **See the caveat below.** |
| `YTD_AUTO_UPDATE` | unset | `1` | Setup script refreshes `./.bin/yt-dlp` when it is older than 24 hours. |

### How the environment defaults interact with Settings

`YTD_DELIVERY_MODE`, `YTD_JS_RUNTIME` and `YTD_TEMP_DIR` supply the *defaults*.
On a database with no saved value they are what the process uses, so a systemd
`Environment=` line is enough to configure a fresh instance. Once a value is
saved in the Settings dialog it is written to SQLite and wins from then on,
across restarts and upgrades.

Confirm what the process actually resolved rather than assuming:

```sh
curl -s https://reel.example.com/api/settings | head -c 400
```

Check `deliveryMode`, `jsRuntime` and `tempDir` in that output. If
`deliveryMode` reads `server` on an instance you configured as `browser`, a value
was saved in the UI at some point and is overriding the environment — change it
in Settings, or remove the row from the `settings` table while the service is
stopped.

Check `deliveryMode`, `jsRuntime` and `tempDir`. If `deliveryMode` reads `server`
on an instance you intended to be `browser`, nothing is being deleted after
delivery and the disk will fill — fix it before sending traffic.

### Browser mode and what it hides

In `browser` mode the pipeline's output directory is redirected to the temp
directory, the finished file is streamed out through
`GET /api/jobs/:id/download?file=N`, and it is deleted once the last byte is
sent. Sidecar subtitle files are delivered as additional sequential downloads
(`file=1`, `file=2`, …).

"Skip files I already have" and "Convert instead of re-downloading" are hidden
in this mode. Both compare a request against a file already on disk, and nothing
is retained to compare against, so every browser-mode request fetches fresh.

**The file does transit the VPS disk.** YouTube will not serve a merged
audio+video stream to a browser, and MP4 merging plus FFmpeg post-processing can
only happen server-side. "Not stored on the VPS" means *not retained*: peak disk
use is one in-flight file per concurrent transfer, plus files waiting to be
fetched.

Delivery guarantees, all enforced server-side:

- The file is deleted when the transfer completes.
- A failed transfer attempt is counted; after `deliveryMaxAttempts` (default 3)
  the file is deleted. A ranged continuation of the same transfer does **not**
  count as a new attempt, so a resumed download does not burn the budget.
- A file nobody fetches is deleted after `deliveryTtlMinutes` (default 15).
- If waiting files exceed `tempCapMb` (default 2048), the oldest is evicted.
- On startup, leftover files are swept and delivery state is repaired; the
  sweeper then runs every 60 seconds.

The browser fetches one file at a time and shows an "N of M" indicator, because
browsers block or drop simultaneous downloads. Automatic delivery only happens
for jobs queued in the current tab; a row that finished while the page was
closed shows a Download button instead.

## systemd unit

Save as `/etc/systemd/system/reelcreel.service`:

```ini
[Unit]
Description=Reelcreel YouTube downloader
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=reelcreel
Group=reelcreel
WorkingDirectory=/srv/reelcreel

ExecStart=/usr/bin/env bash /srv/reelcreel/scripts/start.sh
Restart=always
RestartSec=5

# Public mode: HOST must be non-loopback, and PUBLIC_ORIGIN is then required.
Environment=HOST=0.0.0.0
Environment=PUBLIC_ORIGIN=https://reel.example.com
Environment=PORT=8787
Environment=TRUST_PROXY=1
# Keeps nothing on the server: files are streamed to the visitor and deleted.
Environment=YTD_DELIVERY_MODE=browser
Environment=YTD_DATA_DIR=/srv/reelcreel/data
Environment=YTD_TEMP_DIR=/srv/reelcreel/tmp-media
Environment=YTD_AUTO_UPDATE=1

# Hardening. ReadWritePaths must cover every directory the process writes:
# the SQLite directory, the temp directory, and .bin/ when the setup script
# may install or refresh tools.
ProtectSystem=strict
ProtectHome=read-only
PrivateTmp=true
NoNewPrivileges=true
ReadWritePaths=/srv/reelcreel/data /srv/reelcreel/tmp-media /srv/reelcreel/.bin

[Install]
WantedBy=multi-user.target
```

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now reelcreel
systemctl status reelcreel
journalctl -u reelcreel -f
```

Notes on the hardening block:

- `ReadWritePaths` only has an effect together with `ProtectSystem=strict`. It
  must include the data directory, the temp directory, and `./.bin` if the setup
  script is allowed to install or refresh tools. Add the checkout root instead
  if you also want `bun run build` to work from inside the unit.
- `ProtectHome=read-only` covers `/home`, `/root` and `/run/user`, not `/srv`.
  With the service user's home at `/srv/reelcreel` it changes nothing here; it
  is there to stop the process reaching a real human home directory. If Bun
  lives in `/home/<user>/.bun/bin`, either install Bun somewhere on the default
  `PATH` or drop this line.
- `NoNewPrivileges=true` blocks `sudo`, so the setup script's package-manager
  path will be skipped and it will fall back to downloading static binaries into
  `./.bin`. That is the intended no-root path, but it means distro packages are
  never installed for you. Combine it with `ProtectSystem=strict` and `./.bin`
  is the only place the bootstrap can write.
- `Restart=always` means a misconfiguration loops instead of stopping. Watch
  `journalctl` on the first boot; a `PUBLIC_ORIGIN` error prints once and exits.

## nginx TLS reverse proxy

```nginx
server {
    listen 80;
    server_name reel.example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    http2 on;
    server_name reel.example.com;

    ssl_certificate     /etc/letsencrypt/live/reel.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/reel.example.com/privkey.pem;

    # Batch pastes are capped at 2 MB by the app itself. Leave headroom so
    # nginx does not answer 413 before the app can explain why.
    client_max_body_size 4m;

    location / {
        proxy_pass http://127.0.0.1:8787;

        # REQUIRED. The app compares the request Host against PUBLIC_ORIGIN's
        # host; if the proxy rewrites Host to 127.0.0.1:8787 every API call is
        # rejected with 403 "Unrecognized Host."
        proxy_set_header Host $host;

        proxy_http_version 1.1;
        proxy_set_header Connection "";

        # The job feed is server-sent events and downloads can run for a long
        # time, so neither may be buffered or reaped early.
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;

        # Read only when TRUST_PROXY=1, so the rate limiter and the per-visitor
        # queue cap see the visitor, not the proxy.
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

`proxy_set_header Host $host;` is the line that breaks deployments. The Origin
check compares the browser's `Origin` header against `PUBLIC_ORIGIN` **and**
requires the request `Host` to be that origin's host. Forwarding the original
Host is what makes both true.

`proxy_pass http://127.0.0.1:8787` still works even though the app is bound to
`0.0.0.0`: the bind address decides the app's request rules, not which interface
the proxy dials. Keep port 8787 closed to the internet (see below) so the proxy
is the only way in.

### Caddy alternative

Caddy forwards the original `Host` automatically and terminates TLS itself:

```caddyfile
reel.example.com {
    reverse_proxy 127.0.0.1:8787
}
```

Set `TRUST_PROXY=1` here too, and set `PUBLIC_ORIGIN=https://reel.example.com`
exactly as with nginx.

## Firewall

Only 80 and 443 should be reachable from the internet. The app port must not be.

With ufw:

```sh
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
```

Because `HOST=0.0.0.0` makes the app listen on every interface, add an explicit
rule refusing 8787 from outside:

```sh
# ufw rules are first-match-wins for a given port, so add the deny before any
# allow rule that could cover 8787
sudo ufw deny 8787/tcp
```

or, if you use nftables/iptables, restrict the port to loopback and the proxy.
Binding to a private interface address instead (`HOST=10.0.0.5`) is equivalent
and does not depend on firewall ordering — it is non-loopback, so it still
requires `PUBLIC_ORIGIN`.

**Binding the app to loopback behind the proxy does not work.** In loopback mode
the app requires both `Host` and `Origin` to be loopback, so a browser request
carrying `Origin: https://reel.example.com` is rejected with `403 Same-origin
requests required.` even when the proxy forwards everything correctly. Public
mode is entered by binding a non-loopback address; there is no loopback-plus-TLS
configuration.

## Disk sizing and the temp directory cap

In browser mode, `tempCapMb` bounds the files *waiting* to be fetched. It does
not bound in-flight transfers or in-progress staging, so size the disk for:

```
peak disk ≈ tempCapMb + (largest file × downloadConcurrency) + staging partials
```

`downloadConcurrency` defaults to 3. Approximate sizes for a 30-minute video:
1080p is roughly 1–2 GB, 4K roughly 3–6 GB. A 4K transfer at `downloadConcurrency`
3 therefore needs on the order of 10–20 GB of transient space regardless of the
cap.

| `tempCapMb` | Waiting-file budget | Holds, at ~2 GB per file | Holds, at ~5 GB per file |
|---|---|---|---|
| 512 | 0.5 GB | 0 files | 0 files |
| 1024 | 1 GB | 0 files | 0 files |
| 2048 (default) | 2 GB | 1 file | 0 files |
| 4096 | 4 GB | 2 files | 0 files |
| 8192 | 8 GB | 4 files | 1 file |
| 16384 | 16 GB | 8 files | 3 files |
| 32768 | 32 GB | 16 files | 6 files |

Read that table as a warning: the default 2048 MB is comfortable for 1080p and
too small for 4K. If the cap is below one large file, a completed file can be
evicted before the browser asks for it, which surfaces as "this download is no
longer available" immediately after the job finished. Set `tempCapMb` above your
largest expected file, then add room for a few waiting files.

Guidance by host size:

- **1 vCPU / 1 GB RAM / 25 GB disk.** Lower `downloadConcurrency` to 1–2, keep
  `tempCapMb` at 2048–4096, and expect 1080p to be the practical ceiling. FFmpeg
  merging is CPU-bound and will starve the API on one core.
- **2 vCPU / 2–4 GB RAM / 50–80 GB disk.** `tempCapMb` 8192, concurrency 2–3.
  This is the smallest configuration that handles 4K at all.
- **4+ vCPU / 8 GB RAM / 100 GB+ disk.** `tempCapMb` 16384 or more, concurrency
  3–4. Beyond that, bandwidth is the limit rather than disk.

The TTL and attempt limit are the other half of the disk story. `deliveryTtlMinutes`
(15 by default) is what bounds disk use when a tab is closed and never asks for
the file — nothing else does, because a crashed tab leaves no signal.
`deliveryMaxAttempts` (3) stops a file that repeatedly fails to transfer from
sitting around forever. Raise the TTL if your visitors are likely to queue a
large batch and walk away; lower it on a small disk.

## Troubleshooting

Start with health, because it answers most of these:

```sh
# Public mode: use the public URL. A loopback request carries the wrong Host
# and is rejected by the origin check before it reaches the handler.
curl -s https://reel.example.com/api/health

# Loopback mode:
curl -s http://127.0.0.1:8787/api/health
```

`ok` is true only when **all five** of these are present: `yt-dlp`, `ffmpeg`,
`ffprobe`, a JS runtime, and yt-dlp's EJS challenge-solver component. The
Settings dialog shows the same result under Binaries. A non-`ok` response
returns HTTP 200 with `ok: false`; an internal failure returns 503 with an
`error` string.

### The health panel is red

Check `ejs.detail` and the per-binary fields to see which one is missing.

- **`ytdlp: null`** — yt-dlp is not on the service's `PATH`. The setup script
  installs into `./.bin` and `scripts/start.sh` prepends it; a unit that runs
  `bun run server/index.ts` directly skips both.
- **`ffmpeg: null`** — not installed, or installed somewhere not on `PATH`.
- **`ffprobe: null`** — ffmpeg is present but `ffprobe` is not beside it and not
  on `PATH`. This is the common failure with hand-assembled or "essentials"
  FFmpeg builds. Install the distro `ffmpeg` package, which ships both.
- **`runtime: null`** — neither `node` nor `deno` resolves. Install one, or
  point the service at one with `YTD_JS_RUNTIME`.
- **`ejs.available: false`** — yt-dlp is installed but without the challenge
  solver. The standalone release binary bundles it; a distro package may not.
  Re-install from
  `https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux`, or
  `pip install -U yt-dlp yt-dlp-ejs`.

A stale yt-dlp is the most common cause of downloads breaking while health
still looks fine, because it still reports a version and still finds the solver.
Set `YTD_AUTO_UPDATE=1`.

### `403 Unrecognized Host.`

Either the proxy is not forwarding the original `Host` header, or
`PUBLIC_ORIGIN` does not match the host browsers use. Check both: the request
`Host` must be exactly the host part of `PUBLIC_ORIGIN`. A proxy that sets
`Host 127.0.0.1:8787` produces this for every request.

### `403 Same-origin requests required.`

The browser's `Origin` is not exactly `PUBLIC_ORIGIN`. Usual causes:

- `PUBLIC_ORIGIN` uses `http://` while the site is served over `https://` (or
  the reverse).
- The site is reachable on two names (`example.com` and `www.example.com`) and
  only one is configured.
- The app is bound to loopback while the proxy forwards a public `Host`, which
  makes loopback rules apply. See [Firewall](#firewall).

### `503 Server origin is not configured.`

The process is bound to a public address with no usable `PUBLIC_ORIGIN`.
Normally startup refuses to run in this state, so seeing this at request time
means the value was changed or removed after boot. Set `PUBLIC_ORIGIN` and
restart.

### The process refuses to start

The message names the problem. `PUBLIC_ORIGIN is not set` means `HOST` is
non-loopback without an origin. `PUBLIC_ORIGIN is not a valid origin` means the
value has a path (`https://example.com/app`), a non-HTTP scheme, or no scheme at
all — the form is `https://example.com` with no path. `API port N is already in
use` means another instance owns the port; stop it or choose a different `PORT`
and `YTD_DATA_DIR`.

### `429`

Two different limits answer with 429:

- **Rate limit.** "Too many requests. Wait a moment and try again." with a
  `Retry-After` header. `YTD_RATE_LIMIT` requests per minute per address, per
  route. Raise it, or set it to `0` to disable (only behind other protection).
  The limit is keyed by address *and* path, so one busy route does not consume
  another's budget.
- **Queue cap.** "You already have N downloads in progress (limit M)." Raise
  `YTD_JOBS_PER_IP`, or wait for work to finish. A large pasted batch is also
  rejected whole if it would exceed the cap, rather than partially queueing.

If every visitor shares one address, `TRUST_PROXY=1` is missing — without it the
limiter sees the proxy and treats the whole internet as one client.

### A download never starts

- **The browser blocked it.** Browsers block or silently drop simultaneous
  downloads, and will also block them on a page they consider untrusted. The
  client fetches one file at a time and shows "Downloading to your device · N of
  M"; if that indicator is advancing, the server side is fine.
- **The job was queued in another tab.** Automatic delivery only applies to jobs
  this tab queued. A row that finished while the page was closed shows a
  Download button instead — click it.
- **The download URL is rate-limited.** `/api/jobs/*/download` is behind the
  same limiter. Check for a 429 in the browser's network panel.

### "This download is no longer available on the server."

The file is gone and the job's delivery state is `delivered` or `expired`
(HTTP 409). Causes, in rough order of likelihood:

- the TTL passed (`deliveryTtlMinutes`),
- the attempt limit was reached (`deliveryMaxAttempts`),
- the temp cap evicted it (`tempCapMb` too small for the file),
- the process restarted and the startup sweep found it unclaimed or missing.

The job row and the queue show the reason recorded at expiry. Re-download the
video; there is nothing to recover on the server.

### "YouTube is asking this server to sign in" / "Sign in to confirm you're not a bot"

This is not a broken install. YouTube classifies the server's IP as a bot and
requires a signed-in session before it serves format URLs. Datacenter addresses
(cloud VMs, VPS providers, most container platforms) hit this far more often
than a home connection.

1. In a browser signed in to YouTube, export cookies in **Netscape** format
   (a `cookies.txt` extension such as "Get cookies.txt LOCALLY"). Export the
   `youtube.com` cookies, not the page HTML.
2. Open the app's **Settings → YouTube cookies** and press **Upload
   cookies.txt**. The server validates the file, writes it to
   `data/cookies.txt` with owner-only permissions, and points `cookiesPath` at
   it. No shell or `scp` is needed.
3. Press **Test against YouTube**. It runs a simulated probe and reports whether
   the sign-in wall is gone.

If the test still reports a sign-in request:

- Re-export while signed in (cookies rotate), and confirm the file contains
  `SID`, `HSID`, `SSID`, `APISID`, `SAPISID` or `__Secure-*` rows.
- Use a secondary Google account for this. A cookies file is equivalent to a
  session for that account, and it lives on the server.
- Check the server clock; large clock skew invalidates cookies.
- Refresh yt-dlp (`YTD_AUTO_UPDATE=1`, or replace `.bin/yt-dlp`).
- If your provider's IP range is heavily blocked, cookies can still be refused.
  A residential/egress proxy or a PO-token provider is then the remaining
  option; neither is configured by this app.

Cookie uploads are capped at 512 KB and must contain at least one YouTube or
Google row. Values are never returned by the API; the dialog only shows counts,
the update time, and validation errors. Treat the file as a password: remove it
with **Remove** when you are finished, and never commit it.



**There is no user authentication, by design.** Anyone who knows the URL can
download video with it, and every download runs `yt-dlp` and possibly `ffmpeg`
on your host under your service user. There are no accounts, no passwords and no
per-user quotas.

Access control is delegated to the hosting provider. The app's own guards are
only:

- the `PUBLIC_ORIGIN` same-origin check on `/api/*`,
- `YTD_RATE_LIMIT`, a per-address request budget,
- `YTD_JOBS_PER_IP`, a per-address cap on unfinished jobs.

Those limit abuse; they do not authorise users. If the instance must be
restricted, do it outside the app: a WAF, an allowlist of source addresses, a
VPN, or HTTP basic auth at the proxy. Note that proxy-level auth still leaves
the app reachable to anyone who can hit the port directly, so keep 8787 closed.

Also:

- Keep the host patched, and keep yt-dlp fresh (`YTD_AUTO_UPDATE=1`). It parses
  untrusted remote data and is the most security-sensitive component here.
- Run the service as a dedicated unprivileged user, never as root.
- Keep `TRUST_PROXY` unset unless a proxy you control is in front of the app;
  otherwise any client can forge `X-Forwarded-For` and reset its own limits.
- Do not commit the SQLite database or any `.env` file; both are ignored by
  default.

## Verifying a deployment

```sh
# 1. Health: all five components present, ok true
curl -s https://reel.example.com/api/health

# 2. Public origin actually applied
curl -s https://reel.example.com/api/settings | head -c 400

# 3. Cross-origin requests are rejected
curl -s -o /dev/null -w '%{http_code}\n' \
  -H 'Origin: https://evil.example' https://reel.example.com/api/settings

# 4. Non-browser clients without an Origin still work
curl -s -o /dev/null -w '%{http_code}\n' https://reel.example.com/api/settings
```

Step 3 should print `403` and step 4 should print `200`. Then paste a short
video URL in the browser and confirm the file downloads and disappears from
`YTD_TEMP_DIR` afterwards.

The systemd unit and nginx block above are a starting point and were not
executed on a Linux host while writing this guide; check the paths, the user,
and the certificate locations before relying on them.
