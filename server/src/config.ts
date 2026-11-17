/** Server settings. Each can be overridden with an environment variable. */

const number = (name: string, fallback: number) => {
  const value = Number(process.env[name]);
  return process.env[name] !== undefined && Number.isFinite(value) ? value : fallback;
};

export const config = {
  port: number('PORT', 8686),

  /** People allowed in one room. */
  maxMembers: number('MAX_MEMBERS', 2),

  /** An empty room is kept this long so both people can reconnect to it. */
  emptyRoomTtlMs: number('EMPTY_ROOM_TTL_MS', 10 * 60_000),

  /** Someone who is still loading after this long no longer holds the room up. */
  waitTimeoutMs: number('WAIT_TIMEOUT_MS', 15_000),

  /** After a stall at least this long, playback resumes with a countdown... */
  countdownAfterStallMs: number('COUNTDOWN_AFTER_STALL_MS', 2_000),
  /** ...of this length. Shorter stalls resume at once. */
  countdownMs: number('COUNTDOWN_MS', 3_000),

  /** Room create/join attempts allowed per address per minute. */
  joinAttemptsPerMinute: number('JOIN_ATTEMPTS_PER_MINUTE', 20),

  maxChatLength: 500,
  maxPagePathLength: 2000,
  maxNameLength: 24,
};
