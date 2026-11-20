// Tandem on youtube.com and YouTube Music: keeps this tab in step with your partner's.
//
// content.js loads this into every youtube.com and music.youtube.com tab. A tab joins a room when
// you press Create or Join in the extension's popup. The room is remembered
// for that tab only (sessionStorage), so reloading keeps you in it and your
// other YouTube tabs stay out of it.
//
// What is shared:
// - The video, and play, pause and seek. That is the room's state on the
//   sync server, applied by web/sync-core.js exactly as on Tandem's own page,
//   so someone on Tandem's page and someone on youtube.com can watch together.
// - Where you are on youtube.com: a search, a channel, the home page. It goes
//   out as 'page:send' and your partner's tab opens the same page. Leaving a
//   video for another page pauses it for both of you, because YouTube stops a
//   video when you leave its page. Picking a video plays it for both.
//
//
// On YouTube Music (music.youtube.com) the same, except that the music plays
// on while you look around: the song is whatever its player has, not the
// page's address. Picking a song plays it for both; looking around takes
// your partner's tab along but doesn't pause anything.
//
// YouTube's player is reached through bridge.js, which runs in the page itself.

import { io } from './socket.io.esm.min.js';
import { SYNC_CONFIG } from './sync-config.js';
import { expectedPosition, bestOffset, isRolling, restoreInfo, SyncController } from './sync-core.js';
import { inviteCode, inviteLink, pageOf, samePage, shareablePath, videoIdOf, watchPath } from './youtube-page.js';
import { musicEndpoint, musicPageOf, musicShareablePath } from './music-page.js';
import { DEFAULT_SERVER } from './defaults.js';

/** This tab is YouTube Music, not youtube.com. */
const MUSIC = location.hostname === 'music.youtube.com';
/** What is being played, in words. */
const THING = MUSIC ? 'song' : 'video';

/** How often the player is read. */
const READ_MS = 250;
/** A page we asked YouTube to open counts as ours if it shows up within this long. */
const GOING_MS = 8000;
/** How long to wait for YouTube to say what a new page is before passing it on. */
const SHARE_WAIT_MS = 3000;
/**
 * Drift shown as "in sync" in the status line. YouTube Music's player only
 * takes its few fixed speeds, so drift there is fixed by seeking, and only
 * beyond the seek threshold.
 */
const IN_SYNC = MUSIC ? SYNC_CONFIG.youtube.seekThreshold : 0.25;
/** A playing video this close to its end (seconds) is ending: what comes next may be autoplay. */
const ENDING_S = 2;
/**
 * YouTube Music goes straight on to its own next song. When the room's queue
 * has the next one instead, wait this long for it before going back to the
 * song that ended.
 */
const QUEUE_WAIT_MS = 3000;
/**
 * A move to another video with no click or key press for this long before
 * it, right after the video ended, is YouTube's autoplay, not the person.
 */
const AUTOPLAY_QUIET_MS = 4000;
/** How often your connection and sync are reported to the others. */
const STATS_MS = 5000;
/** Reports older than this are no longer shown. */
const STATS_STALE_MS = 16_000;
/** "Typing" goes out at most this often while you type… */
const TYPING_SEND_MS = 2000;
/** …and is shown this long after it last came. */
const TYPING_SHOW_MS = 3500;
/** A round trip slower than this is called slow. */
const SLOW_RTT_MS = 400;

const T = {
  settings: null, // { server, name, clientId }
  socket: null,
  connection: 'offline', // 'offline' | 'connecting' | 'online' | 'reconnecting'
  clockOffset: 0, // server time minus performance.now()
  message: '', // what went wrong, or what is taking a while; shown in the popup
  room: null, // { code, members, you }
  queue: [], // videos lined up to play next: [{ id, mediaId, addedBy }]
  titles: new Map(), // video id -> title (null while being looked up)
  options: { pauseOnAway: true }, // the room's options (see docs/protocol.md)
  controller: null,
  page: currentPage(), // the page this tab shows
  track: null, // YouTube Music: the song its player had at the last reading
  goingTo: null, // a page we asked YouTube to open (for the room or the partner), with `at`
  toShare: null, // { page, since }: a page of ours to pass on to the partner
  leftVideo: undefined, // the room's video when we left its page to look around
  held: null, // room state that came while looking around, for when we're back on a video
  readyFor: null, // the held state's version we already said we're ready for
  endedSent: null, // the video whose ending we have reported
  lastPosition: 0, // where the video was before an ad started
  notice: null, // { text, until }: a short message in place of the status
  compact: false, // the badge is folded down to the room code
  lastInput: -Infinity, // when the person here last clicked or pressed a key on the page
  lastEnded: null, // { videoId, at }: the last video seen reaching its end here
  announced: null, // the room video whose "who chose it" we have shown
  away: false, // you said you're away from the screen (AFK); the others see it
  chat: [], // messages in this room, oldest first: { from, name, text, at }
  unread: 0, // messages that came while the chat was closed
  chatOpen: false, // the chat panel above the badge is open
  chatSound: true, // a soft sound for messages that come while you're not looking
  typing: new Map(), // client id -> when they were last said to be typing
  lastTypingSent: 0,
  stats: new Map(), // client id -> { rtt, drift, at }: connection and sync, yours included
  timers: [],
};

/** Reactions offered under the chat. */
const REACTIONS = ['👍', '😂', '😮', '😢', '❤️', '🔥'];
/** Chat messages kept (and remembered for a reload). */
const CHAT_KEEP = 100;
/** Chat messages the popup shows. */
const POPUP_CHAT = 50;

const serverNow = () => performance.now() + T.clockOffset;

const remember = {
  get(key) { try { return JSON.parse(sessionStorage.getItem(`tandem.${key}`)); } catch { return null; } },
  set(key, value) { try { sessionStorage.setItem(`tandem.${key}`, JSON.stringify(value)); } catch { /* blocked */ } },
  remove(key) { try { sessionStorage.removeItem(`tandem.${key}`); } catch { /* blocked */ } },
};

async function loadSettings() {
  const saved = await chrome.storage.local.get(['server', 'name', 'clientId']);
  if (!saved.clientId) {
    // This browser's permanent id in rooms, so a reconnect is recognised as the same person.
    saved.clientId = crypto.randomUUID();
    await chrome.storage.local.set({ clientId: saved.clientId });
  }
  return {
    server: (saved.server || DEFAULT_SERVER).trim().replace(/\/+$/, ''),
    name: (saved.name || '').trim() || 'Guest',
    clientId: saved.clientId,
  };
}

// ---------- YouTube's player, through bridge.js ----------

