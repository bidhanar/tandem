// Two simulated people in one room, end to end: the real server, real
// Socket.IO connections and the page's real sync logic, each driving a
// pretend player. Checks that they stay together and that one action by one
// person changes the room exactly once.
//
//   npm run simulate        (takes about 30 seconds)

import { io } from 'socket.io-client';

import { createSyncServer } from '../dist/src/app.js';
import { SYNC_CONFIG } from '../../web/sync-config.js';
import { bestOffset, restoreInfo, SyncController } from '../../web/sync-core.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A player that advances with the real clock and takes a moment to load. */
class PretendPlayer {
  constructor(loadMs) {
    this.loadMs = loadMs;
    this.mediaId = null;
    this.status = 'idle';
    this.position = 0;
    this.rate = 1;
    this.readAt = performance.now();
  }
  settle() {
    const now = performance.now();
    if (this.status === 'playing') this.position += ((now - this.readAt) / 1000) * this.rate;
    this.readAt = now;
  }
  load(state, position) {
    this.settle();
    Object.assign(this, { mediaId: state.mediaId, position, status: 'buffering' });
    setTimeout(() => { this.settle(); this.status = 'playing'; }, this.loadMs);
  }
  play() { this.settle(); this.status = 'playing'; }
  pause() { this.settle(); this.status = 'paused'; }
  seek(seconds) { this.settle(); this.position = seconds; }
  setRate(rate) { this.settle(); this.rate = rate; }
  read() {
    this.settle();
    return { mediaId: this.mediaId, status: this.status, position: this.position, rate: this.rate };
  }
}

async function person(name, url, loadMs) {
  const socket = io(url, { transports: ['websocket'] });
  await new Promise((resolve) => socket.once('connect', resolve));
  const ask = (event, payload) => new Promise((resolve) => socket.emit(event, payload, resolve));

  const samples = [];
  for (let i = 0; i < SYNC_CONFIG.clockSamples; i++) {
    const t0 = performance.now();
    const { serverTime } = await ask('time:ping', { t0 });
    samples.push({ t0, t1: performance.now(), serverTime });
  }
  const offset = bestOffset(samples);

  const me = { name, socket, ask, player: new PretendPlayer(loadMs), changes: 0, id: `sim-${name}-12345678` };
  // TANDEM_TRACE=1 prints every command to the players and every message sent.
  const trace = (...parts) => { if (process.env.TANDEM_TRACE) console.log(`  [${(performance.now() / 1000).toFixed(2)}] ${name}:`, ...parts); };
  for (const command of ['load', 'play', 'pause', 'seek', 'setRate']) {
    const original = me.player[command].bind(me.player);
    me.player[command] = (...args) => { trace('player', command, ...args.map((a) => (typeof a === 'number' ? a.toFixed(2) : a.mediaId))); return original(...args); };
  }
  me.controller = new SyncController({
    player: me.player, clientId: me.id, mode: 'youtube',
    now: () => performance.now() + offset,
    send: (event, payload) => { trace('sends', event, JSON.stringify(payload ?? '')); socket.emit(event, payload); },
  });
  socket.on('state:changed', ({ state }) => {
    me.changes += 1;
    me.controller.onRemoteState(state);
  });
  me.timers = [
    setInterval(() => me.controller.onSnapshot(me.player.read()), 250),
    setInterval(() => me.controller.tick(), SYNC_CONFIG.tickMs),
  ];
  me.enter = async (event, payload) => {
    const answer = await ask(event, { ...payload, clientId: me.id, name });
    if (answer.ok) {
      me.code = answer.room.code;
      me.controller.onRemoteState(answer.room.state);
    }
    return answer;
  };
  // Like the page: after a dropped connection, rejoin and bring what we know.
  me.autoRejoin = false;
  socket.on('connect', async () => {
    if (!me.autoRejoin) return;
    const restore = restoreInfo(me.controller.state, [], performance.now() + offset);
    me.controller.state = null;
    me.rejoined = await me.enter('room:join', { code: me.code, restore });
  });
  return me;
}

let failures = 0;
function check(label, ok, detail = '') {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
}

let server = createSyncServer();
await new Promise((resolve) => server.httpServer.listen(0, resolve));
const url = `http://127.0.0.1:${server.httpServer.address().port}`;

