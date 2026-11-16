# Phase 1 report: what works on each platform

Last updated 2026-11-16. "Verified" means it was run and observed; everything
else is written but not yet run.

| | Linux | Windows |
| --- | --- | --- |
| App builds and starts | Verified (debug build; ran without errors, screens not yet clicked through) | Not yet: needs the first GitHub Actions run |
| Local file via VLC | Controller verified against VLC 3.0.23 (headless); UI not yet run | Not yet run |
| YouTube | Verified: loads, starts without a click, position reads back. Placement on screen not yet looked at | Not yet run |
| Unit tests (URL parsing, VLC status) | Pass | Same code |

## Verified

- **VLC control works.** `tool/vlc_probe.dart` opened a file, paused, seeked
  to 42.5 s (VLC landed on 42.500), resumed, changed speed to 1.05x and back,
  and closed, all through VLC's HTTP interface.

- **YouTube plays on Linux.** Started with a link on the command line, the
  embedded player loaded, began playing with no click, and reported its
  position advancing (3.9 s, then 17.9 s fourteen seconds later). No error 153,
  so YouTube accepts the app's `127.0.0.1` player page under WebKitGTK.

## Findings

- **VLC reports position in steps.** While playing, the reported position
  only changes every 250 to 500 ms. Read naively, that is up to half a second
  of error, more than the 0.3 s sync target. Phase 3 has to estimate position
  from the moments the value changes rather than trust each reading. Until
  that is built and measured, treat the 0.3 s target for local files as unproven.
- **VLC rounds file length to whole seconds.** Positions are computed from
  VLC's precise fraction times that rounded length. Both partners get the same
  rounding for the same file, so it cancels out between two VLC players. It
  would not cancel against a different player (for example media_kit on
  Android later).
- **Linux has no Flutter web view, so the app brings its own.** The window
  code places a WebKitGTK view over the Flutter view. It works, with one
  limit: Flutter can't draw anything on top of the player (menus, dialogs,
  floating reactions).
- **NVIDIA workaround.** On machines with NVIDIA's proprietary driver the app
  sets `WEBKIT_DISABLE_DMABUF_RENDERER=1`, the same workaround Synaxis uses,
  because WebKitGTK can abort with its default renderer there. On this machine
  the abort only appeared inside the VS Code snap terminal, so the workaround
  may not be needed; it is kept as a precaution and could cost some video
  smoothness.
- **Two Linux setup problems**, both from this machine's setup rather than
  the app, and both described in the README: clang looked for a C++ library
  version that isn't installed, and the VS Code snap terminal makes GTK apps
  exit at startup and stops YouTube videos from starting.
- **Flutter 3.50 moved Material widgets** into the `material_ui` package.
  No problem, only a different import.

## Package choices

- **Windows WebView: `flutter_inappwebview` 6.1.5** (WebView2). Chosen because
  the same package covers Android, and its 6.2 beta adds Linux through WPE
  WebKit, so one adapter may eventually serve every platform.
- **Player page origin.** YouTube rejects embeds from pages without a web
  origin (error 153). The page is served from a loopback HTTP server inside
  the app. Whether YouTube accepts a `127.0.0.1` origin inside WebView2 is the
  first thing the Windows test must confirm.
- **File picker: `file_selector`** (the Flutter team's package).

## Still to confirm on Windows

1. The app builds in GitHub Actions and starts.
2. YouTube plays (no error 153) and starts without a click.
3. Whether Google sign-in is possible inside the player, which decides
   whether YouTube Premium removes ads.
4. VLC is found and controlled the same way as on Linux.
