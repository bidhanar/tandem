// Watching a local file together: keeps this computer's VLC in step with the room.
//
// The page holds its own connection to the sync server (for the room's
// people, chat and the YouTube player). This is a second connection for the
// same person, made by the local program, because it is the one that can
// drive VLC, and it keeps working while the browser tab is in the background.
// The sync rules themselves are web/sync-core.js, shared with the page.

import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { io, type Socket } from 'socket.io-client';

import type { VideoFile } from './catalog.ts';
import type { AppConfig } from './config.ts';
import { findMatch, mediaIdOf, parseMediaId } from './fingerprint.ts';
import type { Library } from './library.ts';
import { WEB_DIR } from './paths.ts';
import type { Playback } from './playback.ts';
import { PositionEstimator } from './positionEstimator.ts';
import type { VlcSession, VlcStatus } from './vlc.ts';

/** How often VLC is asked where it is. */
const POLL_MS = 100;
const SNAPSHOT_MS = 250;
const TICK_MS = 500;
const CLOCK_SAMPLES = 8;
const CLOCK_RESYNC_MS = 60_000;

/** The parts of web/sync-core.js used here. */
type SyncCore = {
  SyncController: new (options: Record<string, unknown>) => {
    state: RoomState | null;
    onRemoteState(state: RoomState): void;
    onSnapshot(reading: Reading): void;
    tick(): void;
    drift(): number | null;
  };
  bestOffset(samples: { t0: number; t1: number; serverTime: number }[]): number;
  expectedPosition(state: RoomState, now: number): number;
};
type RoomState = {
  mediaType: 'youtube' | 'local' | null;
  mediaId: string | null;
  mediaTitle: string | null;
  isPlaying: boolean;
  version: number;
};
type Reading = { mediaId: string | null; status: 'playing' | 'paused' | 'buffering' | 'idle'; position: number; rate: number };

const IDLE: Reading = { mediaId: null, status: 'idle', position: 0, rate: 1 };

export type JoinDetails = { server: string; code: string; clientId: string; name: string; profile: string };

/** What the page shows about the local file the room is playing. */
type LocalView = {
  /**
   * idle: the room isn't playing a local file. looking: searching the library.
   * playing: open in VLC. missing: not in this library. closed: VLC was closed.
   * error: VLC couldn't start.
   */
  phase: 'idle' | 'looking' | 'playing' | 'missing' | 'closed' | 'error';
  message?: string;
  file?: VideoFile;
  alternatives?: VideoFile[];
};

export class RoomClient {
  private readonly library: Library;
  private readonly playback: Playback;
  private readonly getConfig: () => AppConfig;

  private details: JoinDetails | null = null;
  private socket: Socket | null = null;
  private connection: 'offline' | 'connecting' | 'online' | 'reconnecting' = 'offline';
  private clockOffset = 0; // server time minus performance.now()
  private core: SyncCore | null = null;
  private controller: InstanceType<SyncCore['SyncController']> | null = null;
  private timers: NodeJS.Timeout[] = [];

  private vlc: VlcSession | null = null; // the VLC we opened for the room
  private openMediaId: string | null = null; // the room media that VLC is playing
  private dismissed: string | null = null; // room media whose VLC window the person closed
  private readonly accepted = new Map<string, string>(); // room media -> the other copy the person chose to play
  private lastStatus: VlcStatus | null = null;
  private reading: Reading = IDLE;
  private polling = false;
  private readonly estimator = new PositionEstimator(POLL_MS);
  private view: LocalView = { phase: 'idle' };

  constructor(library: Library, playback: Playback, getConfig: () => AppConfig) {
    this.library = library;
    this.playback = playback;
    this.getConfig = getConfig;
  }

  private serverNow = () => performance.now() + this.clockOffset;

  // ---------- Joining and leaving ----------

