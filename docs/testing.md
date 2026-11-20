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
10. Chat: click 💬 on the badge, type a message (letters like k, f and m go
    into the box, not to YouTube) and press Enter. It shows for both; with
    the panel closed, the other's badge shows the message and a count on 💬.
    The popup has the same chat: open it, type, press Enter; the message
    shows in both popups and both badge panels, and opening the popup
    clears the badge's count.
11. Reactions: click an emoji under the chat. It rises from the badge for
    both, with the sender's name on the other side.
12. Away: press "I'm away" (in the popup or the chat panel). The other's
    badge says you are away and its dot turns yellow; "I'm back" undoes it.
    It survives a reload of your tab. On Tandem's page the person shows as
    "is away".
13. Who chose it: when B picks a video, A's badge says "B picked it" for a
    few seconds, and the chat panel and popup say "This video: B picked it".
    Let a video end with autoplay on (don't touch anything): it says
    "YouTube autoplayed it on B's side" (or "on your side"). Clicking an
    end-screen video instead counts as a pick. On Tandem's page it shows
    after the title.
14. Invite link: A presses "Copy invite link" in the popup and opens it in
    B's browser (in a new tab). B's tab joins the room by itself and goes
    to the room's video. The address bar no longer shows `#tandem=…`.
15. Queue: right-click a video thumbnail or link on youtube.com, "Add to
    Tandem queue". It shows in both popups under "Up next", with picture
    and title. ▶ plays it for both; ✕ takes it out. When the current video
    ends, the queued one plays for both, not YouTube's autoplay pick.
    Right-clicking a video when not in a room says to join one first.
16. Unread: with B's YouTube tab in the background (or the chat closed), A
    sends a message. B's tab title starts with "💬1 ·" and a soft sound
    plays (turn it off with "Sound for new messages" in the popup). Opening
    the chat clears it.
17. Pause when away: while playing, B presses "I'm away": it pauses for
    both, and A's badge says "Paused at … · B stepped away". B presses
    "I'm back": a green "▶ Resume" appears for both; pressing it plays.
    Closing B's tab: after 5 seconds A is paused ("B went offline"). With
    "Pause for everyone when someone steps away" unticked (in either
    popup), none of this pauses.
18. Typing: while A types, B's chat panel and popup say "A is typing…".
19. Connection: the chat panel and popup show each person's round trip and
    whether they're in sync ("Ben: 96 ms · in sync"), updated every 5 s.
20. Tandem's page: the room has a chat column beside the player with the
    same chat, reactions (rising inside the column), "typing…", each
    person's connection, and the pause option. A message that comes while
    you're in the library shows as a toast and "💬1 ·" in the tab title.
    "Copy invite link" gives a youtube.com link for someone with the
    extension.

## Browser extension (YouTube Music)

The same extension, on music.youtube.com. Reload any YouTube Music tab that
was open before installing or updating it.

1. Person A plays a song on music.youtube.com, clicks Tandem's icon and
   presses "Create a room". The badge sits above YouTube Music's player bar
   at the bottom, not over its buttons.
2. Person B, on any YouTube Music page, joins with the code. B's player
   plays A's song, from where A is. The badges say "in sync" (on YouTube
   Music that means within half a second).
3. Pause, play and seek on either side, with the player bar's buttons: the
   other follows.
4. A goes to Explore, an artist, an album, a playlist and a search: B's tab
   follows each time, and the music keeps playing for both.
5. B plays a song from a list (search results, an album): it plays for both,
   and A's badge says "B picked it". Also try ⏭ (next) in the player bar.
6. Let a song end without touching anything: YouTube Music's next song plays
   for both, and the badge says "YouTube autoplayed it on …'s side".
7. Queue: right-click a song's title (a link) and pick "Add to Tandem
   queue". When the current song ends, the queued one plays for both, not
   YouTube Music's next.
8. Free accounts: an ad before a song makes the other person wait (the
   badge says "Waiting for … to load"), then both start together.
9. Keep the YouTube Music tab in the background for a few minutes while
   listening: it stays in step, and a pause from the other side still
   pauses it.
10. Reload B's tab: B stays in the room, and the song comes back.
11. Invite link: "Copy invite link" in the popup gives a music.youtube.com
    link; opened in B's browser it joins the room.
12. Mixed: A on youtube.com and B on YouTube Music in one room. A video A
    picks plays in B's YouTube Music, and a song B picks plays on A's
    youtube.com. A's search isn't followed (it's a youtube.com page), but
    the home page and channels are. While the room plays, B looking around
    YouTube Music doesn't take A away from the video.
13. Song and video: switch a song to its video (the Song/Video switch at the
    top, with Premium): the other person switches too, at the same place.

### Automated checks

```sh
cd server && npm test          # room state rules
cd server && npm run simulate  # two simulated people, about 30 seconds
cd web && npm test             # sync logic
cd extension && npm test       # which youtube.com and YouTube Music pages are followed
```

Report for each step: worked / didn't, and what you saw.
