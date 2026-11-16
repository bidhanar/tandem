# Mendu

Watch YouTube videos and local video files together with someone far away,
in sync. Each device plays its own copy; only play, pause and seek messages
travel between you.

Status: **Phase 1** (players work on their own; no rooms or sync yet).
Windows and Linux.

## Get the app

Every push builds the apps: open the latest run on the repository's Actions
tab and download `mendu-windows-x64` or `mendu-linux-x64` from Artifacts.

- **Windows:** unzip and run `mendu.exe`. Needs [VLC](https://www.videolan.org/vlc/)
  for local files. The WebView2 runtime it uses ships with Windows 10 and 11.
- **Linux:** `tar xzf mendu-linux-x64.tar.gz && ./bundle/mendu`. Needs VLC,
  WebKitGTK and the GStreamer codecs:
  `sudo apt install vlc libwebkit2gtk-4.1-0 gstreamer1.0-plugins-good gstreamer1.0-plugins-bad gstreamer1.0-libav`.

## Build it yourself

Install [Flutter](https://docs.flutter.dev/get-started/install) 3.50 or newer.

Linux also needs:

```sh
sudo apt install clang cmake ninja-build pkg-config libgtk-3-dev liblzma-dev \
  libwebkit2gtk-4.1-dev gstreamer1.0-plugins-good gstreamer1.0-plugins-bad gstreamer1.0-libav vlc
```

Two Linux problems you may hit:

- **`cannot find -lstdc++` during the build.** clang is using a GCC version
  whose C++ library isn't installed. `clang++ -v` names the version it
  selected; install the matching package, for example
  `sudo apt install libstdc++-16-dev`.
- **Started from the terminal inside the VS Code snap, the app exits at once
  with a `GLib-GIO-ERROR`, or YouTube videos load but never start.** That
  terminal points GTK and GStreamer at the snap's own files. Start the app
  from a normal terminal instead.

Windows also needs Visual Studio 2022 with "Desktop development with C++".

```sh
cd app
flutter test
flutter run -d linux      # or: -d windows
flutter run -d linux -a 'https://youtu.be/aqz-KE-bpKQ'   # open a video straight away
flutter build linux --release
flutter build windows --release
```

## Documents

- `docs/spec.md`: the original specification
- `docs/protocol.md`: messages between the app, the player page and (later) the server
- `docs/testing.md`: manual test checklist
- `docs/phase1-report.md`: what works on each platform

## Licence

GPL-3.0-or-later. See `LICENSE`.
