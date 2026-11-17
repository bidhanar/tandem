# Manual test checklist

Start Tandem with `cd local && npm install && npm start`.

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

### Queue

1. Paste three links separated by spaces and press "Add to queue". With
   nothing playing, the first starts and two appear under "Up next" with
   their titles and pictures, on both sides.
2. Let a video end (or seek to its last seconds): the next one starts for both.
3. "Play now" on a queued video plays it at once; "Remove" and "Clear" work.
4. Paste a playlist page link (`youtube.com/playlist?list=...`): its videos
   are added.
5. When a video ends, click one of YouTube's suggestions in the player: the
   other person's player switches to it too.

### Your own videos (VLC)

You both need the same video file somewhere in your library folders.

1. In a room, go to Home and press Play on a video. VLC opens on both
   computers and starts together. The Watch Together page says "Open in VLC".
2. Pause, play and seek in either VLC: the other follows.
3. Pause both at the same moment and compare the pictures; listen for an
   echo if you are on a call. They should be within about a third of a second.
4. Rename the file on one computer and rescan: it is still found.
5. Give one person a different copy (another resolution) and not the
   original: they are told it isn't the exact file and offered the copy with
   a warning. "Play this one" plays it.
6. With no copy at all: a message names the file's size and length. The
   other person's video starts after about 15 seconds.
7. Close VLC on one computer: the other keeps playing. "Open it again" on the
   Watch Together page rejoins at the right place.
8. While a local video plays, paste a YouTube link: VLC closes and YouTube
   plays for both.

### Trouble

1. Turn off one person's network for 10 seconds. Their page says
   "Reconnecting…"; the other sees them offline and keeps playing. When the
   network returns they rejoin and jump to the right place.
2. Reload one person's page: they are back in the room and in step.
3. Close one person's browser tab (Tandem still running): within a few
   seconds the other sees them offline. Open Tandem again: they are back in
   the room. If a local video was open in VLC, closing the tab doesn't take
   them out; they are still watching.
4. Restart the sync server mid-video (or wait for a free host to sleep and
   wake): both get back into the same room and carry on from the same place.
5. Throttle one person's connection so the video stalls: the other is
   paused, and after a long stall there is a "Starting in 3" countdown.
6. If an ad plays for one person, the other waits (up to 15 seconds).
7. With a video loaded, click Home: the player stays in the corner with
   "Back to the room".
8. Leave room: the other person is told.

## Browser extension (youtube.com)

Build it (`cd extension && npm install && npm run build`) and load
`extension/dist` in two browsers or two browser profiles (see README.md).
With the sync server on `localhost`, allow youtube.com to reach it when the
browser asks (in Brave, turn Shields down for youtube.com).

1. Person A opens a video on youtube.com, clicks Tandem's icon, types a name
   and presses "Create a room". The popup shows a code; a badge with the code
   appears in the corner of the page.
2. Person B, on any youtube.com page, joins with the code. B's tab moves to
   A's video, without reloading, and both play together. The badges say
   "in sync".
3. Pause, play and seek on either side: the other follows.
4. A searches for something: B's tab shows the same search, and the video
   is paused for both. A clicks a result: it plays for both.
5. B clicks the channel name under a video: A's tab opens that channel too.
   B clicks one of its videos: it plays for both.
6. Reload B's tab, on a video and on a search page: B stays in the room and
   on that page.
7. A presses Leave room in the popup: B's badge says the partner left.
8. A on Tandem's page and B with the extension, in the same room: a YouTube
   link pasted on Tandem's page plays on youtube.com for B, and B's pause
   pauses A's player.
9. A popup opened on a tab that isn't YouTube offers to open YouTube.

### Automated checks

```sh
cd server && npm test          # room state rules
cd server && npm run simulate  # two simulated people, about 30 seconds
cd web && npm test             # sync logic
cd extension && npm test       # which youtube.com pages are followed
```

Report for each step: worked / didn't, and what you saw.
