# SyncUs

Watch YouTube videos and local video files together with someone far away,
in sync. Each device plays its own copy; only play, pause and seek messages
travel between you.

Status: **Phase 1** (players work on their own; no rooms or sync yet).
Windows and Linux. YouTube works on Windows only for now.

## Get the app

Every push builds the apps: open the latest run on the repository's Actions
tab and download `syncus-windows-x64` or `syncus-linux-x64` from Artifacts.

- **Windows:** unzip and run `syncus.exe`. Needs [VLC](https://www.videolan.org/vlc/)
  for local files. The WebView2 runtime it uses ships with Windows 10 and 11.
- **Linux:** `tar xzf syncus-linux-x64.tar.gz && ./bundle/syncus`. Needs VLC
  (`sudo apt install vlc`).

## Build it yourself

Install [Flutter](https://docs.flutter.dev/get-started/install) 3.50 or newer.

Linux also needs:

```sh
sudo apt install clang cmake ninja-build pkg-config libgtk-3-dev liblzma-dev vlc
```

Windows also needs Visual Studio 2022 with "Desktop development with C++".

```sh
cd app
flutter test
flutter run -d linux      # or: -d windows
flutter build linux --release
flutter build windows --release
```

## Documents

- `docs/spec.md`: the original specification
- `docs/protocol.md`: messages between the app, the player page and (later) the server
- `docs/testing.md`: manual test checklist
- `docs/phase1-report.md`: what works on each platform
