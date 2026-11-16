# Manual test checklist

Start Mendu with `cd local && npm install && npm start`.

## Library

1. The browser opens and shows your videos in rows. A scan indicator shows
   in the top bar while it's still working.
2. Movies and shows are separated (TV Shows / Movies at the top). Episodes of
   one show are grouped under a single card.
3. Cards get artwork within a minute or two (needs FFmpeg).
4. Click a card: the title page opens with episodes or file details.
5. Type in the search box: matching titles appear.
6. Profile menu, Settings: add a folder, save, and the library rescans.
   Adding a folder that doesn't exist shows an error.

## Playback

1. Press Play on a title. VLC opens and plays it; a "Playing in VLC" bar
   appears at the bottom of the page with the time advancing.
2. Pause in VLC. The bar says "Paused in VLC".
3. Close VLC partway through. The title appears under Continue Watching, and
   pressing Play resumes where you stopped.
4. Press the stop button in the bar. VLC closes.
5. For a show, let an episode finish (or seek near the end): VLC moves on to
   the next episode.
6. Mark a title watched and unwatched from its page.

## Watch Together (YouTube)

Both people need the same sync server address in Settings. To try it alone on
one computer, start the server (`cd server && npm install && npm start`) and
use two different browsers, or one normal and one private window, as the two
people. Two normal windows of the same browser count as one person.

### Rooms

1. Person A: Watch Together, Create room. A 6-character code appears.
2. Person B: types the code (any case), Join. Each sees the other "is here".
3. A third person trying the code is told the room is full.
4. A wrong code gives "No room with that code".

### Play, pause, seek

1. A pastes a YouTube link and presses "Play for both". Both players load,
   then start together.
2. Either person pauses in the player: the other pauses at the same spot.
3. Either person presses play: both resume.
4. Either person drags the player's seek bar: the other follows.
5. Seek while paused: the other moves to the same spot and stays paused.
6. The status line says "in sync" most of the time. Compare the two
   players' clocks by eye: they should be within about half a second.
7. Paste a different link: both switch to the new video.
8. Paste a video that can't be embedded: a message explains why.

### Trouble

1. Turn off one person's network for 10 seconds. Their page says
   "Reconnecting…"; the other sees them offline and keeps playing. When the
   network returns they rejoin and jump to the right place.
2. Reload one person's page: they are back in the room and in step.
3. Throttle one person's connection so the video stalls: the other is
   paused, and after a long stall there is a "Starting in 3" countdown.
4. If an ad plays for one person, the other waits (up to 15 seconds).
5. With a video loaded, click Home: the player stays in the corner with
   "Back to the room".
6. Leave room: the other person is told.

### Automated checks

```sh
cd server && npm test          # room state rules
cd server && npm run simulate  # two simulated people, about 30 seconds
cd web && npm test             # sync logic
```

Report for each step: worked / didn't, and what you saw.
