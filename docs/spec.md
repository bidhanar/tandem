# Project: "SyncUs" — a sync-playback app for long-distance couples

## What we're building
A cross-platform app (Android, Windows, Ubuntu/Linux) that lets two people in different
places watch YouTube videos, listen to YouTube Music tracks, or play the SAME local media
file together, perfectly in sync. Either partner can play, pause, seek, or change what's
playing, and the other's player follows within a fraction of a second.

Video and audio are NEVER streamed between users. Each device plays its own copy
(YouTube embed or local file). Only small control events travel through a sync server.

## How I want you to work
- Before writing any code, read this whole spec, then reply with: (1) your implementation
  plan, (2) any questions or concerns, (3) any part of the spec you think is wrong.
  Wait for my answer before starting.
- Create a CLAUDE.md at the repo root summarising the architecture, commands, and
  conventions, and keep it updated as the project evolves.
- Build in the phases below. At the end of each phase, stop, tell me exactly how to test
  it on my machines, and wait for my confirmation before the next phase.
- Make a git commit at each working milestone with a clear message.
- If a package doesn't work on one platform, tell me. Don't silently hack around it.
- Prefer simple, readable code over clever code. I'm going to maintain this.

## Tech stack
- **App:** Flutter (latest stable), targeting Android, Windows, and Linux desktop.
- **Local playback:** `media_kit` + `media_kit_video` + the matching `media_kit_libs_*`
  packages (libmpv-based, wide format support, precise positions).
- **YouTube playback:** the official YouTube IFrame Player API loaded inside a WebView.
  Research and pick the best-maintained WebView option PER PLATFORM (Android, Windows
  WebView2, Linux). Linux WebView support in Flutter is the known weak spot, so Phase 1
  exists to prove it works. Put YouTube behind an abstract `YouTubePlayerAdapter` so the
  platform implementation can be swapped.
- **Sync server:** Node.js + TypeScript + Socket.IO. Rooms held in memory for the MVP.
  Include a Dockerfile so I can deploy it to a cheap host later.
- **State management (Flutter):** Riverpod, unless you have a strong reason otherwise.

## Hard constraints
- Do NOT use yt-dlp, youtube_explode, or any other method that extracts YouTube streams.
  YouTube must ONLY play through the official embedded IFrame player, which must stay
  visible (at least 200x200 px). This is a YouTube Terms of Service requirement.
- No user accounts in the MVP. Pairing works via a 6-character room code.
- No media files are ever uploaded to the server.

## Repo structure
```
/app        Flutter app
/server     Node + TypeScript sync server
/docs       protocol.md (the sync protocol), testing.md
CLAUDE.md
README.md   setup + run instructions for all 3 platforms + server
```

## Sync design (follow this closely)

### 1. Clock sync
Each client estimates its clock offset from the server:
- Client sends `time:ping` with local time t0. Server replies with serverTime ts.
  Client receives the reply at t1.
- rtt = t1 - t0; offset = ts - (t0 + rtt/2)
- Take 8 samples on connect and use the offset from the lowest-rtt sample.
  Re-sync every 60 seconds.
- `serverNow() = Date.now() + offset` is used for every sync calculation.

### 2. Authoritative room state (held by the server)
```ts
type RoomState = {
  mediaType: 'youtube' | 'local' | null;
  mediaId: string | null;     // YouTube video ID, or file fingerprint for local
  mediaTitle: string | null;
  isPlaying: boolean;
  position: number;           // seconds, at the moment of updatedAt
  playbackRate: number;       // normally 1.0
  updatedAt: number;          // server timestamp (ms)
  version: number;            // incremented by the server on every change
  updatedBy: string;          // client id
};
```
Expected current position = position + (isPlaying ? (serverNow() - updatedAt)/1000 : 0)

### 3. Events
- Client → server: `room:create`, `room:join {code}`, `state:request {action: play|pause|seek|load, position, mediaType, mediaId, mediaTitle}`,
  `buffer:start`, `buffer:end`, `time:ping`, `chat:send`, `reaction:send`
- Server → clients: `room:joined {state, members}`, `state:changed {state}`,
  `member:joined/left`, `time:pong`, `chat:message`, `reaction`
