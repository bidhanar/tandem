import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { writeFileSafely, type ScanOptions } from './catalog.ts';

/** Settings the user can change. Field names are what the web page uses. */
export type AppConfig = {
  roots: string[]; // folders to scan
  min_size_mb: number; // skip smaller files (samples, clips)
  port: number;
  fullscreen: boolean; // open VLC fullscreen
  vlc: string; // VLC program
  sync_server: string; // address of the sync server, for Watch Together
};

export type AppPaths = {
  configFile: string;
  dataDir: string; // library cache, history, thumbnails
};

/** Where Tandem keeps its files on this computer. */
export function defaultPaths(): AppPaths {
  const home = os.homedir();
  if (process.platform === 'win32') {
    const roaming = process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming');
    const local = process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local');
    return { configFile: path.join(roaming, 'Tandem', 'config.json'), dataDir: path.join(local, 'Tandem') };
  }
  const config = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
  const data = process.env.XDG_DATA_HOME || path.join(home, '.local', 'share');
  return { configFile: path.join(config, 'tandem', 'config.json'), dataDir: path.join(data, 'tandem') };
}

/**
 * Defaults: scan the whole home folder, as Synaxis does. A package can carry
 * its own starting values (see scripts/package.sh) in app/defaults.json, two
 * folders above this program's own; today that is the sync server address.
 */
export function defaultConfig(): AppConfig {
  const config: AppConfig = {
    roots: [os.homedir()], min_size_mb: 200, port: 8585, fullscreen: false, vlc: 'vlc',
    sync_server: 'http://localhost:8686',
  };
  try {
    const file = path.resolve(import.meta.dirname, '..', '..', '..', 'defaults.json');
    const packaged = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (typeof packaged.sync_server === 'string' && packaged.sync_server) config.sync_server = packaged.sync_server;
  } catch {
    // no packaged defaults
  }
  return config;
}

/** Copies the fields present in `changes` over `base`. Throws on a wrong type. */
export function applyChanges(base: AppConfig, changes: Record<string, unknown>): AppConfig {
  const config = { ...base };
  const expect = (key: string, ok: boolean) => {
    if (!ok) throw new TypeError(`invalid setting: ${key}`);
  };
  if ('roots' in changes) {
    const roots = changes.roots;
    expect('roots', Array.isArray(roots) && roots.every((r) => typeof r === 'string'));
    config.roots = roots as string[];
  }
  if ('min_size_mb' in changes) {
    expect('min_size_mb', typeof changes.min_size_mb === 'number');
    config.min_size_mb = changes.min_size_mb as number;
  }
  if ('port' in changes) {
    expect('port', Number.isInteger(changes.port));
    config.port = changes.port as number;
  }
  if ('fullscreen' in changes) {
    expect('fullscreen', typeof changes.fullscreen === 'boolean');
    config.fullscreen = changes.fullscreen as boolean;
  }
  if ('vlc' in changes) {
    expect('vlc', typeof changes.vlc === 'string');
    config.vlc = changes.vlc as string;
  }
  if ('sync_server' in changes) {
    expect('sync_server', typeof changes.sync_server === 'string');
    config.sync_server = changes.sync_server as string;
  }
  return config;
}

/** A missing or damaged file gives the defaults. */
export function loadConfig(file: string): AppConfig {
  try {
    return applyChanges(defaultConfig(), JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch {
    return defaultConfig();
  }
}

export function saveConfig(config: AppConfig, file: string): void {
  writeFileSafely(file, `${JSON.stringify(config, null, 2)}\n`);
}

export function scanOptions(config: AppConfig): ScanOptions {
  return { roots: config.roots, minSize: Math.max(0, config.min_size_mb) * 1024 * 1024 };
}

/** Turns a leading "~" into the home folder, the way people type paths. */
export function expandHome(folder: string): string {
  if (folder === '~' || folder.startsWith('~/') || folder.startsWith('~\\')) {
    return path.join(os.homedir(), folder.slice(1));
  }
  return folder;
}
