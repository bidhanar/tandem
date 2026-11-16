# Mendu protocol

The sync server protocol is written in Phase 2. This file currently covers the
bridge between the Flutter app and the YouTube player page.

## Player page bridge (`app/assets/player.html`)

The page hosts the official YouTube IFrame player. The app loads it from a
loopback HTTP server so the page has a web origin.

### App to page

JavaScript calls on `window.mendu`. All are ignored until the page has sent `ready`.

| Call | Effect |
| --- | --- |
| `mendu.load(videoId, startSeconds)` | Load a video and start playing from `startSeconds` |
| `mendu.play()` | Play |
| `mendu.pause()` | Pause |
| `mendu.seek(seconds)` | Seek |

### Page to app

JSON strings sent to the WebView handler named `mendu`.

| Message | When |
| --- | --- |
| `{type: "ready"}` | Once, when the IFrame API has loaded |
| `{type: "tick", state, position, duration, rate}` | Every 250 ms and on every state change |
| `{type: "error", code}` | IFrame API error (2, 5, 100, 101, 150, 153) |

`state` is YouTube's number: -1 unstarted, 0 ended, 1 playing, 2 paused,
3 buffering, 5 cued. `position` and `duration` are seconds.
