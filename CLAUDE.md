# Mendu

Two people in different places watch the same YouTube video or the same local
file in sync. Each device plays its own copy; only small control messages go
through a sync server. Full spec: `docs/spec.md` (it calls the project
"SyncUs"; the name is now Mendu). Decisions that changed the
spec are listed below and win over it.

## Layout

```
app/      Flutter app (Windows + Linux desktop)
server/   Node + TypeScript + Socket.IO sync server   (Phase 2, not yet written)
docs/     spec.md, protocol.md, testing.md, phase1-report.md
.github/workflows/build.yml   analyze + test, then Linux and Windows builds
```

## Commands

Flutter lives at `~/development/flutter/bin` (add it to PATH).

```sh
cd app
flutter analyze
flutter test
flutter run -d linux                      # needs clang + ninja-build
dart run tool/vlc_probe.dart <video>      # exercise VLC control without the UI
```

Windows builds only happen in GitHub Actions; there is no Windows toolchain here.

Two quirks of this machine (details in README "Build it yourself"):

- clang selects GCC 16, whose libstdc++ isn't installed. Until
  `libstdc++-16-dev` is installed, build with
  `CXXFLAGS=--gcc-install-dir=/usr/lib/gcc/x86_64-linux-gnu/15` (same for
  `CFLAGS` and `LDFLAGS`).
- The VS Code snap terminal breaks GTK apps and GStreamer (app aborts, or
  YouTube never starts). Run the built app under `env -i` with only `HOME`,
  `USER`, `PATH`, `LANG`, `DISPLAY`, `WAYLAND_DISPLAY`, `XDG_RUNTIME_DIR`,
  `XDG_SESSION_TYPE`, `XDG_CURRENT_DESKTOP` and `DBUS_SESSION_BUS_ADDRESS`
  passed through.
- `mendu <YouTube link>` loads that video at startup; with the page messages
  logged temporarily, that is how to check YouTube playback without clicking.

## Architecture (app)

- `lib/youtube/` — `YouTubePlayerAdapter` is the interface; one implementation
  per platform. Both extend `PageBridgeAdapter`, which holds the shared
  message handling. `InAppWebViewYouTubeAdapter` (flutter_inappwebview,
  WebView2) serves Windows. `GtkYouTubeAdapter` serves Linux: there is no
  Flutter web view widget on Linux, so `linux/runner/youtube_view.cc` lays a
  WebKitGTK view over the Flutter view (GtkOverlay) and the Dart side keeps it
  positioned over an empty placeholder box via the `mendu/youtube_view`
  method channel. Flutter can't draw on top of that view.
  `assets/player.html` hosts the official IFrame player and is served from a
  loopback HTTP server (`PlayerPageServer`), because YouTube rejects pages
  with no web origin (error 153).
- `lib/local/` — `LocalPlayer` is the interface; `VlcPlayer` launches VLC and
  drives it through VLC's HTTP interface on 127.0.0.1 with a per-launch password.
- `lib/ui/` — screens and shared widgets. Colours come from Synaxis.
- Player classes are plain Dart (no widgets) so they can be tested and faked.

## Decisions that differ from docs/spec.md

- Platforms: Windows and Linux only for now. Android is postponed.
- Local playback: VLC (external window), not media_kit. Keep `LocalPlayer`
  generic so media_kit can be added for Android later.
- YouTube only; YouTube Music links are rejected.
- Rooms hold two people by default; the limit must be a server setting.
- Builds come from GitHub Actions; the repo is public.
- Accepted spec changes: `waitingFor` list for buffering (separate from user
  pause), buffering debounce, reactions beside (not over) the YouTube player,
  seek-ahead compensation for YouTube, two-step rate correction for local
  files, expected-state comparison for feedback-loop prevention, persistent
  client id, empty rooms kept ~10 min, join rate limit, monotonic clock.
- The local-file screen will become a Synaxis-style library (ported to Dart
  from `~/Projects/synaxis`, which is GPL-3.0).

## Conventions

- Simple, readable code over clever code; the owner maintains this.
- Never extract YouTube streams (no yt-dlp, youtube_explode). Only the
  official IFrame player, kept visible and at least 200x200.
- If a package fails on a platform, report it; don't hack around it silently.
- Stop at the end of each phase with test instructions and wait for confirmation.
- Commit at each working milestone. Never push; the owner pushes.
- Licence: GPL-3.0-or-later.
- Material widgets import from `package:material_ui/material_ui.dart`
  (Flutter 3.50 moved Material out of the SDK).
- All sync thresholds go in one config file (Phase 2).
