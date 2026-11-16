// Wires the room rules to Socket.IO. See docs/protocol.md for every message.

import http from 'node:http';

import { Server, type Socket } from 'socket.io';

import { config } from './config.ts';
import { addToQueue, removeFromQueue, restoredQueue, takeFromQueue, type QueueItem } from './queue.ts';
import { addWaiting, applyRequest, removeWaiting, restoredState, type RoomState, type StateRequest } from './room.ts';
import { memberList, Rooms, type Room } from './rooms.ts';

type Reply = (answer: unknown) => void;
/** What we remember about a connection: which room it is in, and as whom. */
type Seat = { code: string; clientId: string };

const text = (value: unknown, maxLength: number) =>
  typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
const isReply = (value: unknown): value is Reply => typeof value === 'function';

export function createSyncServer() {
  const rooms = new Rooms();
  const attempts = new Map<string, number[]>(); // address -> times of recent create/join attempts

  const httpServer = http.createServer((request, response) => {
    // A plain page so a host's health check (and a curious visitor) gets an answer.
    response.writeHead(200, { 'Content-Type': 'text/plain' });
    response.end('Tandem sync server\n');
  });
  // The page is served from each person's own computer (http://127.0.0.1),
  // so any origin may connect. Nothing here relies on cookies.
  const io = new Server(httpServer, { cors: { origin: '*' } });

  const seatOf = (socket: Socket): Seat | undefined => socket.data.seat;
  const roomOf = (socket: Socket): { room: Room; seat: Seat } | undefined => {
    const seat = seatOf(socket);
    const room = seat && rooms.get(seat.code);
    return seat && room ? { room, seat } : undefined;
  };
  const onlineIds = (room: Room) =>
    [...room.members.values()].filter((m) => m.sockets.size > 0).map((m) => m.id);

  /** Stores a new state and tells everyone in the room. */
  function setState(room: Room, state: RoomState, now: number): void {
    if (state === room.state) return;
    const wasWaiting = room.state.waitingFor.length > 0;
    room.state = state;
    for (const member of room.members.values()) {
      const waiting = state.waitingFor.includes(member.id);
      if (!waiting) member.waitingSince = null;
      else member.waitingSince ??= now;
    }
    if (state.waitingFor.length === 0) room.stalledSince = null;
    else if (!wasWaiting) room.stalledSince = now;
    io.to(room.code).emit('state:changed', { state });
  }

  function setQueue(room: Room, queue: QueueItem[]): void {
    if (queue === room.queue) return;
    room.queue = queue;
    io.to(room.code).emit('queue:changed', { queue });
  }

  /** Starts the next queued video (or the given entry). Returns whether there was one. */
  function playFromQueue(room: Room, clientId: string, entryId?: unknown): boolean {
    const { item, queue } = takeFromQueue(room.queue, entryId);
    if (!item) return false;
    const now = Date.now();
    const request: StateRequest = { action: 'load', mediaType: 'youtube', mediaId: item.mediaId, position: 0 };
    const state = applyRequest(room.state, request, clientId, onlineIds(room), now);
    if (state) setState(room, state, now);
    setQueue(room, queue);
    return true;
  }

  /** A member is ready again, left, or took too long. */
  function stopWaitingFor(room: Room, clientId: string, now: number): void {
    const longStall = room.stalledSince !== null && now - room.stalledSince >= config.countdownAfterStallMs;
    const delay = longStall && room.state.isPlaying ? config.countdownMs : 0;
    setState(room, removeWaiting(room.state, clientId, now, delay), now);
  }

  function allowed(socket: Socket, now: number): boolean {
    const address = socket.handshake.address;
    const recent = (attempts.get(address) ?? []).filter((time) => now - time < 60_000);
    recent.push(now);
    attempts.set(address, recent);
    return recent.length <= config.joinAttemptsPerMinute;
  }

  /** The connection stops being in its room. `forget` also gives up the seat. */
  function leave(socket: Socket, forget: boolean): void {
    const found = roomOf(socket);
    socket.data.seat = undefined;
    if (!found) return;
    const { room, seat } = found;
    const member = room.members.get(seat.clientId);
    if (!member) return;
    const now = Date.now();
    socket.leave(room.code);
    member.sockets.delete(socket.id);

    if (forget) {
      // Leaving on purpose takes the person's other connections out too.
      for (const id of member.sockets) {
        const other = io.sockets.sockets.get(id);
        if (other) {
          other.data.seat = undefined;
          other.leave(room.code);
        }
      }
      member.sockets.clear();
      room.members.delete(member.id);
    }
    if (member.sockets.size > 0) return; // still here through another connection

    stopWaitingFor(room, member.id, now);
    io.to(room.code).emit('member:left', { members: memberList(room) });
    if (onlineIds(room).length === 0) room.emptySince = now;
  }

  function join(socket: Socket, room: Room, payload: any, reply: Reply): void {
    const clientId = text(payload?.clientId, 64);
    if (clientId.length < 8) return reply({ ok: false, error: 'Bad request.' });
    const name = text(payload?.name, config.maxNameLength) || 'Guest';
    const now = Date.now();

    const existing = room.members.get(clientId);
    if (!existing && room.members.size >= config.maxMembers) {
      return reply({ ok: false, error: 'This room is full.' });
    }
    // A connection is in one room at a time.
    if (seatOf(socket)?.code !== room.code || seatOf(socket)?.clientId !== clientId) leave(socket, true);

    // The same person may hold several connections (their page and their
    // local program); they share one seat.
    const member = existing ?? { id: clientId, name, sockets: new Set<string>(), waitingSince: null };
    const arrived = member.sockets.size === 0; // new, or back from being offline
    member.name = name;
    member.sockets.add(socket.id);
    room.members.set(clientId, member);
    room.emptySince = null;
    socket.data.seat = { code: room.code, clientId } satisfies Seat;
    socket.join(room.code);

    // With something loaded, someone arriving has to load it too before anyone moves on.
    if (arrived && room.state.mediaId !== null) setState(room, addWaiting(room.state, clientId, now), now);

    const members = memberList(room);
    reply({ ok: true, room: { code: room.code, state: room.state, queue: room.queue, members, you: clientId } });
    if (arrived) socket.to(room.code).emit('member:joined', { members });
  }

  io.on('connection', (socket) => {
    socket.on('time:ping', (payload: any, reply: unknown) => {
      if (isReply(reply)) reply({ t0: payload?.t0, serverTime: Date.now() });
    });

    socket.on('room:create', (payload: unknown, reply: unknown) => {
      if (!isReply(reply)) return;
      const now = Date.now();
      if (!allowed(socket, now)) return reply({ ok: false, error: 'Too many attempts. Wait a minute and try again.' });
      join(socket, rooms.create(now), payload, reply);
    });

    socket.on('room:join', (payload: any, reply: unknown) => {
      if (!isReply(reply)) return;
      if (!allowed(socket, Date.now())) return reply({ ok: false, error: 'Too many attempts. Wait a minute and try again.' });
      const code = text(payload?.code, 20);
      let room = rooms.get(code);
      // Someone who was in the room is coming back after the server restarted:
      // rebuild it from what they remember.
      if (!room && payload?.restore && typeof payload.restore === 'object') {
        const now = Date.now();
        room = rooms.restore(code, restoredState(payload.restore, now), restoredQueue(payload.restore.queue));
      }
      if (!room) return reply({ ok: false, error: 'No room with that code. Check it with your partner.' });
      join(socket, room, payload, reply);
    });

    socket.on('room:leave', () => leave(socket, true));
    socket.on('disconnect', () => leave(socket, false));

    socket.on('state:request', (request: StateRequest) => {
      const found = roomOf(socket);
      if (!found) return;
      const now = Date.now();
      const state = applyRequest(found.room.state, request, found.seat.clientId, onlineIds(found.room), now);
      if (state) setState(found.room, state, now);
    });

    socket.on('buffer:start', () => {
      const found = roomOf(socket);
      if (!found || found.room.state.mediaId === null) return;
      const now = Date.now();
      setState(found.room, addWaiting(found.room.state, found.seat.clientId, now), now);
    });

    socket.on('buffer:end', () => {
      const found = roomOf(socket);
      if (found) stopWaitingFor(found.room, found.seat.clientId, Date.now());
    });

    socket.on('queue:add', (payload: any) => {
      const found = roomOf(socket);
      if (!found) return;
      setQueue(found.room, addToQueue(found.room.queue, payload?.mediaIds, found.seat.clientId));
      // With nothing loaded yet, the first one starts straight away.
      if (found.room.state.mediaId === null) playFromQueue(found.room, found.seat.clientId);
    });

    socket.on('queue:remove', (payload: any) => {
      const found = roomOf(socket);
      if (found) setQueue(found.room, removeFromQueue(found.room.queue, payload?.id));
    });

    socket.on('queue:clear', () => {
      const found = roomOf(socket);
      if (found && found.room.queue.length > 0) setQueue(found.room, []);
    });

    // Play a queued video now, ahead of its turn.
    socket.on('queue:play', (payload: any) => {
      const found = roomOf(socket);
      if (found && typeof payload?.id === 'string') playFromQueue(found.room, found.seat.clientId, payload.id);
    });

    // A video finished on someone's device. Everyone reports this, so it
    // only counts while that video is still the room's current one.
    socket.on('media:ended', (payload: any) => {
      const found = roomOf(socket);
      if (!found || found.room.state.mediaId === null || payload?.mediaId !== found.room.state.mediaId) return;
      playFromQueue(found.room, found.seat.clientId);
    });

    socket.on('chat:send', (payload: any) => {
      const found = roomOf(socket);
      const message = text(payload?.text, config.maxChatLength);
      if (!found || !message) return;
      const name = found.room.members.get(found.seat.clientId)?.name ?? 'Guest';
      io.to(found.room.code).emit('chat:message', { from: found.seat.clientId, name, text: message, at: Date.now() });
    });

    socket.on('reaction:send', (payload: any) => {
      const found = roomOf(socket);
      const emoji = text(payload?.emoji, 16);
      if (found && emoji) io.to(found.room.code).emit('reaction', { from: found.seat.clientId, emoji });
    });
  });

  // Once a second: stop waiting for anyone who has taken too long, and
  // forget rooms that have stayed empty.
  const housekeeping = setInterval(() => {
    const now = Date.now();
    for (const room of rooms.all()) {
      for (const member of room.members.values()) {
        if (member.waitingSince !== null && now - member.waitingSince > config.waitTimeoutMs) {
          stopWaitingFor(room, member.id, now);
        }
      }
    }
    rooms.removeExpired(now, config.emptyRoomTtlMs);
  }, 1000);

  const close = () => {
    clearInterval(housekeeping);
    return io.close();
  };
  return { httpServer, io, rooms, close };
}
