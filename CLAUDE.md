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
web/      The page (plain JS/CSS, no framework, no build). app.js/app.css are
          Synaxis's, renamed. together.js is the Watch Together page;
          sync-core.js is the sync logic (no DOM, unit tested);
          sync-config.js holds every threshold.
server/   Sync server (Node + TypeScript + Socket.IO). room.ts is the pure
          state rules, app.ts the socket wiring, config.ts the timings.
scripts/package.sh   builds release/ zips with a bundled Node.js; launchers
                     and the read-me live in packaging/
render.yaml          hosts the sync server on Render's free plan
docs/     spec.md, protocol.md, testing.md
```

## Commands

```sh
cd local  && npm install && npm test   # compiles, then runs the unit tests
cd local  && npm start                 # compiles, starts, opens the browser
cd local  && npm start -- --no-browser --port 8599
cd web    && npm test                  # sync logic (plain node --test)
cd server && npm install && npm test   # room state rules
cd server && npm run simulate          # two simulated people end to end, ~30 s
cd server && npm start                 # sync server on port 8686
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
2. Done: sync server (rooms, clock sync, state, buffering holds, chat and
   reaction relay) with Dockerfile.
3. Done: YouTube sync in the page, verified with the real player in two
   browser tabs.
4. Done: local-file sync. `local/src/together.ts` joins the room as a second
   connection of the same person and drives VLC with web/sync-core.js
   (loaded at run time). `fingerprint.ts` matches files; `positionEstimator.ts`
   smooths VLC's stepped position. Measured ~0.1 s apart on one machine.
5. Done: shared YouTube queue (several links, playlist links, auto-advance).
6. Done: packaging (scripts/package.sh). The Windows zip is unverified.
7. Next: deploy the sync server (needs the owner to push and make an
   account), chat and reactions UI (reactions beside the YouTube player,
   never over it), optional YouTube search (needs a YouTube Data API key).

## Decisions

- No Flutter, no Android. Web page on localhost; Windows and Linux.
- Local files play in a VLC window. VLC reports its position in steps of
  250-500 ms, so it is polled every 100 ms and the position is estimated
  from the moments the value changes.
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
- Testing the page for real: headless Firefox with `--remote-debugging-port`
  speaks WebDriver BiDi (Node 22 has a WebSocket client built in). Firefox is
  a snap, so its `--profile` folder must be under `~/snap/firefox/common/`;
  set `media.autoplay.default` 0 in `user.js`. Use `browser.createUserContext`
  to get two tabs with separate storage (two people). Player actions can be
  faked with `iframe.contentWindow.postMessage` of the IFrame API's command
  JSON. A background tab can't start playback, and its timers run once a second.
- Testing local-file sync: run two copies of the local program with
  different `XDG_CONFIG_HOME`/`XDG_DATA_HOME` and ports, each with its own
  folder holding the same film, and act as the pages with socket.io-client
  plus `POST /api/together/join`. VLC's port and password are in its
  command line (`pgrep -af http-port`), for pressing its buttons from outside.
- `window.Together.inspect()` in the browser console shows what the sync
  logic sees.
- Never match your own shell with `pkill -f`: write the pattern with a
  bracket, e.g. `pkill -f "dist/src/[m]ain.js"`.
