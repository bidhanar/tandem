/**
 * VLC only updates the position it reports every quarter to half a second,
 * so a single reading can be half a second old. This turns those steps into
 * a smooth, current position: each time the reported value changes we know
 * the position at (about) that moment, and we count forward from there.
 */
export class PositionEstimator {
  private readonly pollMs: number;
  private lastRaw: number | null = null;
  private anchorValue = 0;
  private anchorAt = 0;

  /** If VLC says "playing" but the value hasn't moved for this long, it is stuck. */
  static readonly STALL_MS = 1200;

  /** @param pollMs how often update() is called */
  constructor(pollMs: number) {
    this.pollMs = pollMs;
  }

  reset(): void {
    this.lastRaw = null;
  }

  /**
   * @param raw      the position VLC reported, in seconds
   * @param playing  whether VLC says it is playing
   * @param rate     playback speed
   * @param now      a clock in ms
   * @returns the estimated position now, and whether playback looks stuck
   */
  update(raw: number, playing: boolean, rate: number, now: number): { position: number; stalled: boolean } {
    if (this.lastRaw === null || raw !== this.lastRaw) {
      this.lastRaw = raw;
      this.anchorValue = raw;
      // The value changed some time since the last poll: on average, half a poll ago.
      this.anchorAt = now - this.pollMs / 2;
    }
    if (!playing) {
      this.anchorAt = now; // paused: the value is simply where we are
      return { position: raw, stalled: false };
    }
    const sinceChange = now - this.anchorAt;
    if (sinceChange > PositionEstimator.STALL_MS) return { position: this.anchorValue, stalled: true };
    return { position: this.anchorValue + (sinceChange / 1000) * rate, stalled: false };
  }
}