function bridge(command) {
  const root = document.documentElement;
  root.removeAttribute('data-tandem-answer');
  root.setAttribute('data-tandem-command', JSON.stringify(command));
  document.dispatchEvent(new Event('tandem:command'));
  const answer = root.getAttribute('data-tandem-answer');
  root.removeAttribute('data-tandem-answer');
  try {
    return JSON.parse(answer);
  } catch {
    return null;
  }
}

/** A path on this tab's site, described (see youtube-page.js and music-page.js). */
const pageAt = (path) => (MUSIC ? musicPageOf(path) : pageOf(path));

/**
 * The page this tab shows. On YouTube Music, by the address it is sent to
 * your partner with (a channel by its id, not its handle), so that a page
 * we were sent to is recognised when it shows up.
 */
function currentPage() {
  if (!MUSIC) return pageOf(location.href);
  const shown = bridge({ do: 'page' });
  return musicPageOf(musicShareablePath(location.pathname + location.search, shown?.browseId));
}

/** Opens a page in this tab, without reloading it. */
function go(path) {
  const target = pageAt(path);
  if (samePage(target, T.page) || heading(target)) return;
  // YouTube Music needs to be told what the page is; it can't open some by their address.
  const endpoint = MUSIC ? musicEndpoint(path) : undefined;
  if (endpoint === null) return;
  T.goingTo = { ...target, at: performance.now() };
  bridge({ do: 'go', path, endpoint });
}

/** Whether we already asked YouTube for this page. */
function heading(page) {
  return Boolean(T.goingTo) && samePage(page, T.goingTo) && performance.now() - T.goingTo.at < GOING_MS;
}

/** What the sync logic calls to control the player (see web/sync-core.js). */
const player = {
  load(state, position) {
    // A file from someone's computer can only be played by Tandem's program, in VLC.
    if (state.mediaType !== 'youtube') return;
    go(watchPath(state.mediaId, position));
  },
  play() { bridge({ do: 'play' }); },
  pause() { bridge({ do: 'pause' }); },
  seek(seconds) { bridge({ do: 'seek', seconds }); },
  setRate(rate) { bridge({ do: 'rate', rate }); },
};

const STATUS = { 1: 'playing', 2: 'paused', 3: 'buffering', 0: 'idle' }; // not started (-1) and cued (5) count as loading

/**
 * What the player is doing (`p`, a reading from bridge.js), in the form the
 * sync logic expects. `videoId` is the video it should be showing: right
 * after moving to another video page, youtube.com's player still shows the
 * old one for a moment.
 */
function readPlayer(p, videoId = p?.videoId) {
  if (!p?.videoId || p.videoId !== videoId) return { mediaId: null, status: 'idle', position: 0, rate: 1, ended: false };
  // An ad is like buffering: the room waits for us (up to the server's limit) and nothing is commanded.
  if (p.ad) return { mediaId: p.videoId, status: 'buffering', position: T.lastPosition, rate: 1, ended: false };
  T.lastPosition = p.time;
  return { mediaId: p.videoId, status: STATUS[p.state] ?? 'buffering', position: p.time, rate: p.rate, ended: p.state === 0 };
}

// ---------- Following the page ----------

/** Every READ_MS: notice page changes, and tell the sync logic what the player is doing. */
function step() {
  if (!T.controller) return;
  const page = currentPage();
  if (!samePage(page, T.page)) {
    const before = T.page;
    T.page = page;
    if (MUSIC) musicPageChanged(page);
    else pageChanged(before, page);
  }
  sharePage();
  if (MUSIC) return listen();
  if (page.kind !== 'watch') return; // looking around: there's no video of ours to follow
  const p = bridge({ do: 'read' });
  follow(p, readPlayer(p, page.videoId));
}

/** Whether this tab is looking around youtube.com, away from any video (never on YouTube Music, which plays on). */
const browsing = () => !MUSIC && T.page.kind !== 'watch';

/**
 * Whether a reading from bridge.js is of a song about to end by itself.
 * YouTube Music goes on to the next song at once, so its player may never
 * be seen in the ended state (youtube.com's waits on an end screen).
 */
const ending = (p) => MUSIC && p?.state === 1 && !p.ad && p.duration > 0 && p.duration - p.time < ENDING_S;

/** Gives the sync logic the player's reading, and tells the room when the video has ended. */
function follow(p, { ended, ...reading }) {
  if (reading.mediaId && (ended || ending(p))) T.lastEnded = { videoId: reading.mediaId, at: performance.now() };
  T.controller.onSnapshot(reading);
  const state = T.controller.state;
  if (ended && state?.mediaId === reading.mediaId && T.endedSent !== reading.mediaId) {
    // Lets the room's queue move on, if it has one.
    T.endedSent = reading.mediaId;
    T.socket?.emit('media:ended', { mediaId: reading.mediaId });
  }
}

const roomVideo = (state) => (state?.mediaType === 'youtube' ? state.mediaId : null);

function pageChanged(before, after) {
  const ours = heading(after); // we opened it, for the room or the partner
  T.goingTo = null;
  T.lastPosition = 0;
  const c = T.controller;

  if (after.kind !== 'watch') {
    if (before.kind === 'watch') {
      const state = c.state;
      // YouTube stops a video when you leave its page, so it stops for your partner too.
      if (!ours && state && before.videoId === roomVideo(state) && state.isPlaying) {
        const now = serverNow();
        c.request(state, { action: 'pause', position: expectedPosition(state, now) }, { isPlaying: false }, now);
      }
      T.leftVideo = roomVideo(state);
      remember.set('leftVideo', T.leftVideo); // a reload while looking around stays looking around
      c.playerRestarted(); // forget the player until we're on a video again
    }
  } else {
    remember.remove('leftVideo');
    const held = T.held;
    T.held = null;
    c.playerRestarted(); // a new page starts the player over, and it plays by itself
    if (ours || after.videoId === roomVideo(held ?? c.state)) {
      if (held) c.onRemoteState(held);
    } else if (autoplayed(before) && (T.queue.length > 0 || roomVideo(c.state) !== before.videoId)) {
      // The room's queue has the next video, not YouTube's autoplay. The
      // server starts it when the video ends; go to it (or wait for it).
      const next = roomVideo(c.state);
      if (next && next !== before.videoId) go(watchPath(next, expectedPosition(c.state, serverNow())));
    } else {
      // The person here picked this video, or YouTube's autoplay moved on to it: play it for both.
      c.requestLoad('youtube', after.videoId, after.start, autoplayed(before) ? 'autoplay' : 'picked');
    }
  }
  T.toShare = !ours && after.kind !== 'other' ? { page: after, since: performance.now() } : null;
  sharePage();
  draw();
}

/**
 * Whether leaving `before` for another video was YouTube's autoplay: the
 * video there had just ended, and nobody here clicked or pressed a key since
 * shortly before that. (A click on an end-screen video is a pick.)
 */
