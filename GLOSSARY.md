# Reelcreel

Reelcreel turns a YouTube link into a media file. This glossary fixes the
vocabulary for the part of that job that is genuinely ambiguous: who ends up
holding the finished file, and what happens to the copy the server made along
the way.

## Language

### Delivery

**Delivery mode**:
Whether finished media is retained on the server (`server`) or handed to the
browser and then deleted (`browser`).
_Avoid_: download mode, save mode, target

**Delivery**:
The act of streaming a finished job's media to the browser and then removing the
server's copy.
_Avoid_: transfer, export, send

**Delivery state**:
What has happened to a finished job's bytes: `not-applicable`, `pending`,
`streaming`, `failed`, `delivered` or `expired`. It is independent of job phase,
which describes what the server is doing.
_Avoid_: download status, delivery phase

**Delivery attempt**:
One request for a job's media that ended before every promised byte was sent.
A ranged continuation of an interrupted transfer is not a new attempt.
_Avoid_: retry, failure

**Transient media**:
A finished file sitting in the temp directory, waiting to be delivered. It is
not part of any library and it is expected to disappear.
_Avoid_: cache, temp download, staging file

**Expired**:
Transient media that was deleted without reaching the browser — because the
attempt limit, the time limit, the size cap or the startup sweep removed it.
_Avoid_: dropped, lost, abandoned

**Staging**:
A job's private working directory, holding partial transfers and in-progress
output. Staging is not delivery; a job may be paused in staging for hours.
_Avoid_: temp dir, workdir

### Jobs

**Job phase**:
What the server is currently doing with a request — `queued`, `probing`,
`downloading`, `postprocessing`, `converting`, `done` and so on. `done` means
the media was produced and verified, and says nothing about who received it.
_Avoid_: status, state

**Settled**:
A job in a terminal phase (`done`, `skipped`, `error`, `cancelled`) that will not
advance on its own.
_Avoid_: finished, complete

**Request key**:
The identity of a download — preset plus the output-affecting options — used to
tell "the same file" from "a different format of the same video".
_Avoid_: hash, fingerprint

**Source fingerprint**:
What the site offered for a video at download time.
_Avoid_: metadata

**File fingerprint**:
What ffprobe measured in the file that landed on disk.
_Avoid_: inspection, probe result