  /** Follow the room the page has joined. Calling it again for the same room changes nothing. */
  async join(details: JoinDetails): Promise<void> {
    const same = this.details && this.details.code === details.code && this.details.server === details.server
      && this.details.clientId === details.clientId;
    if (same) {
      this.details = details; // the profile or name may have changed
      return;
    }
    this.leave();
    this.details = details;
    this.connection = 'connecting';
    this.core ??= (await import(pathToFileURL(path.join(WEB_DIR, 'sync-core.js')).href)) as SyncCore;
    if (this.details !== details) return; // left again while loading

    const socket = io(details.server, { transports: ['websocket', 'polling'] });
    this.socket = socket;
    this.controller = new this.core.SyncController({
      player: this.player,
      clientId: details.clientId,
      mode: 'local',
      now: this.serverNow,
      send: (event: string, payload?: unknown) => socket.emit(event, payload),
    });

    socket.on('connect', async () => {
      await this.syncClock(socket);
      const answer = await this.ask(socket, 'room:join', { code: details.code, clientId: details.clientId, name: details.name });
      if (this.socket !== socket) return;
      if (!answer?.ok) return this.leave(); // the room is gone
      this.connection = 'online';
      if (this.controller) this.controller.state = null; // start afresh after a reconnect
      this.controller?.onRemoteState(answer.room.state);
    });
    socket.on('disconnect', () => { this.connection = 'reconnecting'; });
    socket.on('state:changed', ({ state }: { state: RoomState }) => this.controller?.onRemoteState(state));

    this.timers = [
      setInterval(() => void this.poll(), POLL_MS),
      setInterval(() => this.controller?.onSnapshot(this.reading), SNAPSHOT_MS),
      setInterval(() => this.controller?.tick(), TICK_MS),
      setInterval(() => { if (socket.connected) void this.syncClock(socket); }, CLOCK_RESYNC_MS),
    ];
  }

  leave(): void {
    this.timers.splice(0).forEach(clearInterval);
    this.socket?.disconnect();
    this.socket = null;
    this.controller = null;
    this.details = null;
    this.connection = 'offline';
    this.closeOurVlc();
    this.dismissed = null;
    this.view = { phase: 'idle' };
  }

  private ask(socket: Socket, event: string, payload: unknown): Promise<any> {
    return socket.timeout(5000).emitWithAck(event, payload).catch(() => null);
  }

  private async syncClock(socket: Socket): Promise<void> {
    const samples = [];
    for (let i = 0; i < CLOCK_SAMPLES; i++) {
      const t0 = performance.now();
      const answer = await this.ask(socket, 'time:ping', { t0 });
      if (answer) samples.push({ t0, t1: performance.now(), serverTime: answer.serverTime as number });
    }
    if (samples.length > 0 && this.core) this.clockOffset = this.core.bestOffset(samples);
  }

  // ---------- What the page asks for ----------

  joined(): boolean {
    return this.details !== null;
  }

  /** Start a file from this library for everyone in the room. */
  async playForBoth(profile: string, file: VideoFile, title: string, start: number): Promise<void> {
    if (!this.socket?.connected || !this.details) throw new Error('Not connected to the room yet. Try again in a moment.');
    this.details.profile = profile;
    const mediaId = await mediaIdOf(file);
    this.dismissed = null;
    this.socket.emit('state:request', { action: 'load', mediaType: 'local', mediaId, mediaTitle: title, position: start });
  }

  /** Play a different copy of what the room is playing (the person accepted the warning). */
  async useFile(file: VideoFile): Promise<void> {
    const state = this.controller?.state;
    if (!state?.mediaId || state.mediaType !== 'local') throw new Error("The room isn't playing a local file.");
    this.accepted.set(state.mediaId, file.id);
    this.dismissed = null;
    await this.open(file, state);
  }

  /** Open the room's file again after its VLC window was closed. */
  reopen(): void {
    const state = this.controller?.state;
    this.dismissed = null;
    if (state?.mediaId) void this.player.load(state);
  }

