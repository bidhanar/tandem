// Tandem on youtube.com: keeps this tab in step with your partner's.
//
// content.js loads this into every youtube.com tab. A tab joins a room when
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
// YouTube's player is reached through bridge.js, which runs in the page itself.

import { io } from './socket.io.esm.min.js';
import { SYNC_CONFIG } from './sync-config.js';
import { expectedPosition, bestOffset, isRolling, restoreInfo, SyncController } from './sync-core.js';
import { pageOf, samePage, shareablePath, watchPath } from './youtube-page.js';
import { DEFAULT_SERVER } from './defaults.js';

/** How often the player is read. */
const READ_MS = 250;
/** A page we asked YouTube to open counts as ours if it shows up within this long. */
const GOING_MS = 8000;
/** How long to wait for YouTube to say what a new page is before passing it on. */
const SHARE_WAIT_MS = 3000;
/** Drift shown as "in sync" in the status line. */
const IN_SYNC = 0.25;

const T = {
  settings: null, // { server, name, clientId }
  socket: null,
  connection: 'offline', // 'offline' | 'connecting' | 'online' | 'reconnecting'
  clockOffset: 0, // server time minus performance.now()
  message: '', // what went wrong, or what is taking a while; shown in the popup
  room: null, // { code, members, you }
  queue: [], // kept only so a restarted server can be given it back
  controller: null,
  page: pageOf(location.href), // the youtube.com page this tab shows
  goingTo: null, // a page we asked YouTube to open (for the room or the partner), with `at`
  toShare: null, // { page, since }: a page of ours to pass on to the partner
  leftVideo: undefined, // the room's video when we left its page to look around
  held: null, // room state that came while looking around, for when we're back on a video
  readyFor: null, // the held state's version we already said we're ready for
  endedSent: null, // the video whose ending we have reported
  lastPosition: 0, // where the video was before an ad started
  notice: null, // { text, until }: a short message in place of the status
  compact: false, // the badge is folded down to the room code
  timers: [],
};

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

/** Opens a youtube.com page in this tab, without reloading it. */
function go(path) {
  const target = pageOf(path);
  if (samePage(target, T.page) || heading(target)) return;
  T.goingTo = { ...target, at: performance.now() };
  bridge({ do: 'go', path });
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

/** What the player on this video page is doing, in the form the sync logic expects. */
function readPlayer(page) {
  const p = bridge({ do: 'read' });
  // Right after moving to another video the player still shows the old one for a moment.
  if (!p || p.videoId !== page.videoId) return { mediaId: null, status: 'idle', position: 0, rate: 1, ended: false };
  // An ad is like buffering: the room waits for us (up to the server's limit) and nothing is commanded.
  if (p.ad) return { mediaId: p.videoId, status: 'buffering', position: T.lastPosition, rate: 1, ended: false };
  T.lastPosition = p.time;
  return { mediaId: p.videoId, status: STATUS[p.state] ?? 'buffering', position: p.time, rate: p.rate, ended: p.state === 0 };
}

// ---------- Following the page ----------

/** Every READ_MS: notice page changes, and tell the sync logic what the player is doing. */
function step() {
  if (!T.controller) return;
  const page = pageOf(location.href);
  if (!samePage(page, T.page)) {
    const before = T.page;
    T.page = page;
    pageChanged(before, page);
  }
  sharePage();
  if (page.kind !== 'watch') return; // looking around: there's no video of ours to follow

  const { ended, ...reading } = readPlayer(page);
  T.controller.onSnapshot(reading);
  const state = T.controller.state;
  if (ended && state?.mediaId === reading.mediaId && T.endedSent !== reading.mediaId) {
    // Lets the room's queue move on, if it has one (it is filled from Tandem's page).
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
    } else {
      // The person here picked this video (or YouTube moved on to the next one): play it for both.
      c.requestLoad('youtube', after.videoId, after.start);
    }
  }
  T.toShare = !ours && after.kind !== 'other' ? { page: after, since: performance.now() } : null;
  sharePage();
  draw();
}

/**
 * Takes your partner's tab to the page this one just opened. YouTube fills
 * in what the page is (a channel's id) a moment after its address changes,
 * so this waits for that, up to SHARE_WAIT_MS.
 */