- The server is the single source of truth. It applies each request, increments
  `version`, stamps `updatedAt`, and broadcasts. Last write wins.
- Clients ignore any state older than the version they already have.

### 4. Feedback-loop prevention (important)
When a client applies a remote state change (e.g. seeks its player), the player fires
its own events. These MUST NOT be sent back to the server as new user actions. Implement
a clear mechanism (e.g. an `applyingRemote` flag with a short guard window, or comparing
against the expected state) and write tests for it.

### 5. Drift correction
Every 2 seconds while playing, compare actual player position vs expected position:
- **Local files (media_kit):**
  - drift < 0.15s → do nothing
  - 0.15s – 2s → temporarily set rate to 1.05 or 0.95 until caught up, then back to 1.0
  - > 2s → hard seek
- **YouTube:** the IFrame API only supports a few discrete playback rates, so use seeking only:
  - drift < 0.5s → do nothing
  - > 0.5s → hard seek (with a cooldown so it doesn't seek repeatedly)
- Put the thresholds in one config file.

### 6. Buffering
If any member reports `buffer:start`, the server pauses the room (keeping the position).
When all members report `buffer:end`, it resumes, with a short "3-2-1" countdown in the UI.
This also handles YouTube ads, which play independently on each device.

### 7. Local file matching
When a user picks a local file, compute a fingerprint: file size + duration + SHA-256 of
the first 4 MB and last 4 MB. Run hashing in an isolate so the UI doesn't freeze.
- Fingerprints match → play normally.
- Only the duration matches (within 1s) → warn "these look like different versions,
  sync may be off" and let the user continue.
- Nothing matches → block with a clear message.
- The room shows which file is expected, so the partner knows what to open.

### 8. Reconnection
Auto-reconnect with backoff. On reconnect, rejoin the room and snap to the server state.
The UI shows connection status and whether the partner is online.

## Features by phase

**Phase 1 — Platform proof (no sync yet)**
- Flutter app that runs on Android, Windows, and Linux.
- Screen 1: paste a YouTube or YouTube Music URL → plays in the WebView IFrame player,
  with play/pause/seek controls driven from Flutter through the JS bridge, and current
  position read back.
- Screen 2: pick a local file → plays with media_kit, same controls.
- Deliverable: a written report of what works on each platform, plus any problems.

**Phase 2 — Sync server + YouTube sync**
- Server with rooms, clock sync, the state model, and all events above.
- App: create/join room with a code, YouTube sync, feedback-loop prevention, drift
  correction, buffering handling.
- Server unit tests for state transitions; a test script that simulates two clients.

**Phase 3 — Local file sync**
- Fingerprinting, match checking, media_kit sync with rate-based drift correction.
- Background playback for local files on Android (foreground service + media
  notification). YouTube will stop in the background, so show a clear message about it.

**Phase 4 — Couple features**
- Text chat panel, floating emoji reactions over the player (hearts etc.).
- Partner presence: online/offline, "watching now", connection quality.
- A shared queue: either partner can add YouTube links; the next item auto-plays for both.

**Phase 5 — Polish**
- Clean, warm UI with dark mode by default; responsive for phone and desktop window sizes.
- Settings: server URL, display name, sync thresholds (advanced).
- Build instructions for: Android APK, Windows installer/zip, Linux AppImage or .deb.

## URL handling
Accept and extract the video ID from all of these formats:
- youtube.com/watch?v=ID, youtu.be/ID, youtube.com/shorts/ID, m.youtube.com/...
- music.youtube.com/watch?v=ID (YouTube Music tracks use normal video IDs)
- URLs with extra params (&t=, &list=, &si=)
Show a friendly error when a video has embedding disabled (IFrame error codes 101/150).

## Quality bar
- Two devices on different networks should stay within ~0.3s for local files and ~0.7s for YouTube.
- No feedback loops: one user action must cause exactly one state change.
- Write /docs/testing.md with a manual test checklist: two devices, play, pause, seek,
  change video, kill network on one device, rejoin, ad interruption, mismatched files.

Start by reading this, then send me your plan and questions. Don't write code yet.