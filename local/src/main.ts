// Tandem's local program. Run it and your browser opens the library page.
//
//   npm start -- [--port <port>] [--no-browser]

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { defaultPaths, loadConfig, scanOptions } from './config.ts';
import { Library } from './library.ts';
import { Playback } from './playback.ts';
import { createServer } from './server.ts';
import { RoomClient } from './together.ts';
import { WatchState } from './watchState.ts';

function openBrowser(url: string): void {
  const [command, args] =
    process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : process.platform === 'darwin' ? ['open', [url]]
    : ['xdg-open', [url]];
  const child = spawn(command as string, args as string[], { stdio: 'ignore', detached: true });
  child.on('error', () => console.log(`Couldn't open a browser. Visit ${url}`));
  child.unref();
}

const args = process.argv.slice(2);
const paths = defaultPaths();
const config = loadConfig(paths.configFile);
const portFlag = args.indexOf('--port');
const port = portFlag >= 0 ? Number(args[portFlag + 1]) : config.port;
const url = `http://127.0.0.1:${port}/`;

fs.mkdirSync(paths.dataDir, { recursive: true });
const watch = new WatchState(path.join(paths.dataDir, 'watch_state.json'));
if (watch.profiles().length === 0) watch.addProfile(os.userInfo().username || 'Me', 0);
const library = new Library(paths.dataDir);
const playback = new Playback(watch);

const quit = () => {
  room.leave();
  watch.flush();
  process.exit(0);
};
let currentConfig = config;
const room = new RoomClient(library, playback, () => currentConfig);
const server = createServer({
  paths, config, library, watch, playback, room, quit,
  onConfig: (changed) => { currentConfig = changed; },
});

server.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EADDRINUSE') {
    // Most likely Tandem is already running: just show it.
    console.log(`Port ${port} is in use. If Tandem is already running, it's at ${url}`);
    if (!args.includes('--no-browser')) openBrowser(url);
    process.exit(0);
  }
  throw error;
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Tandem is running at ${url} (Ctrl+C to quit)`);
  library.rescan(scanOptions(config));
  if (!args.includes('--no-browser')) openBrowser(url);
});

process.on('SIGINT', quit);
process.on('SIGTERM', quit);
