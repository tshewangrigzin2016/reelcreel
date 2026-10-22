# YouTube authentication: cookies for a hosted server

YouTube does not let every IP download every video anonymously. When it decides
an address looks automated — which is the normal answer for cloud and VPS
addresses — it replaces the video response with:

```
Sign in to confirm you're not a bot. This helps protect our community.
Use --cookies-from-browser or --cookies for the authentication.
```

Nothing is wrong with yt-dlp, FFmpeg, or this app. YouTube wants a Google
session, and a server has none. The fix is to give yt-dlp the cookies of a
browser that is signed in.

## The fix: export, upload, test

1. **Sign in to YouTube** in a normal browser. A secondary Google account is
   recommended; the cookie file is equivalent to being signed in as that
   account.
2. **Install a Netscape cookies exporter** for that browser. On Chrome/Edge,
   "Get cookies.txt LOCALLY" is a common choice; on Firefox, "Export Cookies".
   Do not use an extension that uploads cookies to a third-party service.
3. Open `youtube.com` and export the cookies for that site. You need a file
   whose first line is `# Netscape HTTP Cookie File` and whose rows are
   tab-separated, for example:

   ```text
   # Netscape HTTP Cookie File
   #HttpOnly_.youtube.com	TRUE	/	TRUE	1893456000	SID	…
   .youtube.com	TRUE	/	FALSE	1893456000	PREF	…
   ```

   A file without `#HttpOnly_` rows, or a saved HTML page, will be rejected.
4. In Reelcreel open **Settings → YouTube cookies → Upload cookies.txt**.
   This works on a hosted instance where you have no shell. The server
   validates the file, writes it to `data/cookies.txt` with `0600` permissions,
   and saves its path in `cookiesPath`.
5. Press **Test against YouTube**. `Working — YouTube answered without a
   sign-in wall` means the next download will use the session. The test is a
   simulated metadata probe, not a full download.

Settings also accepts a manual path for local installs. Uploading is simply the
convenient path for a server; both end up as yt-dlp's `--cookies`.

## If it still asks for a sign-in

- **Re-export.** Cookies expire and rotate, especially `SID` and the
  `__Secure-*` rows. Signing out of the browser or changing the password can
  invalidate them.
- **Confirm the file is complete.** It should include authentication rows such
  as `SID`, `HSID`, `SSID`, `APISID`, `SAPISID`, `LOGIN_INFO` or
  `__Secure-3PSID`. A file with only `PREF`/`VISITOR_INFO1_LIVE` is not a
  signed-in session.
- **Check the clock.** yt-dlp validates cookie expiry against the server clock;
  a large skew invalidates the session.
- **Update yt-dlp.** YouTube changes its player regularly. The setup script
  refreshes the binary when `YTD_AUTO_UPDATE=1`; `/api/health` shows the
  version.
- **Try another account.** Some accounts are themselves challenged, and new
  accounts are more likely to be.
- **Change the exit IP.** If the host's range is heavily flagged, even a valid
  session can be refused. Route the host through a residential proxy, or run
  the app on a home connection. A proxy is an operator decision; this app does
  not configure one.

## Why `--cookies-from-browser` does not solve it here

That flag reads a browser profile on the same machine. A server has no browser
profile, and exposing one would be worse than uploading a scoped cookie file.
Uploading is the server equivalent.

## PO tokens and other workarounds

YouTube's bot gate combines cookies with a "PO token" challenge. A PO-token
provider such as `bgutil-ytdlp-pot-provider` runs a small local service that
generates tokens. It can help when cookies alone are not enough, but it adds
another daemon, needs a current yt-dlp plugin, and is not a substitute for a
signed-in session on a blocked IP. This project does not install one.

Forcing a different player client (`--extractor-args
youtube:player_client=…`) is also not a reliable bypass: yt-dlp already rotates
clients internally, and a client that avoids the sign-in wall today can be
removed from YouTube tomorrow. Cookies are the supported answer.

## Security

- The cookies file grants access to the Google account it came from. Use a
  dedicated/secondary account, not your main one.
- It is stored under `data/` (gitignored) with owner-only permissions. Do not
  copy it into the repository, a container image, or a chat message.
- The API never returns cookie values. `GET /api/settings/cookies` and the
  dialog return only row counts, size, update time, and validation errors.
- **Remove** deletes the uploaded file and clears `cookiesPath`. Do this when
  you no longer need downloads.
- The Settings API is protected against cross-site requests but is not
  authenticated. Keep the deployment URL private; anyone who can open it can
  change settings.
