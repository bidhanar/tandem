# Manual test checklist

The two-device sync checklist is added in Phase 2. This is the Phase 1 list.

## Phase 1: players on their own

### Local file (Linux and Windows)

VLC must be installed.

1. Open the **Local file** tab and choose a video. A VLC window opens and plays.
2. Press pause in Mendu. VLC pauses; the button turns into Play.
3. Press play. VLC resumes.
4. Drag the seek bar to the middle and release. VLC jumps there.
5. Watch the position readout: it advances while playing and holds while paused.
6. Pause or seek inside the VLC window itself. Mendu follows within half a second.
7. Close the VLC window. Mendu shows "No file open".
8. Choose a second file while the first is playing. The first VLC closes, the new one opens.
9. Try a file with spaces and non-English characters in its name.

### YouTube (Windows only for now)

1. Open the **YouTube** tab. "Player loading…" changes to a state line within a few seconds.
2. Paste each link shape and press Load; the video should start **without clicking the player**:
   - `https://www.youtube.com/watch?v=aqz-KE-bpKQ`
   - `https://youtu.be/aqz-KE-bpKQ?t=30`
   - `https://www.youtube.com/shorts/<any short>`
3. Pause, play and seek from the Mendu controls. The player follows.
4. Pause and seek using the player's own controls. The Mendu readout follows.
5. Paste a video with embedding disabled. A message explains the owner doesn't allow it.
6. Paste nonsense text. A message says it isn't a YouTube link.
7. Note whether an ad plays before the video, and whether the player offers a
   way to sign in to your Google account (this decides whether Premium applies).
8. Resize the window small. The player never drops below 200x200.

Report for each step: worked / didn't, and what you saw.
