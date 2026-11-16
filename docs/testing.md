# Manual test checklist

The two-device sync checklist is added with the sync server. This is the
list for the library and VLC playback.

Start with `cd local && npm install && npm start`.

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

Report for each step: worked / didn't, and what you saw.
