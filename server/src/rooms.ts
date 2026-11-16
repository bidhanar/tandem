// The rooms that exist right now, kept in memory.

import crypto from 'node:crypto';

import { emptyState, type RoomState } from './room.ts';

export type Member = {
  id: string; // the client's own permanent id
  name: string;
  socketId: string | null; // null while disconnected
  waitingSince: number | null; // when they entered state.waitingFor
};

export type Room = {
  code: string;
  state: RoomState;
  members: Map<string, Member>;
  emptySince: number | null; // when the last person disconnected
  stalledSince: number | null; // when state.waitingFor last went from empty to not
};

export type MemberInfo = { id: string; name: string; online: boolean };

/** Letters and digits that are hard to mix up when read aloud or typed. */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 6;

export function normalizeCode(text: string): string {
  return text.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function memberList(room: Room): MemberInfo[] {
  return [...room.members.values()].map((m) => ({ id: m.id, name: m.name, online: m.socketId !== null }));
}

export class Rooms {
  private readonly rooms = new Map<string, Room>();

  create(now: number): Room {
    let code: string;
    do {
      code = Array.from({ length: CODE_LENGTH }, () => CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)]).join('');
    } while (this.rooms.has(code));
    const room: Room = { code, state: emptyState(now), members: new Map(), emptySince: null, stalledSince: null };
    this.rooms.set(code, room);
    return room;
  }

  get(code: string): Room | undefined {
    return this.rooms.get(normalizeCode(code));
  }

  all(): Room[] {
    return [...this.rooms.values()];
  }

  /** Removes rooms that have been empty for longer than `ttlMs`. */
  removeExpired(now: number, ttlMs: number): void {
    for (const room of this.rooms.values()) {
      if (room.emptySince !== null && now - room.emptySince > ttlMs) this.rooms.delete(room.code);
    }
  }
}
