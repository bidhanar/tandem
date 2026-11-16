// The local web server: the page's files, artwork, and the JSON API the page
// calls. API ported from Synaxis (src/server.cpp), GPL-3.0-or-later,
// Copyright (C) 2026 Azhar Tanweer.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import type { TitleItem } from './catalog.ts';
import { applyChanges, expandHome, saveConfig, scanOptions, type AppConfig, type AppPaths } from './config.ts';
import { computeUpNext } from './feed.ts';
import type { Library } from './library.ts';
import { WEB_DIR } from './paths.ts';
import type { Playback } from './playback.ts';
import type { RoomClient } from './together.ts';
import { playlistTitle, View, type Filter } from './view.ts';
import type { PlaylistItem } from './vlc.ts';
import { MIN_RESUME_SECONDS, type WatchState } from './watchState.ts';

/** Episodes queued after the one picked, so VLC rolls on to the next. */
const AUTOPLAY_QUEUE = 25;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
};

/** An error whose message is shown to the user, with its HTTP status. */
class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

type Request = {
  query: URLSearchParams;
  params: string[]; // the parts of the path captured by the route
  body: Record<string, unknown>;
};
type Handler = (request: Request) => unknown;

const unixNow = () => Math.floor(Date.now() / 1000);
const text = (value: unknown) => (typeof value === 'string' ? value : '');

export type Services = {
  paths: AppPaths;
  config: AppConfig;
  library: Library;
  watch: WatchState;
  playback: Playback;
  room: RoomClient;
  /** Called whenever the settings change. */
  onConfig: (config: AppConfig) => void;
  quit: () => void;
};

