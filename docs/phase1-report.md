# Phase 1 report: what works on each platform

Last updated 2026-11-16. "Verified" means it was run and observed; everything
else is written but not yet run.

| | Linux | Windows |
| --- | --- | --- |
| App builds | Not yet: this machine lacks `clang` and `ninja-build` | Not yet: needs the first GitHub Actions run |
| Local file via VLC | Controller verified against VLC 3.0.23 (headless); UI not yet run | Not yet run |
| YouTube | Deferred (no WebView chosen) | Not yet run |
| Unit tests (URL parsing, VLC status) | Pass | Same code |

## Verified

- **VLC control works.** `tool/vlc_probe.dart` opened a file, paused, seeked
  to 42.5 s (VLC landed on 42.500), resumed, changed speed to 1.05x and back,
  and closed, all through VLC's HTTP interface.

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
