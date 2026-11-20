# Tandem

Two people in different places watch the same YouTube video or the same local
file in sync. Each device plays its own copy; only small control messages go
through a sync server. Original spec: `docs/spec.md` (it calls the project
"SyncUs" and describes a Flutter app; the project was later called Mendu,
now Tandem). The decisions below replaced much of
it and win over it.

## Layout

```
local/    The program each person runs (Node + TypeScript; its one runtime
          dependency is socket.io-client). Serves the page on localhost, scans video folders,
          launches and controls VLC.
web/      The page (plain JS/CSS, no framework, no build). app.js/app.css are
          Synaxis's, renamed. together.js is the Watch Together page;
          sync-core.js is the sync logic (no DOM, unit tested);
          sync-config.js holds every threshold.
server/   Sync server (Node + TypeScript + Socket.IO). room.ts is the pure
          state rules, app.ts the socket wiring, config.ts the timings.
extension/  Browser extension (Manifest V3, Chrome/Edge/Brave and Firefox
          128+): watch on youtube.com itself, or listen on YouTube Music
          (music.youtube.com), in step. Plain JS in src/;
          build.mjs copies src/ plus web/sync-core.js, web/sync-config.js
          and the Socket.IO client into dist/, the folder a browser loads.
scripts/package.sh   builds release/ zips with a bundled Node.js; launchers
                     and the read-me live in packaging/
.github/workflows/   test.yml (every push), release.yml (a v* tag builds the
                     packages onto a GitHub release; signs the Firefox
                     extension when the AMO secrets are set)
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
cd extension && npm install && npm run build   # extension in extension/dist
cd extension && npm test               # youtube-page.js, music-page.js (which pages are followed)
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
  `X-Tandem: 1` header.
- Data: `~/.config/tandem/config.json` and `~/.local/share/tandem/` on Linux,
  `%APPDATA%\Tandem` and `%LOCALAPPDATA%\Tandem` on Windows.

## Extension (extension/src)

- `tandem.js` (content script, loaded by `content.js` because content
  scripts can't be modules): the connection, room, sync (SyncController in
  speed-correction mode, since youtube.com's player takes any speed), page
  following and the corner badge. The room belongs to the tab
  (sessionStorage), so a reload keeps it; settings and the client id are in
  `chrome.storage.local`.
- `bridge.js` runs in the page's own world (`"world": "MAIN"`) to reach
  `#movie_player` and YouTube's in-page navigation (a `yt-navigate` event
  on `ytd-app`). The content script talks to it through an attribute on
  `<html>` plus a synchronous event.
- `youtube-page.js`: pure, tested. Which pages are followed (an allow-list),
  and `/@handle` to `/channel/<id>` (YouTube reloads the tab for `/@handle`).
- `popup.*`: create/join/leave, invite link, "I'm away", Resume, a small
  chat (the last 50 messages, sent through the tab), the queue, the room's
  pause-on-away option, chat sound, and settings; it messages the active tab.
- `background.js`: only the right-click "Add to Tandem queue" menu on video
  links; it passes the click to the tab. Named for both Chrome (service
  worker) and Firefox (scripts), hence Chrome 121+.
- Invite links are `youtube.com/…#tandem=CODE`; `bridge.js` takes the hash
  out of the address at document_start and leaves it on `<html>` for
  tandem.js.
- The badge (bottom right, in a shadow root) has a 💬 panel: who's here or
  away, chat, reactions (they rise from the badge, beside the player, never
  over it) and the away button. Its text box stops key events so YouTube's
  shortcuts don't fire while typing. Chat is kept per tab (sessionStorage).
- Browsing: leaving the room's video pauses it for both; while browsing the
  controller isn't fed and room states are held (`T.held`) unless they bring
  a new video. `page:send` / `page` relay pages (docs/protocol.md).
- YouTube Music: the same scripts run on music.youtube.com; `tandem.js`
  branches on `MUSIC`. There the music plays on while you look around, so
  the song is whatever the player has (`T.track`, from `listen()`), not the
  address: browsing pauses nothing and nothing is held, and page following
  only passes pages on. Its app (`<ytmusic-app>`) opens a page in place only
  from an endpoint (browse id, search, video), which `music-page.js` (pure,
  tested) makes from the address; channels and albums travel as
  `/channel/<id>` and `/browse/<MPREb_ id>` (the id is in `history.state`).
  Its player only takes speeds 0.25, 0.5 … 2, so drift is fixed by seeking
  (SyncController mode `'youtube'`). It goes straight on to its own next
  song; when the room's queue has one, the tab reports the end and waits
  for it. The badge sits 88 px up, above its player bar. Ads show as
  `ad-showing` on `#movie_player`, as on youtube.com.

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
6. Done: packaging (scripts/package.sh). The owner ran the Windows zip on Windows: it works.
7. Done: rooms are rebuilt after a server restart (clients send `restore`
   on rejoin); closing the tab shows you offline (page check-in, see
   docs/protocol.md).
8. Done: browser extension for watching on youtube.com itself (both on
   their own accounts; search, channels and video picks are followed).
   Tested headless in Firefox and Brave, and Firefox with Brave in one room.
   Ads (non-Premium) work: they count as buffering. Firefox needs it signed (AMO, unlisted) to stay installed.
9. Done: sync server deployed on Render's free plan at
   https://tandem-sync-a3pn.onrender.com (sleeps after 15 idle minutes,
   up to ~1 minute to wake; the owner is fine with that). Extension zips
   for friends: `TANDEM_SYNC_SERVER=https://tandem-sync-a3pn.onrender.com
   scripts/package.sh`. The owner reports it working.
