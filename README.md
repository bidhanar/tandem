# Mendu

Watch YouTube videos and your own video files together with someone far
away, in sync. Each person plays their own copy; only play, pause and seek
messages travel between you.

Status: the library and VLC playback work. Rooms and sync are not built yet.

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

## Develop

```sh
cd local
npm test                               # compile and run the unit tests
npm start -- --no-browser --port 8599  # run without opening a tab
```

## Documents

- `docs/spec.md`: the original specification (written for an earlier design)
- `docs/protocol.md`: the sync protocol (to come with the sync server)
- `docs/testing.md`: manual test checklist
- `CLAUDE.md`: architecture, decisions and conventions

## Licence

GPL-3.0-or-later. See `LICENSE`.
