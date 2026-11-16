// Based on Synaxis (src/vlc_player.cpp), GPL-3.0-or-later,
// Copyright (C) 2026 Azhar Tanweer.

import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

/** What VLC reported at one moment. Times are in seconds. */
export type VlcStatus = {
  state: 'playing' | 'paused' | 'stopped';
  filename: string; // name of the file playing now, if known
  position: number;
  duration: number;
  rate: number; // 1 is normal speed
};

export type PlaylistItem = {
  fileId: string;
  path: string;
  title: string;
  start: number; // seconds to start at
};

export type VlcOptions = {
  executable: string;
  fullscreen: boolean;
};

/**
 * Reads VLC's status.json. Returns null if it isn't a status reply.
 *
 * VLC gives whole seconds for `time` and `length` but a precise fraction for
 * `position`, so the position is fraction x length. When the real length
 * isn't a whole number of seconds this is off by a fraction of a second, the
 * same on every computer for the same file, so it doesn't affect sync.
 */
export function parseVlcStatus(body: string): VlcStatus | null {
  let json: any;
  try {
    json = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof json !== 'object' || json === null || typeof json.state !== 'string') return null;
  const duration = typeof json.length === 'number' && json.length > 0 ? json.length : 0;
  const fraction = typeof json.position === 'number' ? json.position : 0;
  const filename = json.information?.category?.meta?.filename;
  return {
    state: json.state === 'playing' || json.state === 'paused' ? json.state : 'stopped',
    filename: typeof filename === 'string' ? filename : '',
    position: fraction * duration,
    duration,
    rate: typeof json.rate === 'number' ? json.rate : 1,
  };
}

/** The command line that starts VLC with its control interface on. */
export function vlcArguments(options: VlcOptions, playlist: PlaylistItem[], port: number, password: string): string[] {
  const args = [
    // A separate instance, even if the user's VLC is set to reuse one:
    // otherwise the files get handed off and our control port never opens.
    '--no-one-instance',
    '--no-playlist-enqueue',
    '--extraintf=http',
    '--http-host=127.0.0.1',
    `--http-port=${port}`,
    `--http-password=${password}`,
    // We handle resuming; VLC's own "continue from...?" prompt would fight it.
    '--qt-continue=0',
    '--play-and-exit',
    '--no-loop',
    '--no-repeat',
    '--no-random',
  ];
  if (options.fullscreen) args.push('--fullscreen');
  playlist.forEach((item, index) => {
    args.push(item.path);
    // ":option" after a file applies to that playlist item only.
    if (index === 0 && item.start > 0) args.push(`:start-time=${item.start.toFixed(1)}`);
    if (item.title) args.push(`:meta-title=${item.title}`);
  });
  return args;
}

/** The VLC program to run: the configured one, or where Windows installs it. */
export function findVlc(configured: string): string {
  if (configured !== 'vlc' || process.platform !== 'win32') return configured;
  for (const variable of ['ProgramFiles', 'ProgramFiles(x86)']) {
    const root = process.env[variable];
    if (!root) continue;
    const exe = path.join(root, 'VideoLAN', 'VLC', 'vlc.exe');
    if (fs.existsSync(exe)) return exe;
  }
  return configured;
}

function freeLocalPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

/**
 * One running VLC window, controlled through VLC's built-in HTTP interface.
 * That interface listens only on this computer and needs a password made up
 * for each launch.
 */
export class VlcSession {
  readonly playlist: PlaylistItem[];
  private readonly process: ChildProcess;
  private readonly port: number;
  private readonly password: string;
  private exited = false;

  private constructor(process: ChildProcess, playlist: PlaylistItem[], port: number, password: string) {
    this.process = process;
    this.playlist = playlist;
    this.port = port;
    this.password = password;
    process.on('exit', () => { this.exited = true; });
    process.on('error', () => { this.exited = true; });
  }

  /** Starts VLC. Rejects if the program can't be started. */
  static async launch(options: VlcOptions, playlist: PlaylistItem[]): Promise<VlcSession> {
    if (playlist.length === 0) throw new Error('nothing to play');
    const port = await freeLocalPort();
    const password = crypto.randomBytes(16).toString('hex');
    const child = spawn(findVlc(options.executable), vlcArguments(options, playlist, port, password), {
      stdio: 'ignore',
    });
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', () => reject(new Error("Couldn't start VLC. Is it installed? Check the VLC program in Settings.")));
    });
    return new VlcSession(child, playlist, port, password);
  }

  running(): boolean {
    return !this.exited;
  }

  /** Asks VLC for its status; null while it is starting or after it closed. */
  poll(): Promise<VlcStatus | null> {
    return this.request();
  }

  play(): Promise<VlcStatus | null> {
    return this.request('pl_forceresume');
  }

  pause(): Promise<VlcStatus | null> {
    return this.request('pl_forcepause');
  }

  /** Seeks by fraction of the length, which VLC takes to sub-second precision. */
  seek(seconds: number, duration: number): Promise<VlcStatus | null> {
    if (duration <= 0) return this.request();
    const percent = Math.min(100, Math.max(0, (seconds / duration) * 100));
    return this.request('seek', `${percent.toFixed(5)}%`);
  }

  setRate(rate: number): Promise<VlcStatus | null> {
    return this.request('rate', String(rate));
  }

  /** The playlist item VLC is on now. */
  currentItem(status: VlcStatus): PlaylistItem | null {
    if (status.filename === '') return this.playlist.length === 1 ? this.playlist[0]! : null;
    return this.playlist.find((item) => path.basename(item.path) === status.filename) ?? null;
  }

  terminate(): void {
    if (!this.exited) this.process.kill();
  }

  private async request(command?: string, value?: string): Promise<VlcStatus | null> {
    if (this.exited) return null;
    const url = new URL(`http://127.0.0.1:${this.port}/requests/status.json`);
    if (command) url.searchParams.set('command', command);
    if (value) url.searchParams.set('val', value);
    try {
      const response = await fetch(url, {
        headers: { Authorization: `Basic ${Buffer.from(`:${this.password}`).toString('base64')}` },
        signal: AbortSignal.timeout(1500),
      });
      return response.ok ? parseVlcStatus(await response.text()) : null;
    } catch {
      return null; // still starting, or just closed
    }
  }
}