  status() {
    const state = this.controller?.state ?? null;
    const wanted = state?.mediaType === 'local' && state.mediaId ? parseMediaId(state.mediaId) : null;
    const describe = (f: VideoFile) => ({
      file_id: f.id, name: path.basename(f.path), path: f.path, size: f.size, duration: f.info?.duration ?? 0,
    });
    return {
      joined: this.joined(),
      code: this.details?.code ?? null,
      connection: this.connection,
      media: state?.mediaId ? { type: state.mediaType, title: state.mediaTitle } : null,
      local: {
        phase: this.view.phase,
        message: this.view.message ?? null,
        expected: wanted ? { title: state!.mediaTitle, size: wanted.size, duration: wanted.duration } : null,
        file: this.view.file ? describe(this.view.file) : null,
        alternatives: (this.view.alternatives ?? []).map(describe),
      },
      drift: this.reading.mediaId ? (this.controller?.drift() ?? null) : null,
    };
  }

  // ---------- VLC, as the sync logic sees it ----------

  private readonly player = {
    /** The room started playing something: find it here and open it. */
    load: async (state: RoomState): Promise<void> => {
      if (state.mediaType !== 'local' || !state.mediaId) {
        this.closeOurVlc();
        this.view = { phase: 'idle' };
        return;
      }
      if (this.dismissed === state.mediaId) return;
      const wanted = parseMediaId(state.mediaId);
      if (!wanted) {
        this.view = { phase: 'missing', alternatives: [] };
        return;
      }
      const chosen = this.library.catalog().findFile(this.accepted.get(state.mediaId) ?? '');
      if (chosen) return this.open(chosen, state);
      this.view = { phase: 'looking' };
      const match = await findMatch(this.library.catalog(), wanted);
      if (this.controller?.state?.mediaId !== state.mediaId) return; // the room moved on meanwhile
      if (match.exact) await this.open(match.exact, state);
      else this.view = { phase: 'missing', alternatives: match.sameLength };
    },
    play: () => void this.vlc?.play(),
    pause: () => void this.vlc?.pause(),
    seek: (seconds: number) => {
      this.estimator.reset();
      void this.vlc?.seek(seconds, this.lastStatus?.duration ?? 0);
    },
    setRate: (rate: number) => void this.vlc?.setRate(rate),
  };

  private async open(file: VideoFile, state: RoomState): Promise<void> {
    if (!this.details || !this.core || !this.controller?.state) return;
    const config = this.getConfig();
    const start = this.core.expectedPosition(this.controller.state as RoomState, this.serverNow());
    const title = state.mediaTitle ?? path.basename(file.path);
    try {
      this.vlc = await this.playback.play(
        this.details.profile, [{ fileId: file.id, path: file.path, title, start }],
        { executable: config.vlc, fullscreen: config.fullscreen },
      );
    } catch (error) {
      this.view = { phase: 'error', message: (error as Error).message };
      return;
    }
    this.openMediaId = state.mediaId;
    this.lastStatus = null;
    this.reading = IDLE;
    this.estimator.reset();
    this.view = { phase: 'playing', file };
  }

  private closeOurVlc(): void {
    if (this.vlc && this.playback.current() === this.vlc) this.playback.stop();
    this.vlc = null;
    this.openMediaId = null;
    this.reading = IDLE;
  }

  /** Ask VLC where it is, and turn that into a reading for the sync logic. */
  private async poll(): Promise<void> {
    const vlc = this.vlc;
    if (!vlc || this.polling) return;

    if (!vlc.running() || this.playback.current() !== vlc) {
      // The window was closed, or the film ended, or something else was
      // started from the library. Don't reopen it behind the person's back.
      this.dismissed = this.openMediaId;
      this.vlc = null;
      this.openMediaId = null;
      this.reading = IDLE;
      this.view = { phase: 'closed', file: this.view.file };
      return;
    }

    this.polling = true;
    const status = await vlc.poll();
    this.polling = false;
    if (!status || vlc !== this.vlc) return; // still starting, or replaced meanwhile

    this.lastStatus = status;
    const playing = status.state === 'playing';
    const estimate = this.estimator.update(status.position, playing, status.rate, performance.now());
    this.reading = {
      mediaId: this.openMediaId,
      status: status.state === 'stopped' ? 'idle' : !playing ? 'paused' : estimate.stalled ? 'buffering' : 'playing',
      position: estimate.position,
      rate: status.rate,
    };
  }
}
