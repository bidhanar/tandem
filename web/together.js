// The Watch Together page: create or join a room, and watch YouTube in sync.
//
// app.js owns the rest of the page and calls Together.onRoute() whenever the
// address changes. Everything here lives in the #together element, which sits
// outside the part app.js redraws, so the player survives moving around the
// library. While a video is loaded and you browse elsewhere, the player stays
// docked in the corner (YouTube requires its player to remain visible).

import { SYNC_CONFIG } from './sync-config.js';
import { bestOffset, expectedPosition, isRolling, restoreInfo, SyncController } from './sync-core.js';
import { parseYouTubeLinks } from './youtube-url.js';

const root = document.getElementById('together');
const $ = (selector) => root.querySelector(selector);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const notify = (message, kind) => window.toast?.(message, kind);

/** Reactions offered beside the chat. */
const REACTIONS = ['👍', '😂', '😮', '😢', '❤️', '🔥'];
const CHAT_KEEP = 100;
/** Your connection and sync go to the others this often. */
const STATS_MS = 5000;
const STATS_STALE_MS = 16_000;
const SLOW_RTT_MS = 400;
const TYPING_SEND_MS = 2000;
const TYPING_SHOW_MS = 3500;
/** Drift shown as "in sync" next to someone's name. */
const IN_SYNC = 0.25;

const remember = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch { /* private mode */ } },
  remove(key) { try { localStorage.removeItem(key); } catch { /* private mode */ } },
};

/** This browser's permanent id in rooms, so a reconnect is recognised as the same person. */
function clientId() {
  let id = remember.get('tandem.client');
  if (!id) {
    id = crypto.randomUUID();
    remember.set('tandem.client', id);
  }
  return id;
}

const T = {
  onPage: false, // the Watch Together page is the one showing
  name: 'Guest',
  profileId: null,
  local: null, // what the local program says about the room's local file (from /api/status)
  queue: [], // YouTube videos lined up to play next: [{ id, mediaId, addedBy }]
  titles: new Map(), // YouTube video id -> { title, author }, as far as we know them
  onRoomVideo: null, // the room's video id, once our player has been seen showing it
  endedSent: null, // the video whose ending we have reported
  serverUrl: '',
  socket: null,
  connection: 'offline', // 'offline' | 'connecting' | 'online' | 'reconnecting'
  clockOffset: 0, // server time minus performance.now()
  room: null, // { code, members, you }
  state: null, // the room's playback state
  controller: null,
  yt: null, // the YT.Player
  ytReady: false,
  options: { pauseOnAway: true }, // the room's options (docs/protocol.md)
  chat: [], // { from, name, text, at }, oldest first
  unread: 0, // messages that came while you weren't looking (shown in the tab's title)
  typing: new Map(), // client id -> when they were last said to be typing
  lastTypingSent: 0,
  stats: new Map(), // client id -> { rtt, drift, at }, yours included
  timers: [],
};

/** Chat survives a reload of the page, like the room does. */
const chatStore = {
  load() { try { return JSON.parse(sessionStorage.getItem('tandem.chat')) ?? []; } catch { return []; } },
  save(chat) { try { sessionStorage.setItem('tandem.chat', JSON.stringify(chat)); } catch { /* private mode */ } },
  clear() { try { sessionStorage.removeItem('tandem.chat'); } catch { /* private mode */ } },
};

const serverNow = () => performance.now() + T.clockOffset;