function autoplayed(before) {
  return before.kind === 'watch' && autoplayedFrom(before.videoId);
}

/** Whether the player moving on from this video was autoplay (see autoplayed). */
function autoplayedFrom(videoId) {
  const now = performance.now();
  return T.lastEnded?.videoId === videoId && now - T.lastEnded.at < 30_000 && now - T.lastInput > AUTOPLAY_QUIET_MS;
}

// ---------- YouTube Music ----------

/** YouTube Music showed another page. The music plays on; your partner's tab follows. */
function musicPageChanged(after) {
  const ours = heading(after); // we opened it, for the room or the partner
  T.goingTo = null;
  // Songs go through the room's state; only the pages around them are passed on.
  T.toShare = !ours && after.kind === 'page' ? { page: after, since: performance.now() } : null;
  sharePage();
  draw();
}

/** Every READ_MS on YouTube Music: the player, whatever page is showing. */
function listen() {
  const p = bridge({ do: 'read' });
  if (p?.videoId && p.videoId !== T.track) {
    const before = T.track;
    T.track = p.videoId;
    trackChanged(before, p);
  }
  // The room's song just ended here and YouTube Music went on to a song of
  // its own, but the room's queue has the next one: give the server a moment
  // to start it, rather than go back to the song that ended.
  const room = roomVideo(T.controller.state);
  const waiting = room && p?.videoId !== room && T.queue.length > 0 && T.lastEnded?.videoId === room
    && performance.now() - T.lastEnded.at < QUEUE_WAIT_MS;
  if (!waiting) follow(p, readPlayer(p));
}

/**
 * YouTube Music's player has another song: the room's, which we put on;
 * one picked here; or one YouTube Music went on to when the last one ended.
 * A pick (or YouTube Music's choice) plays for everyone.
 */
function trackChanged(before, p) {
  const c = T.controller;
  c.playerRestarted(); // a new song starts over, and plays by itself
  T.lastPosition = 0;
  const room = roomVideo(c.state);
  if (p.videoId === room) return;
  const auto = Boolean(before) && autoplayedFrom(before);
  if (auto && room && (T.queue.length > 0 || room !== before)) {
    // The room has its own next song: from its queue (the server starts it
    // once it hears this one ended), or the one someone else's side moved on
    // to first. The sync logic puts it on here.
    if (room === before && T.endedSent !== before) {
      T.endedSent = before;
      T.socket?.emit('media:ended', { mediaId: before });
    }
    return;
  }
  // From where it is: switching a song to its video keeps the place.
  c.requestLoad('youtube', p.videoId, p.time, auto ? 'autoplay' : 'picked');
}

// ---------- Your partner's pages ----------

/**
 * Takes your partner's tab to the page this one just opened. YouTube fills
 * in what the page is (a channel's id) a moment after its address changes,
 * so this waits for that, up to SHARE_WAIT_MS.
 */
function sharePage() {
  if (!T.toShare) return;
  const { page, since } = T.toShare;
  let { path } = page; // YouTube Music's pages are already described as they are sent (currentPage)
  if (!MUSIC) {
    const shown = bridge({ do: 'page' });
    const ready = shown?.url === page.path;
    if (!ready && performance.now() - since < SHARE_WAIT_MS) return; // try again on the next step
    if (ready) path = shareablePath(page.path, shown.channelId);
  }
  T.toShare = null;
  T.socket?.emit('page:send', { path });
}

/** The partner opened another page: go there too. */
function partnerPage({ from, path }) {
  if (!T.room || from === T.room.you) return;
  const target = pageAt(path);
  if (target.kind === 'other') return; // not a page we follow
  if (target.kind === 'watch') {
    if (MUSIC) return; // songs come with the room's state
    // Videos come with the room's state. This only matters when the partner
    // goes back to the room's video while we're looking around.
    const state = T.held ?? T.controller?.state;
    if (target.videoId !== roomVideo(state)) return;
    return go(watchPath(target.videoId, expectedPosition(state, serverNow())));
  }
  // Someone on YouTube Music looks around while the room plays on. Leaving
  // the room's video here would stop it (youtube.com does), so stay. (On
  // youtube.com the room is paused by the time a page comes: leaving a
  // video pauses it.)
  const state = T.controller?.state;
  if (!MUSIC && T.page.kind === 'watch' && T.page.videoId === roomVideo(state) && state.isPlaying) return;
  go(target.path);
}

/** The room's state, from the server. */
function deliver(state) {
  remember.set('known', { state, queue: T.queue, options: T.options });
  // While looking around, only a new video takes us back to a video page.
  if (browsing() && !(roomVideo(state) && roomVideo(state) !== T.leftVideo)) {
    T.held = state;
    // The room may wait for us (after a reconnect). We're not loading anything, so we're ready.
    if (state.waitingFor.includes(T.room.you) && T.readyFor !== state.version) {
      T.readyFor = state.version;
      T.socket?.emit('buffer:end');
    }
    return draw();
  }
  T.held = null;
  T.controller.onRemoteState(state);
  announce(state);
  draw();
  drawChat();
}

/** Who chose the room's video, in words: "Ben picked it", "YouTube autoplayed it for you", … */
function chosenBy(state) {
  if (!state?.mediaId || !state.loadedBy || !T.room) return '';
  const you = state.loadedBy === T.room.you;
  const name = you ? 'you' : T.room.members.find((m) => m.id === state.loadedBy)?.name ?? 'someone who left';
  const Name = name[0].toUpperCase() + name.slice(1);
  if (state.loadedHow === 'autoplay') return `YouTube autoplayed it ${you ? 'on your side' : `on ${name}'s side`}`;
  if (state.loadedHow === 'queue') return `Next in the queue, added by ${name}`;
  return `${Name} picked it`;
}

/** Says once, in the badge, who chose a new video (unless it was you, picking it). */
function announce(state) {
  if (!state.mediaId || state.mediaId === T.announced) return;
  T.announced = state.mediaId;
  if (state.loadedBy && (state.loadedBy !== T.room.you || state.loadedHow !== 'picked')) notify(chosenBy(state), 6000);
}

/** Starting a room while on a video: that video plays for both, from where you are. */
function shareThisVideo() {
  const p = bridge({ do: 'read' });
  // YouTube Music: whatever song its player has, on any page.
  if (MUSIC) return void (p?.videoId && T.controller.requestLoad('youtube', p.videoId, p.time));
  if (T.page.kind !== 'watch') return;
  const position = p?.videoId === T.page.videoId ? p.time : T.page.start;
  T.controller.requestLoad('youtube', T.page.videoId, position);
}

// ---------- Connection ----------

/** One question to the server, with its answer (or an error after 5 seconds). */
function ask(event, payload) {
  return new Promise((resolve, reject) => {
    T.socket.timeout(5000).emit(event, payload, (error, answer) => (error ? reject(error) : resolve(answer)));
  });
}

