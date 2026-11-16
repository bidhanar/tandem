// The shared playback state of a room and the rules for changing it. Pure
// functions: no clocks, sockets or timers in here, so every rule is testable.

export type MediaType = 'youtube' | 'local';

/** The single source of truth for what a room is playing. */
export type RoomState = {
  mediaType: MediaType | null;
  mediaId: string | null; // YouTube video id, or a file fingerprint for local files
  mediaTitle: string | null;
  /** What the people in the room asked for: playing or paused. */
  isPlaying: boolean;
  /** Seconds into the media at the moment of `updatedAt`. */
  position: number;
  playbackRate: number;
  /** Server time in ms. Can be slightly in the future: playback starts then. */
  updatedAt: number;
  /** Goes up by one on every change. Clients ignore anything older than they have. */
  version: number;
  updatedBy: string; // client id
  /**
   * Members who are loading or buffering. While anyone is listed the room
   * holds still at `position`, whatever `isPlaying` says.
   */
  waitingFor: string[];
};

export type StateRequest = {
  action: 'play' | 'pause' | 'seek' | 'load';
  position?: number;
  mediaType?: MediaType;
  mediaId?: string;
  mediaTitle?: string;
};

export function emptyState(now: number): RoomState {
  return {
    mediaType: null, mediaId: null, mediaTitle: null, isPlaying: false, position: 0,
    playbackRate: 1, updatedAt: now, version: 0, updatedBy: '', waitingFor: [],
  };
}

/** Whether the media is actually moving right now. */
export function isRolling(state: RoomState, now: number): boolean {
  return state.isPlaying && state.waitingFor.length === 0 && now >= state.updatedAt;
}

/** Where playback should be at server time `now`. */
export function expectedPosition(state: RoomState, now: number): number {
  if (!isRolling(state, now)) return state.position;
  return state.position + ((now - state.updatedAt) / 1000) * state.playbackRate;
}

const validPosition = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;

/**
 * Applies one person's request. Last write wins. Returns the new state, or
 * null if the request makes no sense (and is ignored).
 *
 * `members` is everyone in the room; after a load, each of them has to
 * report ready before playback starts.
 */
export function applyRequest(
  state: RoomState, request: StateRequest, clientId: string, members: string[], now: number,
): RoomState | null {
  if (request === null || typeof request !== 'object') return null;
  if (request.position !== undefined && !validPosition(request.position)) return null;
  const stamp = { updatedAt: now, version: state.version + 1, updatedBy: clientId };

  if (request.action === 'load') {
    if (request.mediaType !== 'youtube' && request.mediaType !== 'local') return null;
    if (typeof request.mediaId !== 'string' || request.mediaId === '' || request.mediaId.length > 200) return null;
    const title = typeof request.mediaTitle === 'string' ? request.mediaTitle.slice(0, 300) : null;
    return {
      ...state, ...stamp,
      mediaType: request.mediaType, mediaId: request.mediaId, mediaTitle: title,
      isPlaying: true, position: request.position ?? 0, playbackRate: 1,
      waitingFor: [...members],
    };
  }

  if (state.mediaId === null) return null; // nothing loaded to play, pause or seek
  const position = request.position ?? expectedPosition(state, now);
  switch (request.action) {
    case 'play': return { ...state, ...stamp, isPlaying: true, position };
    case 'pause': return { ...state, ...stamp, isPlaying: false, position };
    case 'seek':
      if (request.position === undefined) return null;
      return { ...state, ...stamp, position };
    default: return null;
  }
}

/** Someone started loading or buffering: hold the room at the current position. */
export function addWaiting(state: RoomState, clientId: string, now: number): RoomState {
  if (state.waitingFor.includes(clientId)) return state;
  return {
    ...state,
    position: expectedPosition(state, now),
    updatedAt: now,
    version: state.version + 1,
    updatedBy: clientId,
    waitingFor: [...state.waitingFor, clientId],
  };
}

/**
 * Someone is ready again (or left). When the last one is, playback resumes
 * `resumeDelayMs` from now, which gives the page time to show a countdown.
 */
export function removeWaiting(state: RoomState, clientId: string, now: number, resumeDelayMs: number): RoomState {
  if (!state.waitingFor.includes(clientId)) return state;
  const waitingFor = state.waitingFor.filter((id) => id !== clientId);
  return {
    ...state,
    updatedAt: waitingFor.length === 0 ? now + resumeDelayMs : state.updatedAt,
    version: state.version + 1,
    updatedBy: clientId,
    waitingFor,
  };
}

/**
 * A room rebuilt after the server restarted (free hosts restart and sleep
 * often, and rooms live only in memory). A client that was in the room sends
 * what it last knew; anything that doesn't check out is dropped. Playback
 * continues from `position` as of `now`, and the version starts again.
 */
export function restoredState(info: unknown, now: number): RoomState {
  const state = emptyState(now);
  if (info === null || typeof info !== 'object') return state;
  const i = info as Record<string, unknown>;
  if ((i.mediaType !== 'youtube' && i.mediaType !== 'local') || typeof i.mediaId !== 'string'
    || i.mediaId === '' || i.mediaId.length > 200) return state;
  return {
    ...state,
    mediaType: i.mediaType,
    mediaId: i.mediaId,
    mediaTitle: typeof i.mediaTitle === 'string' ? i.mediaTitle.slice(0, 300) : null,
    isPlaying: i.isPlaying === true,
    position: validPosition(i.position) ? i.position : 0,
    version: 1,
  };
}
