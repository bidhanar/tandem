# Mendu

Two people in different places watch the same YouTube video or the same local
file in sync. Each device plays its own copy; only small control messages go
through a sync server. Original spec: `docs/spec.md` (it calls the project
"SyncUs" and describes a Flutter app). The decisions below replaced much of
it and win over it.

## Layout

```
local/    The program each person runs (Node + TypeScript, no runtime
          dependencies). Serves the page on localhost, scans video folders,
          launches and controls VLC.
web/      The page (plain JS/CSS, no framework), copied from Synaxis and
          renamed. Talks to local/ over /api/*.
server/   Sync server (Node + TypeScript + Socket.IO). Not yet written.
docs/     spec.md, protocol.md, testing.md
```

## Commands

```sh
cd local
npm install
npm test                               # compiles, then runs the unit tests
npm start                              # compiles, starts, opens the browser
npm start -- --no-browser --port 8599  # for testing without opening a tab
```

Ubuntu's Node package can't run TypeScript directly, so everything is
compiled to `local/dist/` first (`tsc`). Source uses `.ts` import paths and
only erasable TypeScript syntax (no enums, no constructor parameter
properties).

## Architecture (local/src)

- `filenameParser.ts`, `catalog.ts`, `feed.ts`, `watchState.ts`, `library.ts`,
  `playback.ts`, `view.ts`: ported from Synaxis's C++ (`~/Projects/synaxis`),
  same behaviour and the same JSON shapes the page expects.
- `probe.ts`: durations/resolution via `ffprobe`, artwork via `ffmpeg`. Both
  optional; without them the library has no pictures or durations.
- `vlc.ts`: starts VLC with its HTTP interface on 127.0.0.1 and a per-launch
  password; play, pause, seek and rate go through it.
- `server.ts`: static files, thumbnails and the `/api/*` routes. Refuses
  requests whose Host isn't localhost/127.0.0.1, and changes without the
  `X-Mendu: 1` header.
- Data: `~/.config/mendu/config.json` and `~/.local/share/mendu/` on Linux,
  `%APPDATA%\Mendu` and `%LOCALAPPDATA%\Mendu` on Windows.

## Plan from here

1. Done: library + VLC playback on localhost.
2. Sync server: rooms (6-character code, two people by default, limit is a
   server setting), clock sync, authoritative state, as in spec sections 1-8.
3. YouTube sync in the page (official IFrame player in the real browser).
4. Local-file sync: the local program is the sync client for VLC (a hidden
   browser tab gets its timers throttled, so the page can't be).
5. Chat, reactions (beside the YouTube player, never over it), presence, queue.

The sync logic should be one plain module shared by the page and the local
program, tested with a fake player and fake clock.

## Decisions

- No Flutter, no Android. Web page on localhost; Windows and Linux.
- Local files play in a VLC window. VLC reports its position in steps of
  250-500 ms, so position must be estimated from the moments the value
  changes; the 0.3 s sync target for local files is unproven.
- YouTube only (no YouTube Music). Never extract streams (no yt-dlp or
  similar); only the official IFrame player, visible and at least 200x200.
- Accepted changes to the spec's sync design: a `waitingFor` list for
  buffering (separate from user pause), buffering debounce, seek-ahead
  compensation for YouTube, two-step rate correction for local files,
  expected-state comparison for feedback-loop prevention, persistent client
  id, empty rooms kept ~10 minutes, join rate limit, monotonic clock.
- Sync server on a free host (Render free tier is the candidate; confirm
  terms when deploying).
- Licence: GPL-3.0-or-later (Synaxis code is GPL-3.0).

## Conventions

- Simple, readable code over clever code; the owner maintains this.
- Commit at each working milestone. Never push; the owner pushes.
- If something doesn't work on one platform, report it; don't hack around it
  silently.
- Stop at the end of each step with test instructions and wait for confirmation.
- Testing playback without opening a window or making sound: point the `vlc`
  setting at a script that runs `vlc -I dummy --vout dummy --aout dummy "$@"`,
  and set it back to `vlc` afterwards.
- Don't run the built program from the VS Code snap terminal when testing
  anything graphical; it breaks GTK and GStreamer apps.