// ---------- Connection ----------

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const tag = document.createElement('script');
    tag.src = src;
    tag.onload = resolve;
    tag.onerror = () => reject(new Error(`Couldn't load ${src}`));
    document.head.append(tag);
  });
}

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
  drawConnection();
  if (!window.io) await loadScript(`${T.serverUrl}/socket.io/socket.io.js`);
  const socket = window.io(T.serverUrl, { transports: ['websocket', 'polling'] });
  T.socket = socket;

  let first = true;
  const ready = new Promise((resolve, reject) => {
    socket.on('connect', async () => {
      await syncClock();
      T.connection = 'online';
      // After a dropped connection, take our seat in the room again.
      if (!first && T.room) await enterRoom('room:join', { code: T.room.code }, true);
      first = false;
      drawConnection();
      clearTimeout(slow);
      clearTimeout(giveUp);
      showError('');
      resolve();
    });
    // A free host puts the server to sleep when nobody uses it; the first
    // connection wakes it, which takes a while. Socket.IO keeps retrying.
    const slow = setTimeout(() => showError('Waking up the sync server. This can take up to a minute…'), 4000);
    const giveUp = setTimeout(() => reject(new Error('unreachable')), 90_000);
  });
  socket.on('disconnect', () => {
    T.connection = 'reconnecting';
    drawConnection();
  });
  socket.on('state:changed', ({ state }) => applyState(state));
  socket.on('queue:changed', ({ queue }) => {
    T.queue = queue;
    drawQueue();
  });
  socket.on('member:joined', ({ members }) => membersChanged(members, 'joined'));
  socket.on('member:left', ({ members }) => membersChanged(members, 'left'));
  socket.on('member:changed', ({ members }) => membersChanged(members, 'changed'));
  socket.on('options:changed', ({ options }) => {
    T.options = options;
    drawOptions();
  });
  socket.on('chat:message', chatMessage);
  socket.on('reaction', showReaction);
  socket.on('typing', someoneTyping);
  socket.on('stats', ({ from, ...stats }) => {
    T.stats.set(from, { ...T.stats.get(from), ...stats, at: performance.now() });
    drawSidePeople();
  });

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
  let answer;
  try {
    await connect();
    // Coming back to a room: bring what we know, in case the server lost it.
    const restore = rejoining ? { restore: restoreInfo(T.state, T.queue, serverNow(), T.options) } : {};
    answer = await ask(event, { ...payload, ...restore, clientId: clientId(), name: T.name });
  } catch {
    disconnect();
    return showError(`Couldn't reach the sync server at ${T.serverUrl}. Check it in Settings.`);
  }
  if (!answer.ok) {
    if (!rejoining) return showError(answer.error);
    // The room we were in no longer exists.
    const wasInside = Boolean(T.room);
    leaveRoom();
    return showError(wasInside ? 'The room has closed.' : '');
  }

  const fresh = !T.room;
  T.room = { code: answer.room.code, members: answer.room.members, you: answer.room.you };
  remember.set('tandem.room', T.room.code);
  // The local program follows the same room, so it can keep VLC in step.
  tellLocal('join', localJoinDetails());
  if (fresh) {
    T.chat = rejoining ? chatStore.load() : [];
    if (!rejoining) chatStore.clear();
    drawRoom();
    startController();
  }
  T.queue = answer.room.queue ?? [];
  T.options = answer.room.options ?? T.options;
  drawOptions();
  drawChat();
  drawPeople();
  drawQueue();
  applyState(answer.room.state, true);
}

function leaveRoom() {
  tellLocal('leave');
  T.local = null;
  T.socket?.emit('room:leave');
  disconnect();
  remember.remove('tandem.room');
  T.room = null;
  T.state = null;
  T.queue = [];
  T.chat = [];
  T.unread = 0;
  T.typing.clear();
  T.stats.clear();
  chatStore.clear();
  markTitle();
  T.controller = null;
  T.yt?.destroy?.();
  T.yt = null;
  T.ytReady = false;
  drawLobby();
  layout();
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
  drawPeople();
  drawSidePeople();
  drawStatus();
}

// ---------- Chat, reactions and connection quality ----------

/** Whether you can see the chat right now (on the Watch Together page, in a visible tab). */
const chatInView = () => T.onPage && !document.hidden;

function chatMessage(message) {
  if (!T.room) return;
  T.chat.push(message);
  T.chat.splice(0, T.chat.length - CHAT_KEEP);
  chatStore.save(T.chat);
  T.typing.delete(message.from);
  if (message.from !== T.room.you && !chatInView()) {
    T.unread += 1;
    if (!T.onPage) notify(`${message.name}: ${message.text}`);
  }
  drawChat();
  markTitle();
}

/** Unread messages at the front of the tab's title: "💬2 · Tandem". */
const TITLE_MARK = /^💬\d+ · /;
function markTitle() {
  if (chatInView()) T.unread = 0;
  const plain = document.title.replace(TITLE_MARK, '');
  const wanted = T.room && T.unread ? `💬${T.unread} · ${plain}` : plain;
  if (document.title !== wanted) document.title = wanted;
}

function typing() {
  const now = performance.now();
  if (!T.socket?.connected || now - T.lastTypingSent < TYPING_SEND_MS) return;
  T.lastTypingSent = now;
  T.socket.emit('chat:typing');
}

function someoneTyping({ from }) {
  if (!T.room || from === T.room.you) return;
  T.typing.set(from, performance.now());
  drawTyping();
  setTimeout(drawTyping, TYPING_SHOW_MS + 100);
}

/** A reaction rises in the chat column, beside the player (never over it). */
function showReaction({ from, emoji }) {
  if (!T.room || typeof emoji !== 'string') return;
  const name = from === T.room.you ? null : T.room.members.find((m) => m.id === from)?.name;
  const floats = $('#tg-floats');
  if (!T.onPage || !floats) {
    if (name) notify(`${name}: ${emoji}`);
    return;
  }
  if (floats.children.length >= 12) floats.firstChild.remove();
  const float = document.createElement('div');
  float.className = 'tg-float';
  const face = document.createElement('b');
  face.textContent = emoji;
  float.append(face);
  if (name) {
    const label = document.createElement('small');
    label.textContent = name;
    float.append(label);
  }
  float.style.left = `${10 + Math.round(Math.random() * 70)}%`;
  floats.append(float);
  setTimeout(() => float.remove(), 2700);
}