async function syncClock() {
  const samples = [];
  for (let i = 0; i < SYNC_CONFIG.clockSamples; i++) {
    const t0 = performance.now();
    try {
      const { serverTime } = await ask('time:ping', { t0 });
      samples.push({ t0, t1: performance.now(), serverTime });
    } catch { /* a lost ping just means one sample fewer */ }
  }
  if (samples.length) T.clockOffset = bestOffset(samples);
}

async function connect() {
  if (T.socket) return;
  T.connection = 'connecting';
  draw();
  const socket = io(T.settings.server, { transports: ['websocket', 'polling'] });
  T.socket = socket;

  let first = true;
  const ready = new Promise((resolve, reject) => {
    socket.on('connect', async () => {
      await syncClock();
      T.connection = 'online';
      // After a dropped connection, take our seat in the room again.
      if (!first && T.room) await enterRoom('room:join', { code: T.room.code }, true);
      first = false;
      clearTimeout(slow);
      clearTimeout(giveUp);
      setMessage('');
      resolve();
    });
    // A free host puts the server to sleep when nobody uses it; the first
    // connection wakes it, which takes a while. Socket.IO keeps retrying.
    const slow = setTimeout(() => setMessage('Waking up the sync server. This can take up to a minute…'), 4000);
    const giveUp = setTimeout(() => reject(new Error('unreachable')), 90_000);
  });
  socket.on('disconnect', () => {
    T.connection = 'reconnecting';
    draw();
  });
  socket.on('state:changed', ({ state }) => deliver(state));
  socket.on('queue:changed', ({ queue }) => {
    T.queue = queue;
    remember.set('known', { ...remember.get('known'), queue });
    drawChat();
  });
  socket.on('options:changed', ({ options }) => {
    T.options = options;
    remember.set('known', { ...remember.get('known'), options });
  });
  socket.on('typing', someoneTyping);
  socket.on('stats', ({ from, ...stats }) => {
    T.stats.set(from, { ...T.stats.get(from), ...stats, at: performance.now() });
    drawChat();
  });
  socket.on('member:joined', ({ members }) => membersChanged(members, 'joined'));
  socket.on('member:left', ({ members }) => membersChanged(members, 'left'));
  socket.on('member:changed', ({ members }) => membersChanged(members, 'changed'));
  socket.on('page', partnerPage);
  socket.on('chat:message', chatMessage);
  socket.on('reaction', showReaction);

  T.timers.push(setInterval(() => { if (socket.connected) syncClock(); }, SYNC_CONFIG.clockResyncMs));
  await ready; // connected, and the clock is set
}

function disconnect() {
  T.timers.splice(0).forEach(clearInterval);
  T.socket?.disconnect();
  T.socket = null;
  T.connection = 'offline';
}

// ---------- Rooms ----------

async function enterRoom(event, payload, rejoining = false) {
  if (!T.socket) T.settings = await loadSettings();
  let answer;
  try {
    await connect();
    // Coming back to a room: bring what we know, in case the server lost it.
    const known = remember.get('known') ?? {};
    const restore = rejoining ? {
      restore: restoreInfo(
        T.controller?.state ?? known.state, T.queue.length ? T.queue : known.queue, serverNow(), known.options ?? T.options,
      ),
    } : {};
    answer = await ask(event, { ...payload, ...restore, clientId: T.settings.clientId, name: T.settings.name });
  } catch (error) {
    console.warn('Tandem: no answer from the sync server:', error);
    if (!T.room) disconnect();
    return setMessage(`Couldn't reach the sync server at ${T.settings.server}. Check the address in Tandem's settings.`);
  }
  if (!answer.ok) {
    if (!rejoining) {
      if (!T.room) disconnect();
      return setMessage(answer.error);
    }
    // The room we were in no longer exists.
    leaveRoom();
    return setMessage('The room has closed.');
  }

  const fresh = !T.room;
  T.room = { code: answer.room.code, members: answer.room.members, you: answer.room.you };
  remember.set('room', T.room.code);
  if (fresh) startController();
  if (!rejoining) {
    T.chat = [];
    remember.remove('chat');
  }
  // The server forgets this when it restarts, so say it again on every (re)join.
  T.socket.emit('member:away', { away: T.away });
  T.queue = answer.room.queue ?? [];
  T.options = answer.room.options ?? T.options;
  T.page = currentPage();
  if (MUSIC) T.track = bridge({ do: 'read' })?.videoId || null; // what's on now is no change of song
  // After a reconnect the server may have restarted its numbering: start over.
  if (rejoining) {
    T.controller.state = null;
    T.held = null;
  }
  T.announced = answer.room.state.mediaId; // what's on when you arrive is no news
  deliver(answer.room.state);
  if (fresh && !rejoining && !answer.room.state.mediaId) shareThisVideo();
  setMessage('');
}

function leaveRoom() {
  if (T.controller?.nudging) T.controller.endNudge(); // back to normal speed
  T.socket?.emit('room:leave');
  disconnect();
  remember.remove('room');
  remember.remove('known');
  remember.remove('leftVideo');
  remember.remove('away');
  remember.remove('chat');
  remember.remove('chatOpen');
  Object.assign(T, {
    room: null, controller: null, held: null, queue: [], leftVideo: undefined, endedSent: null, announced: null,
    away: false, chat: [], unread: 0, chatOpen: false, options: { pauseOnAway: true }, typing: new Map(), stats: new Map(),
  });
  draw();
}

function membersChanged(members, what) {
  if (!T.room) return;
  const before = new Map(T.room.members.map((m) => [m.id, m]));
  T.room.members = members;
  for (const member of members) {
    if (member.id === T.room.you) continue;
    const was = before.get(member.id);
    if (what === 'joined' && member.online && !was?.online) notify(`${member.name} joined`);
    if (what === 'left' && !member.online && was?.online) notify(`${member.name} went offline`);
    if (what === 'changed' && member.online && was && Boolean(was.away) !== Boolean(member.away)) {
      notify(member.away ? `${member.name} is away` : `${member.name} is back`);
    }
  }
  if (what === 'left' && members.length < before.size) notify('Your partner left the room');
  draw();
  drawChat();
}

// ---------- Away, chat and reactions ----------

/** You're away from the screen (AFK), or back. The room pauses if its options say so. */
function setAway(away) {
  T.away = away;
  remember.set('away', away);
  T.socket?.emit('member:away', { away });
  draw();
  drawChat();
}

function sendChat(text) {
  if (!text || !T.socket?.connected) return false;
  T.socket.emit('chat:send', { text });
  return true; // it comes back to us from the server, like everyone else's
}

