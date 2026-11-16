# Mendu

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
"Quit Mendu" in the profile menu.

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
  Mendu recognises it by its contents, whatever it is called. If the other
  person only has a different copy of the same length, they can play that
  one after a warning that sync may be off.

You both need to reach the same **sync server**, a tiny program that passes
those messages along. Set its address in Settings on both computers.

To run it on your own computer (enough to try things out on one machine):

```sh
cd server
npm install
npm start          # listens on port 8686, which is Mendu's default setting
```

For two people on different networks it has to run somewhere both can
reach. `render.yaml` sets it up on [Render](https://render.com)'s free plan
(New > Blueprint, pick this repository); `server/Dockerfile` works on any
other host that runs containers and supports WebSockets. Either way you get
an `https://` address to put in Settings on both computers. On a free plan
the server sleeps when unused, so the first connection can take a minute.

## Send it to someone

```sh
MENDU_SYNC_SERVER=https://your-server.example scripts/package.sh
```

builds `release/mendu-<version>-windows-x64.zip` and
`release/mendu-<version>-linux-x64.tar.gz`. Each holds Mendu and its own
copy of Node.js, so the other person only needs VLC: they unzip it and
double-click `Mendu.bat` (Windows) or run `./mendu` (Linux). `READ ME.txt`
inside tells them the rest. `MENDU_SYNC_SERVER` is optional; it presets the
sync server address so they don't have to type it.

## Develop

```sh
cd local  && npm test                               # library and VLC
cd web    && npm test                               # sync logic
cd server && npm test                               # room rules
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