/** Every STATS_MS: the round trip to the server and our drift, for the others to see. */
async function sendStats() {
  if (!T.room || !T.socket?.connected) return;
  const t0 = performance.now();
  try {
    await ask('time:ping', { t0 });
  } catch {
    return;
  }
  const rtt = Math.round(performance.now() - t0);
  const state = T.state;
  let drift = null;
  if (state && isRolling(state, serverNow())) drift = state.mediaType === 'local' ? T.local?.drift ?? null : T.controller?.drift() ?? null;
  T.socket.emit('stats:send', { rtt, drift });
  T.stats.set(T.room.you, { rtt, drift, at: performance.now() });
  drawSidePeople();
}

/** "90 ms · in sync", "650 ms (slow) · 0.4 s behind", or '' without a recent report. */
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

/**
 * Why the room was paused for someone, and whether to offer "Resume": once
 * they're back (or gone for good), not while they're still away.
 */
function pausedReason(state) {
  const id = state.pausedFor;
  if (id === T.room.you) return { text: 'you were away', resume: true };
  const m = T.room.members.find((member) => member.id === id);
  if (!m) return { text: 'your partner left', resume: true };
  if (!m.online) return { text: `${m.name} went offline`, resume: false };
  if (m.away) return { text: `${m.name} stepped away`, resume: false };
  return { text: `${m.name} is back`, resume: true };
}

/** A link for someone with Tandem's browser extension: opening it joins this room on youtube.com. */
function inviteLink() {
  const video = T.state?.mediaType === 'youtube' && T.state.mediaId ? `watch?v=${T.state.mediaId}` : '';
  return `https://www.youtube.com/${video}#tandem=${T.room.code}`;
}

// ---------- The local program (VLC) ----------

function localJoinDetails() {
  return { server: T.serverUrl, code: T.room.code, client: T.room.you, name: T.name, profile: T.profileId };
}