function chatMessage(message) {
  if (!T.room) return;
  T.chat.push(message);
  T.chat.splice(0, T.chat.length - CHAT_KEEP);
  remember.set('chat', T.chat);
  T.typing.delete(message.from);
  if (message.from !== T.room.you && (!T.chatOpen || document.hidden)) {
    T.unread += 1; // shown on 💬 and in the tab's title
    if (!T.chatOpen) notify(`${message.name}: ${message.text}`, 6000);
    chime();
  }
  drawChat();
}

/** You're typing in a chat box: tell the others, now and then. */
function typing() {
  const now = performance.now();
  if (!T.socket?.connected || now - T.lastTypingSent < TYPING_SEND_MS) return;
  T.lastTypingSent = now;
  T.socket.emit('chat:typing');
}

function someoneTyping({ from }) {
  if (!T.room || from === T.room.you) return;
  T.typing.set(from, performance.now());
  drawChat();
  setTimeout(drawChat, TYPING_SHOW_MS + 100); // to take it away again
}

/** "Ben is typing…", or ''. */
function typingLine() {
  if (!T.room) return '';
  const now = performance.now();
  const names = [...T.typing]
    .filter(([, at]) => now - at < TYPING_SHOW_MS)
    .map(([id]) => T.room.members.find((m) => m.id === id)?.name)
    .filter(Boolean);
  if (!names.length) return '';
  return `${names.join(' and ')} ${names.length > 1 ? 'are' : 'is'} typing…`;
}

let audio = null;

/** A short, quiet two-note sound for a new message. */
function chime() {
  if (!T.chatSound) return;
  try {
    audio ??= new AudioContext();
    if (audio.state === 'suspended') audio.resume();
    const start = audio.currentTime;
    [660, 880].forEach((frequency, i) => {
      const tone = audio.createOscillator();
      const volume = audio.createGain();
      const at = start + i * 0.09;
      tone.frequency.value = frequency;
      volume.gain.setValueAtTime(0.0001, at);
      volume.gain.exponentialRampToValueAtTime(0.05, at + 0.02);
      volume.gain.exponentialRampToValueAtTime(0.0001, at + 0.25);
      tone.connect(volume).connect(audio.destination);
      tone.start(at);
      tone.stop(at + 0.3);
    });
  } catch { /* no sound, then */ }
}

/** Unread messages at the front of the tab's title: "💬2 · …". YouTube sets the title itself, so this keeps putting it back. */
const TITLE_MARK = /^💬\d+ · /;
function markTitle() {
  const plain = document.title.replace(TITLE_MARK, '');
  const wanted = T.room && T.unread ? `💬${T.unread} · ${plain}` : plain;
  if (document.title !== wanted) document.title = wanted;
}

// ---------- Connection quality ----------

/** Every STATS_MS: measure the round trip to the server and tell the others it, and our drift. */
async function sendStats() {
  if (!T.room || !T.socket?.connected) return;
  const t0 = performance.now();
  try {
    await ask('time:ping', { t0 });
  } catch {
    return;
  }
  const rtt = Math.round(performance.now() - t0);
  const state = T.controller?.state;
  const drift = !browsing() && state && isRolling(state, serverNow()) ? T.controller.drift() : null;
  T.socket.emit('stats:send', { rtt, drift });
  T.stats.set(T.room.you, { rtt, drift, at: performance.now() });
  drawChat();
}

/** "90 ms · in sync", "650 ms (slow) · 0.4 s behind", or '' with no recent report. */
function qualityOf(id) {
  const s = T.stats.get(id);
  if (!s || performance.now() - s.at > STATS_STALE_MS) return '';
  const parts = [];
  if (typeof s.rtt === 'number') parts.push(`${s.rtt} ms${s.rtt > SLOW_RTT_MS ? ' (slow)' : ''}`);
  if (typeof s.drift === 'number') {
    parts.push(Math.abs(s.drift) < IN_SYNC ? 'in sync' : `${Math.abs(s.drift).toFixed(1)} s ${s.drift > 0 ? 'ahead' : 'behind'}`);
  }
  return parts.join(' · ');
}

// ---------- The queue ----------

/** A video's title, looked up the first time it's asked for (null until then). */
function titleOf(videoId) {
  if (T.titles.has(videoId)) return T.titles.get(videoId);
  T.titles.set(videoId, null);
  const link = encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`);
  fetch(`https://www.youtube.com/oembed?url=${link}&format=json`)
    .then((response) => (response.ok ? response.json() : null))
    .then((info) => { if (typeof info?.title === 'string') T.titles.set(videoId, info.title); })
    .catch(() => { /* shown without a title */ });
  return null;
}

/** "Add to Tandem queue" from the right-click menu on a video link. */
function queueAdd(link) {
  const videoId = videoIdOf(link);
  if (!videoId) return toast("That isn't a link to a YouTube video.");
  if (!T.room || !T.socket?.connected) return toast('Join a Tandem room first (click the Tandem icon).');
  T.socket.emit('queue:add', { mediaIds: [videoId] });
  titleOf(videoId);
  notify(T.controller?.state?.mediaId ? 'Added to the queue' : 'Playing it for everyone');
}

/** A short message in the corner when there's no badge (you're not in a room). */
function toast(text) {
  if (T.room) return notify(text);
  const host = document.createElement('tandem-toast');
  host.attachShadow({ mode: 'open' }).innerHTML = `<style>
    :host { all: initial; position: fixed; right: 16px; bottom: ${BOTTOM}px; z-index: 2000; }
    p { margin: 0; padding: 9px 14px; background: rgba(14, 14, 18, .94); color: #f5f5f6; border-radius: 999px;
      font: 500 13px/1.35 Roboto, Arial, sans-serif; box-shadow: 0 6px 20px rgba(0, 0, 0, .35); }
  </style><p></p>`;
  host.shadowRoot.querySelector('p').textContent = `Tandem: ${text}`;
  document.body.append(host);
  setTimeout(() => host.remove(), 4000);
}

function setChatOpen(open) {
  T.chatOpen = open;
  remember.set('chatOpen', open);
  if (open) T.unread = 0;
  drawChat();
  if (open) badge?.shadowRoot.querySelector('.say input').focus();
}

function startController() {
  T.controller = new SyncController({
    player,
    clientId: T.room.you,
    // Drift is corrected by playing slightly faster or slower, as for VLC:
    // youtube.com's player takes any speed, unlike the embedded one.
    // YouTube Music's doesn't (only 0.25, 0.5, … 2), so there it's by seeking.
    mode: MUSIC ? 'youtube' : 'local',
    now: serverNow,
    send: (event, payload) => T.socket?.emit(event, payload),
  });
  T.timers.push(setInterval(step, READ_MS));
  T.timers.push(setInterval(() => { if (!browsing()) T.controller?.tick(); }, SYNC_CONFIG.tickMs));
  T.timers.push(setInterval(draw, 500));
  T.timers.push(setInterval(sendStats, STATS_MS));
}