function sharePage() {
  if (!T.toShare) return;
  const { page, since } = T.toShare;
  const shown = bridge({ do: 'page' });
  const ready = shown?.url === page.path;
  if (!ready && performance.now() - since < SHARE_WAIT_MS) return; // try again on the next step
  T.toShare = null;
  T.socket?.emit('page:send', { path: ready ? shareablePath(page.path, shown.channelId) : page.path });
}

/** The partner opened another page: go there too. */
function partnerPage({ from, path }) {
  if (!T.room || from === T.room.you) return;
  const target = pageOf(path);
  if (target.kind === 'other') return; // not a page we follow
  if (target.kind === 'watch') {
    // Videos come with the room's state. This only matters when the partner
    // goes back to the room's video while we're looking around.
    const state = T.held ?? T.controller?.state;
    if (target.videoId !== roomVideo(state)) return;
    return go(watchPath(target.videoId, expectedPosition(state, serverNow())));
  }
  go(target.path);
}

/** The room's state, from the server. */
function deliver(state) {
  remember.set('known', { state, queue: T.queue });
  const lookingAround = T.page.kind !== 'watch';
  // While looking around, only a new video takes us back to a video page.
  if (lookingAround && !(roomVideo(state) && roomVideo(state) !== T.leftVideo)) {
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
  draw();
}

/** Starting a room while on a video: that video plays for both, from where you are. */
function shareThisVideo() {
  if (T.page.kind !== 'watch') return;
  const p = bridge({ do: 'read' });
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
  socket.on('queue:changed', ({ queue }) => { T.queue = queue; });
  socket.on('member:joined', ({ members }) => membersChanged(members, 'joined'));
  socket.on('member:left', ({ members }) => membersChanged(members, 'left'));
  socket.on('page', partnerPage);

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
    const restore = rejoining ? { restore: restoreInfo(T.controller?.state ?? known.state, T.queue.length ? T.queue : known.queue, serverNow()) } : {};
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
  T.queue = answer.room.queue ?? [];
  T.page = pageOf(location.href);
  // After a reconnect the server may have restarted its numbering: start over.
  if (rejoining) {
    T.controller.state = null;
    T.held = null;
  }
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
  Object.assign(T, { room: null, controller: null, held: null, queue: [], leftVideo: undefined, endedSent: null });
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
  }
  if (what === 'left' && members.length < before.size) notify('Your partner left the room');
  draw();
}

function startController() {
  T.controller = new SyncController({
    player,
    clientId: T.room.you,
    // Drift is corrected by playing slightly faster or slower, as for VLC:
    // youtube.com's player takes any speed, unlike the embedded one.
    mode: 'local',
    now: serverNow,
    send: (event, payload) => T.socket?.emit(event, payload),
  });
  T.timers.push(setInterval(step, READ_MS));
  T.timers.push(setInterval(() => { if (T.page.kind === 'watch') T.controller?.tick(); }, SYNC_CONFIG.tickMs));
  T.timers.push(setInterval(draw, 500));
}

// ---------- What you see ----------

function setMessage(text) {
  T.message = text;
  draw();
}

function notify(text) {
  T.notice = { text, until: performance.now() + 4000 };
  draw();
}

const clock = (seconds) => {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60;
  return `${h ? `${h}:${String(m).padStart(2, '0')}` : m}:${String(s % 60).padStart(2, '0')}`;
};

function partnerLine() {
  const others = T.room.members.filter((m) => m.id !== T.room.you);
  if (!others.length) return 'Waiting for your partner';
  return others.map((m) => `${m.name} ${m.online ? 'is here' : 'is offline'}`).join(', ');
}

