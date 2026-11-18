// The rooms that exist right now, kept in memory.

import crypto from 'node:crypto';

import type { QueueItem } from './queue.ts';
import { emptyState, type RoomState } from './room.ts';

export type Member = {
  id: string; // the client's own permanent id
  name: string;
  /**
   * This person's live connections. Usually two: their page, and their local
   * program (which drives VLC). Empty while they are disconnected.
   */
  sockets: Set<string>;
  waitingSince: number | null; // when they entered state.waitingFor
  /** They said they're away from the screen (AFK). The room pauses if its options say so. */
  away: boolean;
  /** When their last connection went, until the room has paused for it (or they're back). */
  offlineSince: number | null;
};

/** Choices anyone in the room can change; they apply to everyone. */
export type RoomOptions = {
  /** Pause for everyone when someone steps away, goes offline or leaves. */
  pauseOnAway: boolean;
};

export const defaultOptions = (): RoomOptions => ({ pauseOnAway: true });

/** Options as sent by a client (for `restore`), with anything odd replaced by the default. */
export function cleanOptions(value: unknown): RoomOptions {
  const options = defaultOptions();
  const v = value as Record<string, unknown> | null;
  if (v && typeof v === 'object' && typeof v.pauseOnAway === 'boolean') options.pauseOnAway = v.pauseOnAway;
  return options;
}

export type Room = {
  code: string;
  state: RoomState;
  queue: QueueItem[]; // YouTube videos lined up to play next
  options: RoomOptions;
  members: Map<string, Member>;
  emptySince: number | null; // when the last person disconnected
  stalledSince: number | null; // when state.waitingFor last went from empty to not
};

export type MemberInfo = { id: string; name: string; online: boolean; away: boolean };

/** Letters and digits that are hard to mix up when read aloud or typed. */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 6;
const CODE_PATTERN = new RegExp(`^[${CODE_ALPHABET}]{${CODE_LENGTH}}$`);

export function normalizeCode(text: string): string {
  return text.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function memberList(room: Room): MemberInfo[] {
  return [...room.members.values()].map((m) => ({ id: m.id, name: m.name, online: m.sockets.size > 0, away: m.away }));
}

export class Rooms {
  private readonly rooms = new Map<string, Room>();

  /**
   * Brings back a room under its old code, if the code could be one of ours
   * and no room holds it now. Returns the room with that code either way, or
   * undefined for a code we would never have made.
   */
  restore(code: string, state: RoomState, queue: QueueItem[], options = defaultOptions()): Room | undefined {
    const normalized = normalizeCode(code);
    const existing = this.rooms.get(normalized);
    if (existing) return existing;
    if (!CODE_PATTERN.test(normalized)) return undefined;
    const room: Room = { code: normalized, state, queue, options, members: new Map(), emptySince: null, stalledSince: null };
    this.rooms.set(normalized, room);
    return room;
  }

  create(now: number): Room {
    let code: string;
    do {
      code = Array.from({ length: CODE_LENGTH }, () => CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)]).join('');
    } while (this.rooms.has(code));
    const room: Room = {
      code, state: emptyState(now), queue: [], options: defaultOptions(), members: new Map(), emptySince: null, stalledSince: null,
    };
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