// ---------- What you see ----------

function setMessage(text) {
  T.message = text;
  draw();
}

function notify(text, ms = 4000) {
  T.notice = { text, until: performance.now() + ms };
  draw();
}

const clock = (seconds) => {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60;
  return `${h ? `${h}:${String(m).padStart(2, '0')}` : m}:${String(s % 60).padStart(2, '0')}`;
};

/** 'here', 'away' or 'offline'. */
const presence = (member) => (!member.online ? 'offline' : member.away ? 'away' : 'here');

function partnerLine() {
  const others = T.room.members.filter((m) => m.id !== T.room.you);
  if (!others.length) return 'Waiting for your partner';
  return others.map((m) => `${m.name} is ${presence(m)}`).join(', ');
}

/** 'here' if someone else is online and not away, 'away' if all who are online are away, else 'offline'. */
function partnersPresence() {
  const online = T.room.members.filter((m) => m.id !== T.room.you && m.online);
  if (T.connection !== 'online' || !online.length) return 'offline';
  return online.some((m) => !m.away) ? 'here' : 'away';
}

function statusLine() {
  if (!T.room) return '';
  if (T.connection !== 'online') return T.connection === 'reconnecting' ? 'Reconnecting…' : 'Connecting…';
  const state = T.held ?? T.controller?.state;
  if (!state?.mediaId) return MUSIC ? 'Play a song and it plays for both of you' : 'Open a video and it plays for both of you';
  if (state.mediaType !== 'youtube') return 'Your partner is playing a file from their computer; open Tandem to watch it';
  if (browsing()) return 'Looking around. Pick a video and it plays for both of you';
  const now = serverNow();
  const nameOf = (id) => (id === T.room.you ? 'you' : T.room.members.find((m) => m.id === id)?.name ?? 'your partner');
  if (state.waitingFor.length) return `Waiting for ${state.waitingFor.map(nameOf).join(' and ')} to load…`;
  if (state.isPlaying && state.updatedAt > now + 300) return `Starting in ${Math.ceil((state.updatedAt - now) / 1000)}`;
  if (!state.isPlaying && state.pausedFor) return `Paused at ${clock(state.position)} · ${pausedReason(state).text}`;
  if (!isRolling(state, now)) return `Paused at ${clock(state.position)}`;
  const drift = T.controller?.drift();
  if (drift == null || Math.abs(drift) < IN_SYNC) return 'Playing · in sync';
  return `Playing · ${Math.abs(drift).toFixed(1)} s ${drift > 0 ? 'ahead' : 'behind'}, catching up`;
}

/**
 * Why the room was paused for someone, and whether to offer "Resume": once
 * they're back (or gone for good), not while they're still away.
 */
function pausedReason(state) {
  const id = state.pausedFor;
  if (id === T.room.you) return T.away ? { text: "you're away", resume: false } : { text: 'you were away', resume: true };
  const m = T.room.members.find((member) => member.id === id);
  if (!m) return { text: 'your partner left', resume: true };
  if (!m.online) return { text: `${m.name} went offline`, resume: false };
  if (m.away) return { text: `${m.name} stepped away`, resume: false };
  return { text: `${m.name} is back`, resume: true };
}

/** Whether to offer "Resume" now. */
function resumable() {
  const state = T.held ?? T.controller?.state;
  return Boolean(T.room && state?.mediaId && !state.isPlaying && state.pausedFor && pausedReason(state).resume);
}

function resume() {
  T.socket?.emit('state:request', { action: 'play' }); // from where it was paused
}

/** What the popup shows. */
function status() {
  return {
    connection: T.connection,
    message: T.message,
    server: T.settings?.server ?? null,
    room: T.room && {
      code: T.room.code,
      people: T.room.members.map((m) => ({ name: m.name, online: m.online, away: Boolean(m.away), you: m.id === T.room.you })),
    },
    partner: T.room ? partnerLine() : '',
    partners: T.room ? partnersPresence() : 'offline',
    chosen: chosenBy(T.held ?? T.controller?.state),
    away: T.away,
    invite: T.room ? inviteLink(T.room.code, roomVideo(T.held ?? T.controller?.state), location.origin) : null,
    thing: THING,
    options: T.options,
    resumable: resumable(),
    typing: typingLine(),
    // Everyone else's connection and sync, and yours.
    quality: T.room ? T.room.members.map((m) => {
      const q = qualityOf(m.id);
      return q && `${m.id === T.room.you ? 'You' : m.name}: ${q}`;
    }).filter(Boolean) : [],
    queue: T.room ? T.queue.map((item) => ({
      id: item.id,
      mediaId: item.mediaId,
      title: titleOf(item.mediaId),
      by: item.addedBy === T.room.you ? 'you' : T.room.members.find((m) => m.id === item.addedBy)?.name ?? 'someone',
    })) : [],
    // The latest messages, for the popup's small chat.
    chat: T.room ? T.chat.slice(-POPUP_CHAT).map((m) => ({ name: m.name, text: m.text, at: m.at, mine: m.from === T.room.you })) : [],
    line: statusLine(),
  };
}

// The badge in the corner of the page: room code, partner, and what's happening,
// with a chat panel above it (opened with its 💬 button) and reactions that rise
// from it. The corner is beside the player on a video page, not over it.
// It sits in its own shadow root so YouTube's styles don't reach it.
let badge = null;

/** How high the badge sits: on YouTube Music, above its player bar (72 px) along the bottom. */
const BOTTOM = MUSIC ? 88 : 16;