10. Done, waiting for the owner to try on youtube.com: chat, reactions,
   "I'm away" (pauses the room for everyone unless the room's option is
   off; offline 5 s or leaving does too, then Resume), who chose the video
   (picked / autoplay on someone's side / queue), invite links, the queue
   from the right-click menu, unread count in the tab title, typing,
   connection quality. Server checked with scripted clients; Tandem's
   page checked in headless Firefox; the extension only rendered (popup,
   badge), not yet run on youtube.com with these changes.
11. Done: GitHub Actions (tests on push; release on a v* tag). Not yet run
   on GitHub (nothing is pushed).
12. Done, waiting for the owner to try: YouTube Music in the extension
   (music.youtube.com). Checked with two headless Firefoxes (one each,
   silent): picks, pause, play, ads (the room waits), following Explore,
   artists and searches while the music plays, a song ending (YouTube
   Music's next plays for both), the room queue taking over, reload,
   invite link, the badge above the player bar, and a mixed room with
   youtube.com. Not checked headless: seeking far (headless stalls) and
   the song/video switch. A seek that buffers over 0.7 s is undone (the
   stall report comes first; sync-core, same on youtube.com).
13. Next: one-click installs (Chrome Web Store unlisted, $5; Firefox AMO
   unlisted signing, wired into release.yml once AMO keys exist), optional
   YouTube search (needs a YouTube Data API key).

## Decisions

- No Flutter, no Android. Web page on localhost; Windows and Linux.
- Local files play in a VLC window. VLC reports its position in steps of
  250-500 ms, so it is polled every 100 ms and the position is estimated
  from the moments the value changes.
- Tandem's page: YouTube only (YouTube Music can't be embedded). The
  extension also runs on music.youtube.com, playing it in its own player.
  Never extract streams (no yt-dlp or similar); only the official IFrame
  player, visible and at least 200x200, or the sites' own players.
- Accepted changes to the spec's sync design: a `waitingFor` list for
  buffering (separate from user pause), buffering debounce, seek-ahead
  compensation for YouTube, two-step rate correction for local files,
  expected-state comparison for feedback-loop prevention, persistent client
  id, empty rooms kept ~10 minutes, join rate limit, monotonic clock.
- Sync server on Render's free plan (750 hours a month covers one service
  running all the time; rooms live in memory and are rebuilt by `restore`
  after Render restarts it).
- Licence: GPL-3.0-or-later (Synaxis code is GPL-3.0).
- Instead of screen sharing YouTube: the extension, so each person plays
  youtube.com on their own account and only control messages travel.
  The extension's socket lives in the content script (an MV3 service
  worker would be stopped when idle); so it is subject to the page's rules:
  an `http://` server other than localhost is mixed content, and a
  localhost one needs the browser's local-network permission (Brave Shields
  block it). A deployed `https://` server avoids all of that.

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
  set `media.autoplay.default` 0 in `user.js`, and `media.volume_scale`
  "0.0": headless Firefox still plays sound aloud, and tests must be silent
  (playback goes on as usual). Use `browser.createUserContext`
  to get two tabs with separate storage (two people). Player actions can be
  faked with `iframe.contentWindow.postMessage` of the IFrame API's command
  JSON. A background tab can't start playback, and its timers run once a second.
- Testing Tandem's page with a partner: a sync server on a spare port, the
  local program with throwaway `XDG_CONFIG_HOME`/`XDG_DATA_HOME` (config
  `sync_server` pointing at it), headless Firefox over BiDi as one person
  and a socket.io-client script as the other. With one profile the page
  picks it by itself. Stop Firefox with
  `pkill -f "remote-debugging-port [9]333"` in a command of its own: a
  pattern matching the profile path also matches your own shell.
- Testing local-file sync: run two copies of the local program with
  different `XDG_CONFIG_HOME`/`XDG_DATA_HOME` and ports, each with its own
  folder holding the same film, and act as the pages with socket.io-client
  plus `POST /api/together/join`. VLC's port and password are in its
  command line (`pgrep -af http-port`), for pressing its buttons from outside.
- `window.Together.inspect()` in the browser console shows what the sync
  logic sees. For the extension, send `{do: 'inspect'}` to the tab from an
  extension page (`chrome.tabs.sendMessage`).
- Testing the extension headless: Firefox needs `MOZ_REMOTE_ALLOW_SYSTEM_ACCESS=1`
  to script extension pages; install with BiDi `webExtension.install`
  `{type: 'path', path: 'extension/dist'}`, and fix the moz-extension UUID
  with the `extensions.webextensions.uuids` pref. Set `network.lna.enabled`
  false so youtube.com may reach localhost. The add-on is removed when the
  BiDi session ends, so do a whole test in one session. Two people need two
  Firefoxes (own profiles, ports): the client id is in the extension's
  storage, which user contexts share. Brave: `--headless=new
  --load-extension=... --remote-debugging-port=...` (CDP), Shields off for
  youtube.com via the profile's Preferences (`braveShields` exception,
  setting 2). Drive the popup's messages from the popup page opened in a
  background tab. Headless YouTube can't seek far into a 4K video (it
  stalls at 2:00 with or without Tandem); seek less far.
- Never match your own shell with `pkill -f`: write the pattern with a
  bracket, e.g. `pkill -f "dist/src/[m]ain.js"`.
