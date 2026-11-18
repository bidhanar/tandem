# Tandem sync protocol

The sync server (`server/`) holds each room's playback state and relays
changes. Clients connect with Socket.IO. Video and audio never pass through
it: every device plays its own copy.

Where the code lives: the rules are `server/src/room.ts`, the wiring is
`server/src/app.ts`, and the client side is `web/sync-core.js` (logic) and
`web/together.js` (page). The browser extension (`extension/src/tandem.js`)
is another client of the same protocol, so a person on Tandem's page and a
person on youtube.com can share a room.

## Clock sync

Every sync calculation uses server time.

- The client sends `time:ping {t0}` and the server answers with
  `{t0, serverTime}`. The client notes its local send time `t0` and receive
  time `t1`.
- `rtt = t1 - t0`, `offset = serverTime - (t0 + rtt / 2)`.
- 8 samples on connect; the one with the lowest `rtt` wins. Repeated every
  60 seconds.
- `serverNow() = performance.now() + offset`. The local clock is the
  browser's monotonic one, so it doesn't jump if the computer's time changes.

## Room state

```ts
type RoomState = {
  mediaType: 'youtube' | 'local' | null;
  mediaId: string | null;     // YouTube video id, or a file fingerprint
  mediaTitle: string | null;
  isPlaying: boolean;         // what the people asked for
  position: number;           // seconds, at the moment of updatedAt
  playbackRate: number;       // normally 1
  updatedAt: number;          // server time in ms; may be a little in the future
  version: number;            // +1 on every change
  updatedBy: string;          // client id
  loadedBy: string | null;    // who chose the media now loaded (pause/seek don't change it)
  loadedHow: 'picked' | 'autoplay' | 'queue' | null;
  waitingFor: string[];       // client ids still loading or buffering
};
```

The room is **rolling** (actually moving) when
`isPlaying && waitingFor.length === 0 && serverNow() >= updatedAt`.

```
expected position = position + (rolling ? (serverNow() - updatedAt) / 1000 * playbackRate : 0)
```

`isPlaying` is the people's wish; `waitingFor` holds the room still without
changing that wish, so a buffering pause is never confused with someone
pressing pause. An `updatedAt` in the future is a countdown: everyone starts
at that moment.

## Messages

Questions with an answer use Socket.IO acknowledgements.

### Client to server

| Event | Payload | Answer |
| --- | --- | --- |
| `time:ping` | `{t0}` | `{t0, serverTime}` |
| `room:create` | `{clientId, name}` | `{ok: true, room}` or `{ok: false, error}` |
| `room:join` | `{code, clientId, name}` | same |
| `room:leave` | none | none |
| `state:request` | `{action, position?, mediaType?, mediaId?, mediaTitle?, how?}` | none; a `state:changed` follows if accepted |
| `buffer:start` | none | none |
| `buffer:end` | none | none |
| `queue:add` | `{mediaIds}` (YouTube video ids) | none; `queue:changed` follows |
| `queue:remove` | `{id}` | none |
| `queue:clear` | none | none |
| `queue:play` | `{id}`: play this entry now | none |
| `media:ended` | `{mediaId}` | none |
| `page:send` | `{path}`: this tab moved to another youtube.com page | none |
| `chat:send` | `{text}` | none |
| `reaction:send` | `{emoji}` | none |
| `member:away` | `{away}` (boolean): you stepped away (AFK), or are back | none; `member:changed` follows if it changed |

`room` is `{code, state, queue, members, you}`. `clientId` is a random id the
client makes once and keeps, so a reconnect is recognised as the same person.
`action` is `play`, `pause`, `seek` or `load`.

### Server to clients in the room

