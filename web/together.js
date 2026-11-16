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

const remember = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch { /* private mode */ } },
  remove(key) { try { localStorage.removeItem(key); } catch { /* private mode */ } },
};

/** This browser's permanent id in rooms, so a reconnect is recognised as the same person. */
function clientId() {
  let id = remember.get('mendu.client');
  if (!id) {
    id = crypto.randomUUID();
    remember.set('mendu.client', id);
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
  timers: [],
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
    const restore = rejoining ? { restore: restoreInfo(T.state, T.queue, serverNow()) } : {};
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
  remember.set('mendu.room', T.room.code);
  // The local program follows the same room, so it can keep VLC in step.
  tellLocal('join', { server: T.serverUrl, code: T.room.code, client: T.room.you, name: T.name, profile: T.profileId });
  if (fresh) {
    drawRoom();
    startController();
  }
  T.queue = answer.room.queue ?? [];
  drawPeople();
  drawQueue();
  applyState(answer.room.state, true);
}

function leaveRoom() {
  tellLocal('leave');
  T.local = null;
  T.socket?.emit('room:leave');
  disconnect();
  remember.remove('mendu.room');
  T.room = null;
  T.state = null;
  T.queue = [];
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
  }
  if (what === 'left' && members.length < before.size) notify('Your partner left the room');
  drawPeople();
}

// ---------- The local program (VLC) ----------

async function tellLocal(what, body = {}) {
  try {
    const response = await fetch(`/api/together/${what}`, {
      method: 'POST', headers: { 'X-Mendu': '1', 'Content-Type': 'application/json' }, body: JSON.stringify(body),
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
  T.timers.push(setInterval(() => T.controller?.tick(), SYNC_CONFIG.tickMs));
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
  153: 'YouTube rejected the player (error 153). This is a problem with Mendu, not the video.',
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
        Each of you plays the video on your own device; Mendu keeps them in step.</p>
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
      <div class="tg-status" id="tg-status"></div>
      <div class="tg-queue" id="tg-queue"></div>
    </div>`;
  drawConnection();
}

function drawPeople() {
  const box = $('#tg-people');
  if (!box || !T.room) return;
  const others = T.room.members.filter((m) => m.id !== T.room.you);
  box.innerHTML = others.length
    ? others.map((m) => `<span class="tg-person ${m.online ? 'online' : ''}"><i></i>${esc(m.name)} ${m.online ? 'is here' : 'is offline'}</span>`).join('')
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
  box.textContent = state?.mediaType === 'youtube' && state.mediaId ? (titleOf(state.mediaId) ?? '') : '';
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
            in <a href="#/settings">Settings</a>; Mendu finds it by its contents, whatever it's called.</p>`;
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
    } else {
      text = `Paused at ${at}`;
    }
  }
  if (box.textContent !== text) box.textContent = text;
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
    case 'copy':
      return void navigator.clipboard?.writeText(T.room.code)
        .then(() => notify('Room code copied'), () => notify('Copy failed; select the code instead', 'error'));
    default: return undefined;
  }
});

root.addEventListener('submit', (event) => {
  event.preventDefault();
  const form = event.target;
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
    if (!profileName) return void (root.hidden = true);

    if (!T.room && !root.querySelector('.tg-lobby')) drawLobby();
    // Reloading the page keeps you in your room.
    const saved = remember.get('mendu.room');
    if (!T.room && saved && !T.socket && T.serverUrl) enterRoom('room:join', { code: saved }, true);
    layout();
  },
};