export function createServer(services: Services): http.Server {
  const { paths, library, watch, playback, room } = services;
  let config = services.config;

  const routes: { method: string; pattern: RegExp; handler: Handler }[] = [];
  const route = (method: string, pattern: RegExp, handler: Handler) => routes.push({ method, pattern, handler });

  const profileOf = (id: string) => {
    const profile = watch.profile(id);
    if (!profile) throw new ApiError(404, 'no such profile');
    return profile;
  };
  const viewFor = (request: Request) =>
    new View(library.catalog(), profileOf(request.query.get('profile') ?? ''), library);
  const titleOf = (id: string) => {
    const title = library.catalog().findTitle(id);
    if (!title) throw new ApiError(404, 'no such title');
    return title;
  };

  // ---- App state ----

  route('GET', /^\/api\/ping$/, () => ({ app: 'mendu' }));

  route('GET', /^\/api\/state$/, () => ({
    profiles: watch.profiles().map((p) => ({ id: p.id, name: p.name, avatar: p.avatar })),
    settings: config,
  }));

  route('GET', /^\/api\/status$/, () => ({
    scan: library.progress(),
    titles: library.catalog().titles.length,
    now_playing: playback.nowPlaying(),
    together: room.status(),
  }));

  // ---- Profiles ----

  const profileFields = (body: Record<string, unknown>) => {
    const name = text(body.name).trim();
    if (!name) throw new ApiError(400, 'a profile needs a name');
    return { name, avatar: Number(body.avatar) || 0 };
  };

  route('POST', /^\/api\/profiles$/, ({ body }) => {
    const { name, avatar } = profileFields(body);
    const profile = watch.addProfile(name, avatar);
    return { id: profile.id, name: profile.name, avatar: profile.avatar };
  });

  route('POST', /^\/api\/profiles\/(\w+)$/, ({ params, body }) => {
    const { name, avatar } = profileFields(body);
    if (!watch.updateProfile(params[0]!, name, avatar)) throw new ApiError(404, 'no such profile');
    return { ok: true };
  });

  route('DELETE', /^\/api\/profiles\/(\w+)$/, ({ params }) => {
    if (!watch.removeProfile(params[0]!)) throw new ApiError(404, 'no such profile');
    return { ok: true };
  });

  // ---- Browsing ----

  route('GET', /^\/api\/home$/, (request) => {
    const filter = request.query.get('filter');
    return viewFor(request).home(filter === 'show' || filter === 'movie' ? (filter as Filter) : 'all', watch.profiles());
  });

  route('GET', /^\/api\/my-list$/, (request) => {
    const view = viewFor(request);
    return { items: view.myList().map((title) => view.card(title)) };
  });

  route('GET', /^\/api\/search$/, (request) => ({ items: viewFor(request).search(request.query.get('q') ?? '') }));

  route('GET', /^\/api\/titles\/(\w+)$/, (request) => viewFor(request).detail(titleOf(request.params[0]!)));

  // ---- Actions ----

  /** Works out what a Play press means: which file of the title, and from where. */
  const choose = (body: Record<string, unknown>) => {
    const profile = profileOf(text(body.profile));
    const catalog = library.catalog();
    const title = titleOf(text(body.title));

    let index: number;
    let fileId = text(body.file);
    let start = 0;
    if (fileId) {
      const location = catalog.locate(fileId);
      if (!location || location.title !== title) throw new ApiError(404, 'no such file');
      index = location.item;
      const progress = profile.progress[fileId];
      if (progress && !progress.completed && progress.position >= MIN_RESUME_SECONDS) start = progress.position;
    } else {
      const up = computeUpNext(catalog, profile, title);
      index = up.item;
      fileId = up.fileId;
      start = up.position;
    }
    if (body.from_start === true) start = 0;

    const file = catalog.findFile(fileId);
    if (!file || !fs.existsSync(file.path)) {
      throw new ApiError(410, "That file isn't on disk anymore. Try rescanning in Settings.");
    }
    return { profile, catalog, title, index, file, start };
  };

  route('POST', /^\/api\/play$/, async ({ body }) => {
    const { profile, catalog, title, index, file, start } = choose(body);
    const fileId = file.id;

    const playlist: PlaylistItem[] = [{ fileId, path: file.path, title: playlistTitle(catalog, title, index), start }];
    if (title.kind === 'show') {
      for (let i = index + 1; i < title.items.length && i <= index + AUTOPLAY_QUEUE; i++) {
        const next = catalog.findFile(title.items[i]!.fileIds[0]!);
        if (!next || !fs.existsSync(next.path)) break;
        playlist.push({ fileId: next.id, path: next.path, title: playlistTitle(catalog, title, i), start: 0 });
      }
    }

    try {
      await playback.play(profile.id, playlist, { executable: config.vlc, fullscreen: config.fullscreen });
    } catch (error) {
      throw new ApiError(500, (error as Error).message);
    }
    return { ok: true, start };
  });

  // ---- YouTube titles ----

  // The page can't ask YouTube for a video's title itself (browsers block
  // it), so it asks here. This uses YouTube's public oEmbed address.
  const titles = new Map<string, { title: string | null; author: string | null }>();
  route('GET', /^\/api\/youtube\/title$/, async ({ query }) => {
    const id = query.get('id') ?? '';
    if (!/^[A-Za-z0-9_-]{11}$/.test(id)) throw new ApiError(400, 'bad request');
    let known = titles.get(id);
    if (!known) {
      known = { title: null, author: null };
      try {
        const watch = encodeURIComponent(`https://www.youtube.com/watch?v=${id}`);
        const response = await fetch(`https://www.youtube.com/oembed?url=${watch}&format=json`, { signal: AbortSignal.timeout(6000) });
        if (response.ok) {
          const data = (await response.json()) as { title?: string; author_name?: string };
          known = { title: data.title ?? null, author: data.author_name ?? null };
        }
        if (response.ok || response.status === 401 || response.status === 404) titles.set(id, known);
      } catch {
        // offline or slow: answer "unknown" now and try again next time
      }
    }
    return known;
  });

  // ---- Watch Together (local files) ----

  const failed = (error: unknown) => new ApiError(409, (error as Error).message);

  // The page tells us which room it joined, so we can follow it with VLC.
  route('POST', /^\/api\/together\/join$/, async ({ body }) => {
    const details = {
      server: text(body.server), code: text(body.code), clientId: text(body.client),
      name: text(body.name) || 'Guest', profile: profileOf(text(body.profile)).id,
    };
    if (!details.server || !details.code || details.clientId.length < 8) throw new ApiError(400, 'bad request');
    await room.join(details);
    return { ok: true };
  });

  route('POST', /^\/api\/together\/leave$/, () => {
    room.leave();
    return { ok: true };
  });

  route('POST', /^\/api\/together\/play$/, async ({ body }) => {
    const { profile, catalog, title, index, file, start } = choose(body);
    await room.playForBoth(profile.id, file, playlistTitle(catalog, title, index), start).catch((e) => { throw failed(e); });
    return { ok: true, start };
  });

  // Play another copy of what the room is playing, after the "different version" warning.
  route('POST', /^\/api\/together\/use$/, async ({ body }) => {
    const file = library.catalog().findFile(text(body.file));
    if (!file) throw new ApiError(404, 'no such file');
    await room.useFile(file).catch((e) => { throw failed(e); });
    return { ok: true };
  });

  route('POST', /^\/api\/together\/reopen$/, () => {
    room.reopen();
    return { ok: true };
  });

  route('POST', /^\/api\/stop$/, () => {
    playback.stop();
    return { ok: true };
  });

  route('POST', /^\/api\/my-list$/, ({ body }) => {
    const profile = profileOf(text(body.profile));
    return { in_list: watch.toggleMyList(profile.id, text(body.title), unixNow()) };
  });

  route('POST', /^\/api\/watched$/, ({ body }) => {
    const profile = profileOf(text(body.profile));
    const title = titleOf(text(body.title));
    // Marking applies to every copy, so it sticks whichever one plays next.
    const fileId = text(body.file);
    const matches = (item: TitleItem) => !fileId || item.fileIds.includes(fileId);
    const files = title.items.filter(matches).flatMap((item) => item.fileIds);
    watch.setWatched(profile.id, files, body.watched !== false, unixNow());
    return { ok: true };
  });

  route('POST', /^\/api\/dismiss$/, ({ body }) => {
    const profile = profileOf(text(body.profile));
    watch.dismiss(profile.id, text(body.title), unixNow());
    return { ok: true };
  });

  // ---- Settings ----

  route('POST', /^\/api\/settings$/, ({ body }) => {
    const before = config;
    let after: AppConfig;
    try {
      after = applyChanges(before, body);
    } catch {
      throw new ApiError(400, 'invalid settings');
    }

    const roots: string[] = [];
    for (const typed of after.roots) {
      if (typed.trim() === '') continue;
      const root = path.resolve(expandHome(typed.trim()));
      if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new ApiError(400, `Not a folder: ${typed}`);
      if (!roots.includes(root)) roots.push(root);
    }
    after.roots = roots;
    after.min_size_mb = Math.max(0, after.min_size_mb);
    after.vlc ||= 'vlc';
    after.sync_server = after.sync_server.trim().replace(/\/+$/, '') || before.sync_server;

    config = after;
    saveConfig(config, paths.configFile);
    services.onConfig(config);

    const rescanning = after.min_size_mb !== before.min_size_mb || after.roots.join('\n') !== before.roots.join('\n');
    if (rescanning) library.rescan(scanOptions(config));
    return { settings: config, rescanning };
  });

  route('POST', /^\/api\/rescan$/, () => {
    library.rescan(scanOptions(config));
    return { ok: true };
  });

  // Started from a shortcut there's no terminal to press Ctrl+C in, so the
  // page can shut the program down. It waits a moment so this reply gets out.
  route('POST', /^\/api\/quit$/, () => {
    setTimeout(services.quit, 200);
    return { ok: true };
  });

  // ---- Plumbing ----

  const sendJson = (response: http.ServerResponse, status: number, data: unknown) => {
    response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify(data));
  };

  const sendFile = (response: http.ServerResponse, file: string, type: string, cache: string) => {
    fs.readFile(file, (error, data) => {
      if (error) {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, { 'Content-Type': type, 'Cache-Control': cache });
      response.end(data);
    });
  };

  const readBody = async (request: http.IncomingMessage): Promise<Record<string, unknown>> => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    if (chunks.length === 0) return {};
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (typeof body === 'object' && body !== null && !Array.isArray(body)) return body;
    } catch {
      // fall through
    }
    throw new ApiError(400, 'bad request');
  };

  return http.createServer(async (request, response) => {
    const method = request.method ?? 'GET';
    const url = new URL(request.url ?? '/', 'http://localhost');

    // Only answer requests addressed to this computer by name. A web page
    // that re-points its own domain at 127.0.0.1 (DNS rebinding) is refused.
    const host = (request.headers.host ?? '').replace(/:\d+$/, '');
    if (host !== '127.0.0.1' && host !== 'localhost') {
      response.writeHead(403).end();
      return;
    }
    // Changes need a custom header, which other websites can't send here.
    if (method !== 'GET' && method !== 'HEAD' && request.headers['x-mendu'] !== '1') {
      response.writeHead(403).end();
      return;
    }

    const thumb = /^\/thumbs\/([0-9a-f]{16})\.jpg$/.exec(url.pathname);
    if (thumb) {
      // The URL carries the thumbnail's date, so a cached copy is never stale.
      sendFile(response, library.thumbnailPath(thumb[1]!), 'image/jpeg', 'public, max-age=31536000, immutable');
      return;
    }

    if (url.pathname.startsWith('/api/')) {
      const found = routes
        .map((r) => ({ r, match: r.method === method ? r.pattern.exec(url.pathname) : null }))
        .find((x) => x.match);
      if (!found) {
        sendJson(response, 404, { error: 'not found' });
        return;
      }
      try {
        const body = method === 'GET' ? {} : await readBody(request);
        const result = await found.r.handler({ query: url.searchParams, params: found.match!.slice(1), body });
        sendJson(response, 200, result);
      } catch (error) {
        if (error instanceof ApiError) sendJson(response, error.status, { error: error.message });
        else {
          console.error(error);
          sendJson(response, 500, { error: 'Something went wrong in Mendu.' });
        }
      }
      return;
    }

    // Everything else is a file of the web page.
    const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const type = MIME[path.extname(name)];
    if (!type || !/^[\w.-]+$/.test(name)) {
      response.writeHead(404).end();
      return;
    }
    sendFile(response, path.join(WEB_DIR, name), type, 'no-cache');
  });
}
