# Tandem

Watch YouTube videos and your own video files together with someone far
away, in sync. Each person plays their own copy; only play, pause and seek
messages travel between you.

Status: the library, VLC playback, and watching YouTube and local files
together all work on Linux. The Windows package is built but has not been
run on Windows yet.

## What it is

A small program you run on your computer (Windows or Linux). It opens a page
in your browser that shows your videos like a streaming service: movies and
shows, episodes grouped by season, artwork, and where you stopped. Pressing
Play opens the video in VLC.

The interface and library logic come from
[Synaxis](https://github.com/bidhanar/synaxis).

## Run it

You need:

- [Node.js](https://nodejs.org/) 20.11 or newer
- [VLC](https://www.videolan.org/vlc/)
- Optional: [FFmpeg](https://ffmpeg.org/) (`ffmpeg` and `ffprobe` on your
  PATH) for artwork, durations and quality badges

On Ubuntu: `sudo apt install nodejs npm vlc ffmpeg`.

```sh
cd local
npm install
npm start
```

Your browser opens `http://127.0.0.1:8585/`. The first run scans your home
folder for videos larger than 200 MB; change the folders and the size limit
in Settings (profile menu, top right). Quit with Ctrl+C in the terminal or
"Quit Tandem" in the profile menu.

The page only works from the same computer. Nothing is uploaded anywhere.

## Watch together

One of you creates a room on the Watch Together page and sends the
6-character code to the other, who joins with it. Play, pause and seek on
either side apply to both.

- **YouTube:** paste a link and press "Play for both". You can paste several
  links at once, or a playlist page link, and "Add to queue"; the next video
  starts by itself when one ends. Clicking one of YouTube's suggestions in
  the player switches both of you to it.
- **Your own videos:** while in the room, press Play on a video in your
  library. It opens in VLC on both computers. You both need the same file;
  Tandem recognises it by its contents, whatever it is called. If the other
  person only has a different copy of the same length, they can play that
  one after a warning that sync may be off.

### On youtube.com itself: the browser extension

Instead of the player on Tandem's page, you can both use the real
youtube.com, each signed in to your own account (Premium means no ads for
either of you). Either of you searches, opens a channel or clicks a video,
and the other's tab goes to the same page; play, pause and seek stay in
step. Each of you still sees your own account's recommendations. Only
YouTube; your own video files still need Tandem's program.

It works the same on YouTube Music (music.youtube.com): a song either of
you plays, plays for both, and the other's tab follows you around Explore,
artists, albums, playlists and searches while the music plays on.

Install it in Chrome, Edge or Brave: build it (below) or unzip
`tandem-extension-<version>.zip`, open `chrome://extensions`, turn on
Developer mode, press "Load unpacked" and pick the folder. In Firefox (128
or newer): `about:debugging`, This Firefox, "Load Temporary Add-on", and pick
`manifest.json` in that folder. Firefox forgets a temporary add-on when it
closes; to keep it, the zip has to be signed once through a free Mozilla
add-ons account (it can stay unlisted).

Then open youtube.com (or music.youtube.com), click Tandem's icon in the
toolbar, type your name and press "Create a room" (if a video or song is
open, it plays for both of you), or type your partner's code and press
Join. Set the sync server address under Settings in that popup. A small badge in the corner of the page shows the
room code and whether you're in step; click it to make it smaller.

```sh
cd extension && npm install && npm run build   # the extension is then in extension/dist
```

With a sync server on your own computer (`http://localhost:8686`), browsers
ask before letting youtube.com reach it: allow it when asked. Brave blocks it
outright unless Shields are down for youtube.com. A sync server on an
`https://` address (see below) has none of this.

You both need to reach the same **sync server**, a tiny program that passes
those messages along. Set its address in Settings on both computers.

To run it on your own computer (enough to try things out on one machine):

```sh
cd server
npm install
npm start          # listens on port 8686, which is Tandem's default setting
```

For two people on different networks it has to run somewhere both can
reach. `render.yaml` sets it up on [Render](https://render.com)'s free plan
(New > Blueprint, pick this repository); `server/Dockerfile` works on any
other host that runs containers and supports WebSockets. Either way you get
an `https://` address to put in Settings on both computers. On a free plan
the server sleeps when unused, so the first connection can take a minute.

## Send it to someone

```sh
TANDEM_SYNC_SERVER=https://your-server.example scripts/package.sh
```

builds `release/tandem-<version>-windows-x64.zip`,
`release/tandem-<version>-linux-x64.tar.gz` and the browser extension,
`release/tandem-extension-<version>.zip`. Each holds Tandem and its own
copy of Node.js, so the other person only needs VLC: they unzip it and
double-click `Tandem.bat` (Windows) or run `./tandem` (Linux). `READ ME.txt`
inside tells them the rest. `TANDEM_SYNC_SERVER` is optional; it presets the
sync server address (in the program and the extension) so they don't have
to type it.

## Develop

```sh
cd local  && npm test                               # library and VLC
cd web    && npm test                               # sync logic
cd server && npm test                               # room rules
cd extension && npm test                            # which youtube.com and YouTube Music pages are followed
cd server && npm run simulate                       # two simulated people
cd local  && npm start -- --no-browser --port 8599  # run without opening a tab
```

## Documents

- `docs/spec.md`: the original specification (written for an earlier design)
- `docs/protocol.md`: the sync protocol
- `docs/testing.md`: manual test checklist
- `CLAUDE.md`: architecture, decisions and conventions

## Licence

GPL-3.0-or-later. See `LICENSE`.