| Event | Payload |
| --- | --- |
| `state:changed` | `{state}` |
| `member:joined` | `{members}` |
| `member:left` | `{members}` |
| `member:changed` | `{members}` (someone's `away` changed) |
| `queue:changed` | `{queue}`, entries `{id, mediaId, addedBy}` |
| `page` | `{from, path}` (to everyone in the room but the sender) |
| `chat:message` | `{from, name, text, at}` |
| `reaction` | `{from, emoji}` |

`members` is `[{id, name, online, away}]`. `away` is only a status for the
others to see (the extension's "I'm away" button); playback ignores it. The
server forgets it when it restarts, so the extension sends `member:away`
again after every join.

## Rules

- **The server decides.** It applies each request, raises `version`, stamps
  `updatedAt` and `updatedBy`, and broadcasts. Last write wins. Clients
  ignore any state whose version isn't newer than the one they have.
- **Load** sets the media, sets `isPlaying`, and puts every online member in
  `waitingFor`. Playback starts when the last one reports `buffer:end`.
- **Who chose it.** A load sets `loadedBy` to the sender and `loadedHow` to
  `picked`, or `autoplay` if the request says `how: 'autoplay'`: the
  extension saw the video end and the tab move on with no click or key
  press in the 4 seconds before. A queued video that starts because its
  turn came is `queue`, credited to whoever added it; pressing play on a
  queue entry is a pick by whoever pressed it.
- **Joining** a room with media loaded puts the newcomer in `waitingFor`.
- **Ready** means the client's player is really playing. A client that is
  listed in `waitingFor` lets its player run until it plays, sends
  `buffer:end`, and is then held at the room's position until everyone is ready.
- **Stalls.** A client whose player buffers for 700 ms while the room is
  rolling sends `buffer:start`; the server freezes the position and lists it.
- **Countdown.** When the last waiting member is ready and the room had been
  held for 2 seconds or more, `updatedAt` is set 3 seconds ahead.
- **Timeout.** A member listed for more than 15 seconds is dropped from
  `waitingFor`, so one broken player can't hold the room forever.
- **Disconnecting** keeps the member's seat (shown offline) and removes them
  from `waitingFor`. `room:leave` gives the seat up.
- **One person, several connections.** A person's page and their local
  program (which drives VLC) join with the same `clientId` and share one
  seat. They are offline only when every connection is gone. `room:leave`
  from any of them removes them all.
  The local program follows the page: the page repeats
  `POST /api/together/join` every 15 s and sends `/api/together/gone` when the
  tab closes. Without word from the page for 75 s (or at once after `gone`),
  the local program disconnects, unless a VLC window for the room is open.
- **Queue.** YouTube videos wait in `queue`. `queue:add` to a room with
  nothing loaded starts the first one. When a video finishes, every client
  sends `media:ended`; it counts only while that video is still the room's
  current one, so the next entry starts exactly once.
- **Local files.** `mediaId` is `v1.<hash>.<size>.<seconds>`: the first 32
  hex digits of a SHA-256 over the file's first and last 4 MB, its size in
  bytes, and its length. A client plays a file whose size and hash match;
  failing that it may offer files of the same length (within 1 s) as
  "another version", to be played only if the person agrees.
- **Restoring.** Rooms live in memory, so a server restart loses them.
  `room:join` may carry `restore: {mediaType, mediaId, mediaTitle, isPlaying,
  position, queue}`, which is what the client last knew, with `position` as
  of now. If no room has that code and the code is one the server could have
  made, the room is rebuilt from it. Clients always send it when rejoining.
- **Pages (browser extension).** When someone moves to another page on
  youtube.com (a search, a channel, the home page), their extension sends
  `page:send` with the path, and the server passes it on. The server only
  checks that it is a path; the receiving extension opens it only if it is a
  page for finding something to watch (`extension/src/youtube-page.js`), so a
  partner can't send you to account pages or sign-out. `/@handle` channel
  paths are sent as `/channel/<id>`, which YouTube opens without reloading
  the tab. Videos themselves go through the room state as usual. Leaving a
  video's page pauses it for both (YouTube stops a video when you leave its
  page); picking a video loads it for both.
- **Rooms** hold 2 people by default (`MAX_MEMBERS`), have a 6-character
  code from an alphabet without look-alike characters, and are forgotten
  after 10 minutes with nobody connected.
- **Rate limit.** 20 create/join attempts per address per minute.

## Client behaviour (`web/sync-core.js`)

- **Feedback-loop prevention.** After the client commands its player, the
  player's own events are ignored for 1.5 s. Outside that window a player
  that disagrees with the room means the person pressed something, unless
  the player is only doing what it was last told. Each action is sent once:
  the client assumes the server will accept it, so later readings agree.
- **Seek detection.** The position moving more than 1 s beyond what playback
  explains, compared with the last reading that wasn't buffering.
- **Drift correction**, checked every 2 seconds while rolling:
  - YouTube: under 0.5 s leave it; over 0.5 s seek, at most once per 5 s,
    aiming slightly ahead to allow for rebuffering.
  - Local files: under 0.15 s leave it; up to 0.5 s play 5% faster or slower;
    up to 2 s 10%; beyond 2 s seek.
- All thresholds are in `web/sync-config.js`; server timings are in
  `server/src/config.ts`.