const ana = await person('Ana', url, 300);
const ben = await person('Ben', url, 900); // Ben's connection loads videos more slowly
const apart = () => Math.abs(ana.player.read().position - ben.player.read().position);
const both = (status) => ana.player.read().status === status && ben.player.read().status === status;
/** Runs `action`, waits, and returns how many times the room changed. */
async function changesDuring(action, waitMs = 2500) {
  const before = ana.changes;
  action();
  await sleep(waitMs);
  return ana.changes - before;
}

const created = await ana.enter('room:create', {});
check('Ana creates a room with a 6-character code', created.ok && /^[A-Z2-9]{6}$/.test(created.room.code), created.room?.code);
const wrong = await ben.enter('room:join', { code: 'ZZZZZZ' });
check('a wrong code is refused', wrong.ok === false);
const joined = await ben.enter('room:join', { code: created.room.code.toLowerCase() });
check('Ben joins with the code (typed in lowercase)', joined.ok && joined.room.members.length === 2);
const cara = await person('Cara', url, 300);
check('a third person is told the room is full', (await cara.enter('room:join', { code: created.room.code })).ok === false);

ana.socket.emit('state:request', { action: 'load', mediaType: 'youtube', mediaId: 'video-1', position: 0 });
await sleep(700);
check('while Ben is still loading, Ana is held at the start', ana.player.read().position < 0.6 && !both('playing'));
await sleep(3300);
check('both play once both have loaded', both('playing'));
check('they are within 0.5 s of each other', apart() < 0.5, `${apart().toFixed(2)} s apart`);

let n = await changesDuring(() => ana.player.pause());
check('Ana pauses: the room changes exactly once', n === 1, `${n} change(s)`);
check('...and Ben is paused at the same place', both('paused') && apart() < 0.3, `${apart().toFixed(2)} s apart`);

n = await changesDuring(() => ben.player.play());
check('Ben plays: the room changes exactly once', n === 1, `${n} change(s)`);
check('...and both are playing', both('playing') && apart() < 0.5, `${apart().toFixed(2)} s apart`);

n = await changesDuring(() => ben.player.seek(600));
check('Ben seeks to 10:00: the room changes exactly once', n === 1, `${n} change(s)`);
check('...and Ana follows', ana.player.read().position > 600 && apart() < 0.5, `${apart().toFixed(2)} s apart`);

ben.player.status = 'buffering'; // Ben's video stalls, for long enough to earn a countdown
await sleep(4000);
check("Ben's video stalls: Ana is paused to wait", ana.player.read().status === 'paused');
const held = ana.player.read().position;
ben.player.status = 'playing';
await sleep(1500);
check('...there is a countdown before restarting', ana.player.read().status === 'paused' && ana.player.read().position === held);
await sleep(3000);
check('...then both carry on together', both('playing') && apart() < 0.5, `${apart().toFixed(2)} s apart`);

ana.player.position -= 2; // Ana's player silently falls behind
await sleep(5000);
check('drift is corrected', apart() < 0.5, `${apart().toFixed(2)} s apart`);

const before = ben.changes;
ana.socket.disconnect();
await sleep(1200);
check('Ana drops out: Ben keeps playing', ben.player.read().status === 'playing' && ben.changes === before);
ana.socket.connect();
await new Promise((resolve) => ana.socket.once('connect', resolve));
ana.player = new PretendPlayer(300); // as if the page was reloaded
ana.controller.player = ana.player;
ana.controller.snapshot = null;
ana.controller.lastSteady = null;
ana.controller.state = null;
ana.controller.loadingId = null;
await ana.enter('room:join', { code: created.room.code });
await sleep(4000);
check('Ana rejoins and snaps to where Ben is', both('playing') && apart() < 0.5, `${apart().toFixed(2)} s apart`);

// The server restarts (free hosts do this) and forgets every room.
ana.autoRejoin = true;
ben.autoRejoin = true;
const beforeRestart = ben.player.read().position;
const port = server.httpServer.address().port;
await server.close();
server = createSyncServer();
await new Promise((resolve) => server.httpServer.listen(port, resolve));
await sleep(9000);
check('after a server restart both are back in the same room', ana.rejoined?.ok && ben.rejoined?.ok
  && ana.rejoined.room.code === created.room.code && ben.rejoined.room.code === created.room.code
  && server.rooms.get(created.room.code)?.members.size === 2);
check('...and carry on from where they were, together', both('playing') && apart() < 0.5
  && ben.player.read().position > beforeRestart, `${apart().toFixed(2)} s apart`);

for (const p of [ana, ben, cara]) {
  p.timers.forEach(clearInterval);
  p.socket.disconnect();
}
await server.close();
console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