function statusLine() {
  if (!T.room) return '';
  if (T.connection !== 'online') return T.connection === 'reconnecting' ? 'Reconnecting…' : 'Connecting…';
  const state = T.held ?? T.controller?.state;
  if (!state?.mediaId) return 'Open a video and it plays for both of you';
  if (state.mediaType !== 'youtube') return 'Your partner is playing a file from their computer; open Tandem to watch it';
  if (T.page.kind !== 'watch') return 'Looking around. Pick a video and it plays for both of you';
  const now = serverNow();
  const nameOf = (id) => (id === T.room.you ? 'you' : T.room.members.find((m) => m.id === id)?.name ?? 'your partner');
  if (state.waitingFor.length) return `Waiting for ${state.waitingFor.map(nameOf).join(' and ')} to load…`;
  if (state.isPlaying && state.updatedAt > now + 300) return `Starting in ${Math.ceil((state.updatedAt - now) / 1000)}`;
  if (!isRolling(state, now)) return `Paused at ${clock(state.position)}`;
  const drift = T.controller?.drift();
  if (drift == null || Math.abs(drift) < IN_SYNC) return 'Playing · in sync';
  return `Playing · ${Math.abs(drift).toFixed(1)} s ${drift > 0 ? 'ahead' : 'behind'}, catching up`;
}

/** What the popup shows. */
function status() {
  return {
    connection: T.connection,
    message: T.message,
    server: T.settings?.server ?? null,
    room: T.room && {
      code: T.room.code,
      people: T.room.members.map((m) => ({ name: m.name, online: m.online, you: m.id === T.room.you })),
    },
    partner: T.room ? partnerLine() : '',
    line: statusLine(),
  };
}

// The badge in the corner of the page: room code, partner, and what's happening.
// It sits in its own shadow root so YouTube's styles don't reach it.
let badge = null;

const BADGE_STYLE = `
  :host { all: initial; position: fixed; right: 16px; bottom: 16px; z-index: 2000; }
  .pill { display: flex; align-items: center; gap: 8px; max-width: 420px; padding: 8px 14px;
    background: rgba(14, 14, 18, .94); color: #f5f5f6; border: 1px solid rgba(255, 255, 255, .1);
    border-radius: 999px; box-shadow: 0 6px 20px rgba(0, 0, 0, .35); cursor: pointer;
    font: 500 13px/1.35 Roboto, Arial, sans-serif; user-select: none; }
  .dot { flex: none; width: 8px; height: 8px; border-radius: 50%; background: #a7a7b0; }
  .dot.online { background: #3ddc84; }
  .code { font-weight: 700; letter-spacing: .08em; color: #ffb347; }
  .text { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; color: #d6d6dc; }
  .compact .text { display: none; }
`;

function draw() {
  if (!T.room) {
    badge?.remove();
    badge = null;
    return;
  }
  if (!badge) {
    badge = document.createElement('tandem-badge');
    const shadow = badge.attachShadow({ mode: 'open' });
    shadow.innerHTML = `<style>${BADGE_STYLE}</style>
      <div class="pill" title="Tandem. Click to fold or unfold."><i class="dot"></i><b class="code"></b><span class="text"></span></div>`;
    shadow.querySelector('.pill').addEventListener('click', () => {
      T.compact = !T.compact;
      remember.set('compact', T.compact);
      draw();
    });
    document.body.append(badge);
  }
  const shadow = badge.shadowRoot;
  const partnerHere = T.room.members.some((m) => m.id !== T.room.you && m.online);
  const notice = T.notice && performance.now() < T.notice.until ? T.notice.text : null;
  shadow.querySelector('.pill').classList.toggle('compact', T.compact);
  shadow.querySelector('.dot').classList.toggle('online', T.connection === 'online' && partnerHere);
  shadow.querySelector('.code').textContent = T.room.code;
  const text = notice ?? `${partnerLine()} · ${statusLine()}`;
  const box = shadow.querySelector('.text');
  if (box.textContent !== text) box.textContent = text;
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
    case 'inspect': {
      // For debugging: what the sync logic sees (like Together.inspect() on Tandem's page).
      const c = T.controller;
      return c && {
        serverNow: serverNow(), state: c.state, snapshot: c.snapshot, drift: c.drift(), told: c.told,
        guardFor: c.guardUntil - serverNow(), nudging: c.nudging, page: T.page, held: T.held,
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
document.addEventListener('yt-navigate-finish', step); // notice a new page at once, not up to READ_MS later
// A reload keeps this tab in its room.
const savedRoom = remember.get('room');
if (savedRoom) {
  if (T.page.kind !== 'watch') T.leftVideo = remember.get('leftVideo') ?? undefined;
  enterRoom('room:join', { code: savedRoom }, true);
}
