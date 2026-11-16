// The Watch Together page: create or join a room, and watch YouTube in sync.
//
// app.js owns the rest of the page and calls Together.onRoute() whenever the
// address changes. Everything here lives in the #together element, which sits
// outside the part app.js redraws, so the player survives moving around the
// library. While a video is loaded and you browse elsewhere, the player stays
// docked in the corner (YouTube requires its player to remain visible).

import { SYNC_CONFIG } from './sync-config.js';
import { bestOffset, expectedPosition, isRolling, SyncController } from './sync-core.js';
import { parseYouTubeId } from './youtube-url.js';

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
      resolve();
    });
    socket.once('connect_error', () => reject(new Error('unreachable')));
  });
  socket.on('disconnect', () => {
    T.connection = 'reconnecting';
    drawConnection();
  });
  socket.on('state:changed', ({ state }) => applyState(state));
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
    answer = await ask(event, { ...payload, clientId: clientId(), name: T.name });
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
  if (fresh) {
    drawRoom();
    startController();
  }
  drawPeople();
  applyState(answer.room.state, true);
}

function leaveRoom() {
  T.socket?.emit('room:leave');
  disconnect();
  remember.remove('mendu.room');
  T.room = null;
  T.state = null;
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
}

/** Tell the sync logic what the YouTube player is doing right now. */
function reportPlayer() {
  drawStatus();
  if (!T.controller || !T.ytReady) return;
  const yt = T.yt;
  const code = yt.getPlayerState();
  const status = code === 1 ? 'playing' : code === 2 ? 'paused' : code === 3 ? 'buffering' : 'idle';
  T.controller.onSnapshot({
    mediaId: yt.getVideoData()?.video_id || null,
    status,
    position: yt.getCurrentTime() || 0,
    rate: yt.getPlaybackRate() || 1,
  });
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
      return showError('Your partner started a local file. Watching local files together is not built yet.');
    }
    showError('');
    root.classList.add('has-video');
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
  root.classList.remove('has-video');
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
        <input class="input" name="link" placeholder="Paste a YouTube link" autocomplete="off" required>
        <button class="btn btn-play" type="submit">Play for both</button>
      </form>
      <p class="tg-error" id="tg-message" role="alert"></p>
      <div class="tg-stage">
        <div class="tg-player">
          <div id="tg-yt"></div>
          <div class="tg-empty">Paste a YouTube link above to start watching together.</div>
        </div>
        <a class="tg-back" href="#/together">Back to the room</a>
      </div>
      <div class="tg-status" id="tg-status"></div>
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
      const drift = T.controller?.drift();
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
  const hasVideo = Boolean(T.room && T.state?.mediaId);
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
    const id = parseYouTubeId(form.link.value);
    if (!id) return showError("That doesn't look like a YouTube video link.");
    showError('');
    form.link.value = '';
    T.socket?.emit('state:request', { action: 'load', mediaType: 'youtube', mediaId: id, position: 0 });
  }
});

// ---------- What app.js calls ----------

window.Together = {
  /** Called on every navigation with the current path, profile name and settings. */
  onRoute(path, profileName, settings) {
    T.onPage = path === '/together' && Boolean(profileName);
    if (profileName) T.name = profileName;
    if (settings?.sync_server) T.serverUrl = settings.sync_server.replace(/\/+$/, '');
    if (!profileName) return void (root.hidden = true);

    if (!T.room && !root.querySelector('.tg-lobby')) drawLobby();
    // Reloading the page keeps you in your room.
    const saved = remember.get('mendu.room');
    if (!T.room && saved && !T.socket && T.serverUrl) enterRoom('room:join', { code: saved }, true);
    layout();
  },
};