const BADGE_STYLE = `
  :host { all: initial; position: fixed; right: 16px; bottom: ${BOTTOM}px; z-index: 2000;
    color: #f5f5f6; font: 500 13px/1.35 Roboto, Arial, sans-serif; }
  .wrap { position: relative; display: flex; flex-direction: column; align-items: flex-end; gap: 8px; }
  .pill { display: flex; align-items: center; gap: 8px; max-width: 460px; padding: 5px 5px 5px 14px;
    background: rgba(14, 14, 18, .94); border: 1px solid rgba(255, 255, 255, .1);
    border-radius: 999px; box-shadow: 0 6px 20px rgba(0, 0, 0, .35); cursor: pointer; user-select: none; }
  .dot { flex: none; width: 8px; height: 8px; border-radius: 50%; background: #a7a7b0; }
  .dot.here { background: #3ddc84; }
  .dot.away { background: #f5c542; }
  .code { font-weight: 700; letter-spacing: .08em; color: #ffb347; }
  .text { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; color: #d6d6dc; }
  .compact .text { display: none; }
  button { font: inherit; color: inherit; cursor: pointer; }
  .chat-btn { flex: none; display: flex; align-items: center; gap: 4px; padding: 4px 10px;
    background: rgba(255, 255, 255, .08); border: 0; border-radius: 999px; }
  .chat-btn:hover { background: rgba(255, 255, 255, .16); }
  .resume-btn { flex: none; padding: 4px 12px; background: #3ddc84; color: #08140d; border: 0; border-radius: 999px;
    font-weight: 700; }
  .resume-btn[hidden] { display: none; }
  .person small { color: #a7a7b0; }
  .typing { padding: 0 12px 6px; color: #a7a7b0; font-size: 12px; font-style: italic; }
  .typing:empty { display: none; }
  .count { min-width: 16px; padding: 0 5px; background: #ff5a36; color: #fff; border-radius: 999px;
    font-size: 11px; font-weight: 700; text-align: center; }
  .count:empty { display: none; }

  .panel { display: flex; flex-direction: column; width: 320px; max-height: min(460px, calc(100vh - ${BOTTOM + 84}px));
    background: rgba(14, 14, 18, .97); border: 1px solid rgba(255, 255, 255, .1); border-radius: 14px;
    box-shadow: 0 10px 30px rgba(0, 0, 0, .45); overflow: hidden; }
  .panel[hidden] { display: none; }
  .people { display: flex; flex-direction: column; gap: 4px; padding: 10px 12px;
    border-bottom: 1px solid rgba(255, 255, 255, .08); color: #d6d6dc; }
  .person { display: flex; align-items: center; gap: 6px; }
  .chosen { padding: 6px 12px; border-bottom: 1px solid rgba(255, 255, 255, .08); color: #a7a7b0; font-size: 12px; }
  .chosen:empty { display: none; }
  .log { flex: 1; min-height: 120px; overflow-y: auto; padding: 8px 12px; }
  .msg { margin: 0 0 6px; overflow-wrap: anywhere; user-select: text; }
  .msg b { margin-right: 6px; color: #ffb347; }
  .msg.mine b { color: #a7a7b0; }
  .empty { margin: 0; color: #a7a7b0; }
  .reacts { display: flex; justify-content: space-between; padding: 4px 8px;
    border-top: 1px solid rgba(255, 255, 255, .08); }
  .reacts button { padding: 3px 6px; background: none; border: 0; border-radius: 8px; font-size: 19px; }
  .reacts button:hover { background: rgba(255, 255, 255, .1); }
  .say { display: flex; gap: 6px; padding: 8px 10px; border-top: 1px solid rgba(255, 255, 255, .08); }
  .say input { flex: 1; min-width: 0; padding: 7px 9px; background: #17171c; color: #f5f5f6;
    border: 1px solid rgba(255, 255, 255, .1); border-radius: 8px; font: inherit; }
  .say input:focus { outline: 2px solid #ffb347; outline-offset: -1px; }
  .say button, .away-btn { padding: 6px 12px; background: #212128; border: 1px solid rgba(255, 255, 255, .1);
    border-radius: 8px; font-weight: 600; }
  .say button:hover, .away-btn:hover { background: #2c2c35; }
  .away-btn { margin: 0 10px 10px; }
  .away-btn.on { background: #f5c542; color: #160a05; border-color: transparent; }

  .floats { position: absolute; right: 10px; bottom: 100%; width: 70px; height: 0; pointer-events: none; }
  .float { position: absolute; bottom: 0; display: flex; flex-direction: column; align-items: center;
    animation: rise 2.6s ease-out forwards; }
  .float b { font-size: 30px; line-height: 1.1; }
  .float small { padding: 0 5px; background: rgba(14, 14, 18, .85); border-radius: 6px; font-size: 11px; }
  @keyframes rise {
    0% { transform: translateY(0) scale(.6); opacity: 0; }
    12% { transform: translateY(-12px) scale(1); opacity: 1; }
    70% { opacity: 1; }
    100% { transform: translateY(-140px); opacity: 0; }
  }
`;

/** An element with a class and plain text (never HTML: chat text comes from other people). */
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function makeBadge() {
  badge = document.createElement('tandem-badge');
  const shadow = badge.attachShadow({ mode: 'open' });
  shadow.innerHTML = `<style>${BADGE_STYLE}</style>
    <div class="wrap">
      <div class="floats"></div>
      <div class="panel" hidden>
        <div class="people"></div>
        <div class="chosen"></div>
        <div class="log"></div>
        <div class="typing"></div>
        <div class="reacts">${REACTIONS.map((emoji) => `<button type="button" title="Send ${emoji} to everyone">${emoji}</button>`).join('')}</div>
        <form class="say"><input maxlength="500" placeholder="Say something" autocomplete="off"><button type="submit">Send</button></form>
        <button type="button" class="away-btn"></button>
      </div>
      <div class="pill" title="Tandem. Click to fold or unfold.">
        <i class="dot"></i><b class="code"></b><span class="text"></span>
        <button type="button" class="resume-btn" title="Play again, for everyone" hidden>▶ Resume</button>
        <button type="button" class="chat-btn" title="Chat and reactions">💬<span class="count"></span></button>
      </div>
    </div>`;
  const $ = (selector) => shadow.querySelector(selector);

  $('.pill').addEventListener('click', () => {
    T.compact = !T.compact;
    remember.set('compact', T.compact);
    draw();
  });
  $('.chat-btn').addEventListener('click', (event) => {
    event.stopPropagation(); // not a fold
    setChatOpen(!T.chatOpen);
  });
  $('.resume-btn').addEventListener('click', (event) => {
    event.stopPropagation(); // not a fold
    resume();
  });
  $('.reacts').addEventListener('click', (event) => {
    const emoji = event.target.closest('button')?.textContent;
    if (emoji) T.socket?.emit('reaction:send', { emoji });
  });
  const input = $('.say input');
  $('.say').addEventListener('submit', (event) => {
    event.preventDefault();
    if (sendChat(input.value.trim())) input.value = '';
  });
  // Typing here is for the chat, not YouTube's shortcuts (k pauses, f goes full screen, …).
  input.addEventListener('input', typing);
  for (const type of ['keydown', 'keypress', 'keyup']) {
    input.addEventListener(type, (event) => {
      event.stopPropagation();
      if (type === 'keydown' && event.key === 'Escape') setChatOpen(false);
    });
  }
  $('.away-btn').addEventListener('click', () => setAway(!T.away));
  document.body.append(badge);
  drawChat();
}

