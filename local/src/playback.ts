// Ported from Synaxis (src/playback_manager.cpp), GPL-3.0-or-later,
// Copyright (C) 2026 Azhar Tanweer.

import { VlcSession, type PlaylistItem, type VlcOptions, type VlcStatus } from './vlc.ts';
import type { WatchState } from './watchState.ts';

export type NowPlaying = {
  profile: string;
  file_id: string;
  title: string;
  position: number;
  duration: number;
  paused: boolean;
};

/** How long to wait for VLC to jump to the resume point before trusting its positions. */
const SEEK_GRACE_MS = 15_000;
const POLL_MS = 1000;

type Session = {
  vlc: VlcSession;
  profileId: string;
  currentFile: string; // last file seen playing
  started: number; // Date.now() at launch
  reachedStart: boolean; // the first item has jumped to its resume point
};

/**
 * Runs one VLC window at a time and records the viewer's progress from it,
 * so resume points and "watched" marks stay current.
 */
export class Playback {
  private readonly watch: WatchState;
  private session: Session | null = null;
  private now: NowPlaying | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(watch: WatchState) {
    this.watch = watch;
  }

  /** Starts VLC for a profile, closing any window already open. */
  async play(profileId: string, playlist: PlaylistItem[], options: VlcOptions): Promise<void> {
    this.stop();
    const vlc = await VlcSession.launch(options, playlist);
    const first = playlist[0]!;
    this.session = { vlc, profileId, currentFile: '', started: Date.now(), reachedStart: false };
    this.now = { profile: profileId, file_id: first.fileId, title: first.title, position: first.start, duration: 0, paused: false };
    this.timer = setInterval(() => void this.follow(), POLL_MS);
  }

  stop(): void {
    this.session?.vlc.terminate();
    this.clear();
  }

  nowPlaying(): NowPlaying | null {
    return this.now;
  }

  private clear(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.session = null;
    this.now = null;
    this.watch.flush();
  }

  private async follow(): Promise<void> {
    const session = this.session;
    if (!session) return;
    const running = session.vlc.running();
    const status = running ? await session.vlc.poll() : null;
    if (this.session !== session) return; // replaced while we were asking
    if (status) this.track(session, status);
    if (!running) this.clear();
  }

  private track(session: Session, status: VlcStatus): void {
    const item = session.vlc.currentItem(status);
    if (!item || status.state === 'stopped') return;
    this.now = {
      profile: session.profileId,
      file_id: item.fileId,
      title: item.title,
      position: status.position,
      duration: status.duration,
      paused: status.state === 'paused',
    };
    if (status.duration <= 0) return;

    // VLC reports 0:00 until it has jumped to the resume point; recording
    // that would wipe out the very position we're resuming from.
    if (item === session.vlc.playlist[0] && item.start > 0 && !session.reachedStart) {
      const jumped = status.position + 5 >= item.start;
      if (!jumped && Date.now() - session.started < SEEK_GRACE_MS) return;
      session.reachedStart = true;
    }

    const now = Math.floor(Date.now() / 1000);
    if (item.fileId !== session.currentFile) {
      session.currentFile = item.fileId;
      this.watch.recordStart(session.profileId, item.fileId, now);
    }
    this.watch.recordPosition(session.profileId, item.fileId, status.position, status.duration, now);
  }
}