async function tellLocal(what, body = {}) {
  try {
    const response = await fetch(`/api/together/${what}`, {
      method: 'POST', headers: { 'X-Tandem': '1', 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const data = await response.json();
    if (!response.ok) showError(data.error);
    return data;
  } catch {
    return null;
  }
}

/** While the room plays a local file, ask the local program how that is going. */
async function watchLocal() {
  if (!T.room || T.state?.mediaType !== 'local') return;
  try {
    T.local = (await (await fetch('/api/status')).json()).together;
  } catch { /* the program is restarting */ }
  drawLocal();
  drawStatus();
}

// ---------- Sync ----------

function startController() {
  T.controller = new SyncController({
    player: youtubePlayer,
    clientId: T.room.you,
    mode: 'youtube',
    now: serverNow,
    send: (event, payload) => T.socket?.emit(event, payload),
  });
  T.timers.push(setInterval(reportPlayer, 250));
  T.timers.push(setInterval(watchLocal, 1000));
  // Keep telling the local program we're here; when this tab closes it stops.
  T.timers.push(setInterval(() => { if (T.room) tellLocal('join', localJoinDetails()); }, 15_000));
  T.timers.push(setInterval(() => T.controller?.tick(), SYNC_CONFIG.tickMs));
  T.timers.push(setInterval(sendStats, STATS_MS));
  T.timers.push(setInterval(markTitle, 1000));
}

function applyState(state, rejoined = false) {
  if (!T.controller) return;
  // After a reconnect the server may have restarted its numbering: start over.
  if (rejoined) T.controller.state = null;
  T.state = state;
  T.controller.onRemoteState(state);
  layout();
  drawStatus();
  drawNowPlaying();
}

/** Tell the sync logic what the YouTube player is doing right now. */
function reportPlayer() {
  drawStatus();
  if (!T.controller || !T.ytReady) return;
  const yt = T.yt;
  const code = yt.getPlayerState();
  const status = code === 1 ? 'playing' : code === 2 ? 'paused' : code === 3 ? 'buffering' : 'idle';
  const showing = yt.getVideoData()?.video_id || null;
  followPlayer(showing, code);
  T.controller.onSnapshot({
    mediaId: showing,
    status,
    position: yt.getCurrentTime() || 0,
    rate: yt.getPlaybackRate() || 1,
  });
}

/**
 * Two things the player does by itself that the room should follow:
 * finishing a video (the next one in the queue starts), and switching to
 * another video because someone clicked one of YouTube's suggestions.
 */
function followPlayer(showing, code) {
  const state = T.state;
  if (state?.mediaType !== 'youtube' || !showing) return;

  if (showing === state.mediaId) {
    T.onRoomVideo = showing;
    if (code === 0 && T.endedSent !== showing) {
      T.endedSent = showing;
      T.socket?.emit('media:ended', { mediaId: showing });
    }
    return;
  }
  // The player moved to a different video while it had been on the room's
  // one, and not because we told it to: someone clicked a suggestion.
  if (T.onRoomVideo === state.mediaId && T.controller.loadingId === null && (code === 1 || code === 3)) {
    T.onRoomVideo = null;
    T.socket?.emit('state:request', { action: 'load', mediaType: 'youtube', mediaId: showing, position: 0 });
  }
}

/** Reads the video ids in a playlist, using a player that never plays anything. */
async function readPlaylist(listId) {
  await loadYouTubeApi();
  const holder = document.createElement('div');
  holder.className = 'tg-scratch';
  holder.innerHTML = '<div></div>';
  document.body.append(holder);
  try {
    return await new Promise((resolve) => {
      const give = (ids) => resolve(Array.isArray(ids) ? ids : []);
      const reader = new window.YT.Player(holder.firstChild, {
        width: 200, height: 200,
        playerVars: { listType: 'playlist', list: listId },
        events: {
          onReady: async () => {
            for (let i = 0; i < 24; i++) {
              const ids = reader.getPlaylist();
              if (Array.isArray(ids) && ids.length) return give(ids);
              await new Promise((r) => setTimeout(r, 250));
            }
            give([]);
          },
          onError: () => give([]),
        },
      });
      setTimeout(() => give([]), 12_000);
    });
  } finally {
    holder.remove();
  }
}

/** Turns pasted text into video ids, opening up any playlists in it. */
async function videosIn(text) {
  const { videos, playlists, unknown } = parseYouTubeLinks(text);
  for (const list of playlists) {
    showError('Reading the playlist…');
    const ids = await readPlaylist(list);
    if (!ids.length) {
      showError("Couldn't read that playlist. Is it private?");
      return null;
    }
    videos.push(...ids);
  }
  if (!videos.length) {
    showError("That doesn't look like a YouTube link.");
    return null;
  }
  showError(unknown ? `${unknown} of those weren't YouTube links and were skipped.` : '');
  return videos;
}

/** A video's title, fetched through the local program the first time. */
function titleOf(videoId) {
  const known = T.titles.get(videoId);
  if (known) return known.title;
  T.titles.set(videoId, { title: null });
  fetch(`/api/youtube/title?id=${videoId}`).then((r) => r.json()).then((info) => {
    if (!info?.title) return;
    T.titles.set(videoId, info);
    drawQueue();
    drawNowPlaying();
  }).catch(() => {});
  return null;
}

// ---------- The YouTube player ----------

let apiLoading = null;
function loadYouTubeApi() {
  apiLoading ??= new Promise((resolve) => {
    window.onYouTubeIframeAPIReady = resolve;
    loadScript('https://www.youtube.com/iframe_api').catch(() => showError("Couldn't load the YouTube player."));
  });
  return apiLoading;
}

const YOUTUBE_ERRORS = {
  2: "That link doesn't point to a valid video.",
  5: "This video can't be played in the embedded player.",
  100: 'This video was removed or is private.',
  101: "The owner of this video doesn't allow it to be played outside YouTube. Pick another video.",
  150: "The owner of this video doesn't allow it to be played outside YouTube. Pick another video.",
  153: 'YouTube rejected the player (error 153). This is a problem with Tandem, not the video.',
};

/** What the sync logic calls to control the player. */
const youtubePlayer = {
  async load(state, position) {
    if (state.mediaType !== 'youtube') {
      // A local file: the local program plays it in VLC. Get YouTube out of the way.
      if (T.ytReady) T.yt.stopVideo();
      return;
    }
    showError('');
    layout();
    await loadYouTubeApi();
    if (!T.room) return; // left while the player was loading
    if (T.yt) {
      if (T.ytReady) T.yt.loadVideoById(state.mediaId, position);
      return;
    }
    T.yt = new window.YT.Player('tg-yt', {
      width: '100%',
      height: '100%',
      playerVars: { playsinline: 1, rel: 0, origin: location.origin },
      events: {
        onReady: () => {
          T.ytReady = true;
          // Start from wherever the room has got to by now.
          const current = T.state;
          if (current?.mediaId) T.yt.loadVideoById(current.mediaId, expectedPosition(current, serverNow()));
        },
        onStateChange: reportPlayer,
        onError: (event) => showError(YOUTUBE_ERRORS[event.data] ?? `YouTube reported error ${event.data}.`),
      },
    });
  },
  play() { T.yt.playVideo(); },
  pause() { T.yt.pauseVideo(); },
  seek(seconds) { T.yt.seekTo(seconds, true); },
  setRate() { /* YouTube drift is corrected by seeking */ },
};

// ---------- Drawing ----------

function showError(message) {
  const box = $('#tg-message');
  if (box) box.textContent = message || '';
}

function drawLobby() {
  root.classList.remove('has-video', 'has-local');
  root.innerHTML = `
    <div class="tg-lobby">
      <h1>Watch Together</h1>
      <p class="hint">Start a room and send the code to your partner, or type in the code they sent you.
        Each of you plays the video on your own device; Tandem keeps them in step.</p>
      <div class="tg-cards">
        <section class="tg-card">
          <h2>Start a room</h2>
          <p class="hint">You'll get a 6-character code to share.</p>
          <button class="btn btn-play" data-tg="create">Create room</button>
        </section>
        <section class="tg-card">
          <h2>Join a room</h2>
          <p class="hint">Enter the code from your partner.</p>
          <form class="tg-join" data-tg-form="join">
            <input class="input tg-code-input" name="code" maxlength="8" placeholder="ABC123" autocomplete="off" required>
            <button class="btn btn-secondary" type="submit">Join</button>
          </form>
        </section>
      </div>
      <p class="tg-error" id="tg-message" role="alert"></p>
      <p class="hint">Sync server: <code>${esc(T.serverUrl)}</code> · change it in <a href="#/settings">Settings</a></p>
    </div>`;
}

function drawRoom() {
  root.innerHTML = `
    <div class="tg-room">
      <div class="tg-bar">
        <div class="tg-codebox">
          <span class="tg-label">Room code</span>
          <b class="tg-code">${esc(T.room.code)}</b>
          <button class="btn btn-secondary tg-small" data-tg="copy">Copy</button>
          <button class="btn btn-outline tg-small" data-tg="invite"
            title="For someone with Tandem's browser extension: opening the link joins this room on youtube.com">Copy invite link</button>
        </div>
        <div class="tg-people" id="tg-people"></div>
        <div class="tg-conn" id="tg-conn"></div>
        <button class="btn btn-outline tg-small" data-tg="leave">Leave room</button>
      </div>
      <form class="tg-load" data-tg-form="load">
        <input class="input" name="link" placeholder="Paste YouTube links (one or several) or a playlist link" autocomplete="off" required>
        <button class="btn btn-play" type="submit" data-mode="now">Play for both</button>
        <button class="btn btn-secondary" type="submit" data-mode="queue">Add to queue</button>
      </form>
      <p class="tg-error" id="tg-message" role="alert"></p>
      <div class="tg-body">
      <div class="tg-main">
      <div class="tg-stage">
        <div class="tg-player">
          <div id="tg-yt"></div>
          <div class="tg-empty">Paste a YouTube link above to start watching together.<br>
            To watch one of your own videos together, press Play on it in your library while you're in this room.</div>
        </div>
        <div class="tg-local" id="tg-local"></div>
        <a class="tg-back" href="#/together">Back to the room</a>
      </div>
      <div class="tg-now" id="tg-now"></div>
      <div class="tg-status"><span id="tg-status"></span>
        <button class="btn btn-play tg-small" data-tg="resume" id="tg-resume" hidden>▶ Resume</button></div>
      <div class="tg-queue" id="tg-queue"></div>
      </div>
      <aside class="tg-side">
        <div class="tg-floats" id="tg-floats"></div>
        <div class="tg-side-people" id="tg-side-people"></div>
        <div class="tg-log" id="tg-log"></div>
        <div class="tg-typing" id="tg-typing"></div>
        <div class="tg-reacts">${REACTIONS.map((e) => `<button type="button" data-tg="react" data-emoji="${e}" title="Send ${e} to everyone">${e}</button>`).join('')}</div>
        <form class="tg-say" data-tg-form="say">
          <input class="input" name="text" maxlength="500" placeholder="Say something" autocomplete="off">
          <button class="btn btn-secondary tg-small" type="submit">Send</button>
        </form>
        <label class="tg-check"><input type="checkbox" data-tg-option="pauseOnAway">
          Pause for everyone when someone steps away or leaves</label>
      </aside>
      </div>
    </div>`;
  drawConnection();
  drawOptions();
  drawChat();
  drawSidePeople();
}

/** The chat column's list of people, with how their connection and sync are doing. */
function drawSidePeople() {
  const box = $('#tg-side-people');
  if (!box || !T.room) return;
  box.replaceChildren(...T.room.members.map((m) => {
    const presence = !m.online ? 'offline' : m.away ? 'away' : 'here';
    const line = document.createElement('div');
    line.className = `tg-person ${m.online ? 'online' : ''} ${presence}`;
    line.append(document.createElement('i'), `${m.name}${m.id === T.room.you ? ' (you)' : ''} · ${presence}`);
    const quality = m.online ? qualityOf(m.id) : '';
    if (quality) {
      const small = document.createElement('small');
      small.textContent = ` · ${quality}`;
      line.append(small);
    }
    return line;
  }));
}

/** The messages. Plain text only: they come from other people. */
function drawChat() {
  const log = $('#tg-log');
  if (!log || !T.room) return;
  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  if (!T.chat.length) {
    const empty = document.createElement('p');
    empty.className = 'hint';
    empty.textContent = 'Messages and reactions go to everyone in the room.';
    log.replaceChildren(empty);
  } else {
    log.replaceChildren(...T.chat.map((m) => {
      const line = document.createElement('p');
      line.className = m.from === T.room.you ? 'tg-msg mine' : 'tg-msg';
      line.title = new Date(m.at).toLocaleTimeString();
      const who = document.createElement('b');
      who.textContent = m.from === T.room.you ? 'You' : m.name;
      line.append(who, m.text);
      return line;
    }));
  }
  if (atBottom) log.scrollTop = log.scrollHeight;
  drawTyping();
}

function drawTyping() {
  const box = $('#tg-typing');
  if (!box || !T.room) return;
  const now = performance.now();
  const names = [...T.typing]
    .filter(([, at]) => now - at < TYPING_SHOW_MS)
    .map(([id]) => T.room.members.find((m) => m.id === id)?.name)
    .filter(Boolean);
  box.textContent = names.length ? `${names.join(' and ')} ${names.length > 1 ? 'are' : 'is'} typing…` : '';
}

function drawOptions() {
  const box = root.querySelector('[data-tg-option="pauseOnAway"]');
  if (box) box.checked = T.options.pauseOnAway;
}

function drawPeople() {
  const box = $('#tg-people');
  if (!box || !T.room) return;
  const others = T.room.members.filter((m) => m.id !== T.room.you);
  box.innerHTML = others.length
    ? others.map((m) => {
      // Someone on the browser extension can say they're away (AFK).
      const presence = !m.online ? 'offline' : m.away ? 'away' : 'here';
      return `<span class="tg-person ${m.online ? 'online' : ''} ${presence}"><i></i>${esc(m.name)} is ${presence}</span>`;
    }).join('')
    : '<span class="tg-person"><i></i>Waiting for your partner to join…</span>';
}

function drawConnection() {
  const box = $('#tg-conn');
  if (!box) return;
  const label = { online: 'Connected', connecting: 'Connecting…', reconnecting: 'Reconnecting…', offline: 'Offline' }[T.connection];
  box.className = `tg-conn ${T.connection}`;
  box.innerHTML = `<i></i>${label}`;
}

function drawNowPlaying() {
  const box = $('#tg-now');
  if (!box) return;
  const state = T.state;
  const title = state?.mediaType === 'youtube' && state.mediaId ? (titleOf(state.mediaId) ?? '') : '';
  const chosen = chosenBy(state);
  box.textContent = title && chosen ? `${title} · ${chosen}` : title;
}

/** Who chose the room's video, in words: "Ben picked it", "YouTube autoplayed it on Ben's side", … */
function chosenBy(state) {
  if (!state?.mediaId || !state.loadedBy || !T.room) return '';
  const you = state.loadedBy === T.room.you;
  const name = you ? 'you' : T.room.members.find((m) => m.id === state.loadedBy)?.name ?? 'someone who left';
  if (state.loadedHow === 'autoplay') return `YouTube autoplayed it ${you ? 'on your side' : `on ${name}'s side`}`;
  if (state.loadedHow === 'queue') return `next in the queue, added by ${name}`;
  return `${you ? 'You' : name} picked it`;
}

/** A long playlist isn't drawn (or its titles looked up) all at once. */
const QUEUE_SHOWN = 30;

function drawQueue() {
  const box = $('#tg-queue');
  if (!box || !T.room) return;
  if (!T.queue.length) return void (box.innerHTML = '');
  const nameOf = (id) => (id === T.room.you ? 'you' : T.room.members.find((m) => m.id === id)?.name ?? 'your partner');
  box.innerHTML = `
    <div class="tg-queue-head">
      <h3>Up next · ${T.queue.length}</h3>
      <button class="btn btn-outline tg-small" data-tg="queue-clear">Clear</button>
    </div>
    <ol>${T.queue.slice(0, QUEUE_SHOWN).map((item) => `
      <li>
        <img src="https://i.ytimg.com/vi/${esc(item.mediaId)}/mqdefault.jpg" alt="" loading="lazy">
        <div class="tg-queue-text">
          <b>${esc(titleOf(item.mediaId) ?? 'YouTube video')}</b>
          <span>added by ${esc(nameOf(item.addedBy))}</span>
        </div>
        <button class="btn btn-secondary tg-small" data-tg="queue-play" data-id="${esc(item.id)}">Play now</button>
        <button class="btn btn-outline tg-small" data-tg="queue-remove" data-id="${esc(item.id)}" aria-label="Remove from queue">Remove</button>
      </li>`).join('')}</ol>
    ${T.queue.length > QUEUE_SHOWN ? `<p class="hint">…and ${T.queue.length - QUEUE_SHOWN} more.</p>` : ''}`;
}

const megabytes = (bytes) => (bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`);

/** The panel shown in place of the player while the room plays a local file. */
function drawLocal() {
  const box = $('#tg-local');
  if (!box) return;
  const local = T.local?.local;
  const title = esc(T.state?.mediaTitle || 'a video');
  if (T.state?.mediaType !== 'local' || !local) return void (box.innerHTML = '');

  const expected = local.expected
    ? `${megabytes(local.expected.size)}${local.expected.duration ? `, ${clock(local.expected.duration)} long` : ''}` : '';
  let body;
  switch (local.phase) {
    case 'playing':
      body = `<p>Open in VLC on this computer${local.file ? `: <code>${esc(local.file.name)}</code>` : ''}.
        Play, pause and seek in VLC apply to both of you.</p>`;
      break;
    case 'missing':
      body = local.alternatives.length
        ? `<p>You don't have the exact file your partner is playing (${expected}). These are the same length, so they
            look like other versions of it. You can play one, but sync may be off:</p>
          <ul class="tg-files">${local.alternatives.map((f) => `
            <li><span><code>${esc(f.name)}</code> · ${megabytes(f.size)}</span>
              <button class="btn btn-secondary tg-small" data-tg="use-file" data-file="${f.file_id}">Play this one</button></li>`).join('')}</ul>`
        : `<p>That file isn't in your library (${expected}). You both need the same file. If you have it, add its folder
            in <a href="#/settings">Settings</a>; Tandem finds it by its contents, whatever it's called.</p>`;
      break;
    case 'closed':
      body = `<p>VLC was closed on this computer. Your partner can keep watching.</p>
        <button class="btn btn-secondary tg-small" data-tg="reopen">Open it again</button>`;
      break;
    case 'error':
      body = `<p class="tg-error">${esc(local.message)}</p>`;
      break;
    default:
      body = '<p>Looking for it in your library…</p>';
  }
  const html = `<h2>${title}</h2>${body}`;
  if (box.dataset.html !== html) {
    box.dataset.html = html;
    box.innerHTML = html;
  }
}

const clock = (seconds) => {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60;
  return `${h ? `${h}:${String(m).padStart(2, '0')}` : m}:${String(s % 60).padStart(2, '0')}`;
};

function drawStatus() {
  const box = $('#tg-status');
  if (!box || !T.room) return;
  const state = T.state;
  let text;
  if (!state?.mediaId) {
    text = 'Nothing playing yet.';
  } else {
    const now = serverNow();
    const nameOf = (id) => (id === T.room.you ? 'you' : T.room.members.find((m) => m.id === id)?.name ?? 'your partner');
    const at = clock(expectedPosition(state, now));
    if (state.waitingFor.length) {
      text = `Waiting for ${state.waitingFor.map(nameOf).join(' and ')} to load…`;
    } else if (state.isPlaying && state.updatedAt > now + 300) {
      text = `Starting in ${Math.ceil((state.updatedAt - now) / 1000)}`;
    } else if (isRolling(state, now)) {
      const drift = state.mediaType === 'local' ? T.local?.drift : T.controller?.drift();
      const sync = drift == null ? '' : Math.abs(drift) < SYNC_CONFIG.youtube.seekThreshold
        ? ' · in sync' : ` · ${Math.abs(drift).toFixed(1)} s ${drift > 0 ? 'ahead' : 'behind'}, catching up`;
      text = `Playing · ${at}${sync}`;
    } else if (!state.isPlaying && state.pausedFor) {
      text = `Paused at ${at} · ${pausedReason(state).text}`;
    } else {
      text = `Paused at ${at}`;
    }
  }
  if (box.textContent !== text) box.textContent = text;
  const resume = $('#tg-resume');
  if (resume) resume.hidden = !(state?.mediaId && !state.isPlaying && state.pausedFor && pausedReason(state).resume);
}

/** Full page, docked in the corner, or hidden, depending on where you are. */
function layout() {
  // Only a YouTube video has a player to show here; local files play in VLC.
  const hasVideo = Boolean(T.room && T.state?.mediaId && T.state.mediaType === 'youtube');
  root.classList.toggle('has-video', hasVideo);
  root.classList.toggle('has-local', Boolean(T.room && T.state?.mediaType === 'local'));
  drawLocal();
  root.hidden = !T.onPage && !hasVideo;
  root.classList.toggle('docked', !T.onPage && hasVideo);
  document.body.classList.toggle('together-open', T.onPage);
}

// ---------- Events ----------

// Closing the tab (or reloading it): tell the local program straight away.
window.addEventListener('pagehide', () => {
  if (!T.room) return;
  fetch('/api/together/gone', { method: 'POST', keepalive: true, headers: { 'X-Tandem': '1' } }).catch(() => {});
});

root.addEventListener('click', (event) => {
  const button = event.target.closest('[data-tg]');
  if (!button) return;
  switch (button.dataset.tg) {
    case 'create': return void enterRoom('room:create', {});
    case 'leave': return leaveRoom();
    case 'queue-play': return void T.socket?.emit('queue:play', { id: button.dataset.id });
    case 'queue-remove': return void T.socket?.emit('queue:remove', { id: button.dataset.id });
    case 'queue-clear': return void T.socket?.emit('queue:clear');
    case 'use-file': return void tellLocal('use', { file: button.dataset.file }).then(watchLocal);
    case 'reopen': return void tellLocal('reopen').then(watchLocal);
    case 'resume': return void T.socket?.emit('state:request', { action: 'play' });
    case 'react': return void T.socket?.emit('reaction:send', { emoji: button.dataset.emoji });
    case 'invite':
      return void navigator.clipboard?.writeText(inviteLink())
        .then(() => notify('Invite link copied: for someone with the Tandem extension'), () => notify('Copy failed', 'error'));
    case 'copy':
      return void navigator.clipboard?.writeText(T.room.code)
        .then(() => notify('Room code copied'), () => notify('Copy failed; select the code instead', 'error'));
    default: return undefined;
  }
});

root.addEventListener('change', (event) => {
  const option = event.target.closest('[data-tg-option]');
  if (option) T.socket?.emit('options:set', { [option.dataset.tgOption]: option.checked });
});

root.addEventListener('input', (event) => {
  if (event.target.closest('[data-tg-form="say"]')) typing();
});

document.addEventListener('visibilitychange', markTitle);

root.addEventListener('submit', (event) => {
  event.preventDefault();
  const form = event.target;
  if (form.dataset.tgForm === 'say') {
    const text = form.text.value.trim();
    if (text && T.socket?.connected) {
      T.socket.emit('chat:send', { text });
      form.text.value = '';
    }
  }
  if (form.dataset.tgForm === 'join') {
    showError('');
    enterRoom('room:join', { code: form.code.value });
  }
  if (form.dataset.tgForm === 'load') {
    const playNow = event.submitter?.dataset.mode !== 'queue';
    const text = form.link.value;
    form.link.value = '';
    videosIn(text).then((videos) => {
      if (!videos || !T.socket) return;
      // "Play for both" starts the first one now; anything else waits its turn.
      if (playNow) T.socket.emit('state:request', { action: 'load', mediaType: 'youtube', mediaId: videos.shift(), position: 0 });
      if (videos.length) T.socket.emit('queue:add', { mediaIds: videos });
      if (videos.length) notify(`${videos.length} added to the queue`);
    });
  }
});

// ---------- What app.js calls ----------

window.Together = {
  /** For debugging from the browser console: what the sync logic currently sees. */
  inspect() {
    const c = T.controller;
    return c && {
      serverNow: serverNow(), state: c.state, snapshot: c.snapshot, drift: c.drift(),
      guardFor: c.guardUntil - serverNow(), seekAhead: c.seekAhead, lastDriftSeekAgo: serverNow() - c.lastDriftSeek,
      clockOffset: T.clockOffset, hidden: document.hidden,
    };
  },
  /** Whether you are in a room right now (so the library's Play button plays for both). */
  inRoom() {
    return Boolean(T.room);
  },

  /** Called on every navigation with the current path, profile and settings. */
  onRoute(path, profile, settings) {
    const profileName = profile?.name;
    T.onPage = path === '/together' && Boolean(profileName);
    if (profile) {
      T.name = profile.name;
      T.profileId = profile.id;
    }
    if (settings?.sync_server) T.serverUrl = settings.sync_server.replace(/\/+$/, '');
    markTitle(); // back on the page: its messages have been seen
    if (!profileName) return void (root.hidden = true);

    if (!T.room && !root.querySelector('.tg-lobby')) drawLobby();
    // Reloading the page keeps you in your room.
    const saved = remember.get('tandem.room');
    if (!T.room && saved && !T.socket && T.serverUrl) enterRoom('room:join', { code: saved }, true);
    layout();
  },
};