function draw() {
  markTitle();
  if (!T.room) {
    badge?.remove();
    badge = null;
    return;
  }
  if (!badge) makeBadge();
  const shadow = badge.shadowRoot;
  const notice = T.notice && performance.now() < T.notice.until ? T.notice.text : null;
  shadow.querySelector('.pill').classList.toggle('compact', T.compact);
  shadow.querySelector('.dot').className = `dot ${partnersPresence()}`;
  shadow.querySelector('.code').textContent = T.room.code;
  const text = notice ?? `${T.away ? "You're away · " : ''}${partnerLine()} · ${statusLine()}`;
  const box = shadow.querySelector('.text');
  if (box.textContent !== text) box.textContent = text;
  shadow.querySelector('.resume-btn').hidden = !resumable();
}

/** The chat panel: who's here, the messages, and your away button. */
function drawChat() {
  if (!badge || !T.room) return;
  const shadow = badge.shadowRoot;
  const $ = (selector) => shadow.querySelector(selector);
  $('.count').textContent = T.unread ? String(T.unread) : '';
  markTitle();
  $('.panel').hidden = !T.chatOpen;
  if (!T.chatOpen) return;

  $('.people').replaceChildren(...T.room.members.map((m) => {
    const person = el('span', 'person');
    const you = m.id === T.room.you;
    const quality = m.online ? qualityOf(m.id) : '';
    person.append(el('i', `dot ${presence(m)}`), `${m.name}${you ? ' (you)' : ''} · ${presence(m)}`);
    if (quality) person.append(el('small', '', `· ${quality}`));
    return person;
  }));
  $('.typing').textContent = typingLine();
  const upNext = T.queue.length ? ` · ${T.queue.length} up next` : '';

  const chosen = chosenBy(T.held ?? T.controller?.state);
  $('.chosen').textContent = chosen ? `This ${THING}: ${chosen}${upNext}` : upNext.slice(3);

  const log = $('.log');
  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  log.replaceChildren(...(T.chat.length ? T.chat.map((m) => {
    const line = el('p', m.from === T.room.you ? 'msg mine' : 'msg');
    line.title = new Date(m.at).toLocaleTimeString();
    line.append(el('b', '', m.from === T.room.you ? 'You' : m.name), m.text);
    return line;
  }) : [el('p', 'empty', 'Messages and reactions go to everyone in the room.')]));
  if (atBottom) log.scrollTop = log.scrollHeight;

  const away = $('.away-btn');
  away.textContent = T.away ? "I'm back" : "I'm away";
  away.title = T.away ? 'Let the others know you are watching again' : 'Let the others know you have stepped away';
  away.classList.toggle('on', T.away);
}

/** A reaction rises from the badge for a couple of seconds. */
function showReaction({ from, emoji }) {
  if (!badge || !T.room || typeof emoji !== 'string') return;
  const floats = badge.shadowRoot.querySelector('.floats');
  if (floats.children.length >= 12) floats.firstChild.remove(); // someone is pressing a lot
  const float = el('div', 'float');
  float.append(el('b', '', emoji));
  const name = from === T.room.you ? null : T.room.members.find((m) => m.id === from)?.name;
  if (name) float.append(el('small', '', name));
  float.style.right = `${Math.round(Math.random() * 30)}px`;
  floats.append(float);
  setTimeout(() => float.remove(), 2700);
}

// ---------- The popup ----------

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  handle(message).then(reply, (error) => reply({ ...status(), message: String(error?.message ?? error) }));
  return true; // the answer comes later
});

async function handle(message) {
  switch (message?.do) {
    case 'create':
      if (T.room) leaveRoom();
      await enterRoom('room:create', {});
      break;
    case 'join':
      if (T.room) leaveRoom();
      await enterRoom('room:join', { code: String(message.code ?? '') });
      break;
    case 'leave':
      leaveRoom();
      break;
    case 'away':
      if (T.room) setAway(message.away === true);
      break;
    case 'queue-add':
      queueAdd(message.link);
      break;
    case 'queue-play':
      T.socket?.emit('queue:play', { id: String(message.id ?? '') });
      break;
    case 'queue-remove':
      T.socket?.emit('queue:remove', { id: String(message.id ?? '') });
      break;
    case 'queue-clear':
      T.socket?.emit('queue:clear');
      break;
    case 'options':
      if (typeof message.pauseOnAway === 'boolean') T.socket?.emit('options:set', { pauseOnAway: message.pauseOnAway });
      break;
    case 'typing':
      typing();
      break;
    case 'resume':
      resume();
      break;
    case 'status':
      // The popup is showing the chat: what's in it has been read.
      if (message.seen && T.unread) {
        T.unread = 0;
        drawChat();
      }
      break;
    case 'chat':
      if (!T.room || !sendChat(String(message.text ?? '').trim().slice(0, 500))) {
        return { ...status(), message: "Not connected: the message wasn't sent." };
      }
      break;
    case 'inspect': {
      // For debugging: what the sync logic sees (like Together.inspect() on Tandem's page).
      const c = T.controller;
      return c && {
        serverNow: serverNow(), state: c.state, snapshot: c.snapshot, drift: c.drift(), told: c.told,
        guardFor: c.guardUntil - serverNow(), nudging: c.nudging, page: T.page, track: T.track, held: T.held,
        leftVideo: T.leftVideo, clockOffset: T.clockOffset, hidden: document.hidden,
      };
    }
    default:
      break;
  }
  return status();
}

// ---------- Start ----------

T.compact = remember.get('compact') === true;
// The person's own clicks and key presses, to tell their picks from YouTube's autoplay.
for (const type of ['pointerdown', 'keydown']) {
  window.addEventListener(type, (event) => { if (event.isTrusted) T.lastInput = performance.now(); }, true);
}
T.away = remember.get('away') === true;
T.chat = remember.get('chat') ?? [];
T.chatOpen = remember.get('chatOpen') === true;
document.addEventListener('yt-navigate-finish', step); // notice a new page at once, not up to READ_MS later
// Back to this tab with the chat open: its messages have been seen.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && T.chatOpen && T.unread) {
    T.unread = 0;
    drawChat();
  }
});
chrome.storage.local.get('chatSound').then(({ chatSound }) => { T.chatSound = chatSound !== false; });
chrome.storage.onChanged.addListener((changes) => {
  if (changes.chatSound) T.chatSound = changes.chatSound.newValue !== false;
});

// An invite link (bridge.js kept its #tandem=CODE) joins that room; otherwise
// a reload keeps this tab in its room.
const invited = inviteCode(document.documentElement.getAttribute('data-tandem-invite'));
document.documentElement.removeAttribute('data-tandem-invite');
const savedRoom = remember.get('room');
if (invited && invited !== savedRoom) {
  enterRoom('room:join', { code: invited }).then(() => {
    if (T.room && T.settings?.name === 'Guest') notify("You're in as Guest. Set your name in Tandem's popup.", 8000);
  });
} else if (savedRoom) {
  if (browsing()) T.leftVideo = remember.get('leftVideo') ?? undefined;
  enterRoom('room:join', { code: savedRoom }, true);
}
