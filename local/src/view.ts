// Ported from Synaxis (src/server.cpp), GPL-3.0-or-later,
// Copyright (C) 2026 Azhar Tanweer.
//
// Builds the JSON the web page shows: title cards, the home rows and a
// title's episode list, all from one profile's point of view.

import path from 'node:path';

import type { Catalog, Title, TitleItem, VideoFile } from './catalog.ts';
import { computeUpNext, continueWatching, type UpNext } from './feed.ts';
import type { Library } from './library.ts';
import type { Profile } from './watchState.ts';

const ROW_LIMIT = 30;

export type Filter = 'all' | 'show' | 'movie';

export function episodeLabel(item: TitleItem): string {
  return item.season && item.episode ? `S${item.season}:E${item.episode}` : '';
}

function quality(file: VideoFile | undefined): string | null {
  const height = file?.info?.height ?? 0;
  if (height <= 0) return null;
  if (height >= 1600) return '4K';
  return height >= 700 ? 'HD' : 'SD';
}

/** The name shown in VLC's title bar. */
export function playlistTitle(catalog: Catalog, title: Title, index: number): string {
  if (title.kind === 'movie') return title.year ? `${title.name} (${title.year})` : title.name;
  const item = title.items[index]!;
  const episodeTitle = catalog.findFile(item.fileIds[0]!)?.metadata.episodeTitle;
  return `${title.name} · ${episodeLabel(item)}${episodeTitle ? ` · ${episodeTitle}` : ''}`;
}

/** Lowercase words separated by single spaces, for forgiving search. */
function simplify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** A shuffle that gives the same order for the same seed. */
function shuffled<T>(list: T[], seed: number): T[] {
  const out = [...list];
  let state = seed >>> 0;
  const random = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

export class View {
  private readonly catalog: Catalog;
  private readonly profile: Profile;
  private readonly library: Library;

  constructor(catalog: Catalog, profile: Profile, library: Library) {
    this.catalog = catalog;
    this.profile = profile;
    this.library = library;
  }

  private image(fileId: string): string | null {
    const version = this.library.thumbnailVersion(fileId);
    return version === undefined ? null : `/thumbs/${fileId}.jpg?v=${version}`;
  }

  /** Title art: a frame from one of the first few episodes (or the movie). */
  private titleImage(title: Title): string | null {
    for (const item of title.items.slice(0, 6)) {
      for (const id of item.fileIds) {
        const image = this.image(id);
        if (image) return image;
      }
    }
    return null;
  }

  private best(item: TitleItem): VideoFile | undefined {
    return this.catalog.findFile(item.fileIds[0]!);
  }

  card(title: Title, up: UpNext = computeUpNext(this.catalog, this.profile, title)) {
    const best = this.best(title.items[0]!);
    const upFile = this.catalog.findFile(up.fileId);
    const card: Record<string, unknown> = {
      id: title.id,
      name: title.name,
      kind: title.kind,
      year: title.year,
      image: this.titleImage(title),
      quality: quality(best),
      hdr: best?.info?.hdr ?? false,
      in_list: title.id in this.profile.my_list,
      added: title.added,
      up_next: {
        file_id: up.fileId,
        label: episodeLabel(title.items[up.item]!),
        episode_title: upFile?.metadata.episodeTitle ?? null,
        position: up.position,
        duration: up.duration,
        reason: up.reason,
        image: this.image(up.fileId),
      },
    };
    if (title.kind === 'show') {
      card.seasons = new Set(title.items.map((i) => i.season)).size;
      card.episodes = title.items.length;
    } else {
      card.runtime = best?.info?.duration ?? 0;
    }
    return card;
  }

  private item(item: TitleItem) {
    const best = this.best(item);
    const played = item.fileIds
      .map((id) => this.profile.progress[id])
      .filter((p) => p !== undefined)
      .sort((a, b) => b.updated - a.updated)[0];
    const files = item.fileIds.map((id) => this.catalog.findFile(id)).filter((f) => f !== undefined);
    return {
      file_id: item.fileIds[0],
      season: item.season,
      episode: item.episode,
      label: episodeLabel(item),
      episode_title: best?.metadata.episodeTitle ?? null,
      duration: best?.info?.duration ?? 0,
      image: item.fileIds.map((id) => this.image(id)).find((image) => image !== null) ?? null,
      quality: quality(best),
      progress: played ? { position: played.position, duration: played.duration, completed: played.completed } : null,
      versions: files.map((f) => ({
        file_id: f.id,
        path: f.path,
        size: f.size,
        quality: quality(f),
        width: f.info?.width ?? 0,
        height: f.info?.height ?? 0,
        codec: f.info?.codec ?? null,
        hdr: f.info?.hdr ?? false,
        source: f.metadata.source,
        tags: f.metadata.tags,
      })),
    };
  }

  /** A title's page: its card plus every episode (or copy). */
  detail(title: Title) {
    const first = this.best(title.items[0]!);
    return {
      ...this.card(title),
      items: title.items.map((item) => this.item(item)),
      folder: first ? path.dirname(first.path) : '',
    };
  }

  myList() {
    return Object.entries(this.profile.my_list)
      .sort((a, b) => b[1] - a[1])
      .map(([id]) => this.catalog.findTitle(id))
      .filter((t) => t !== undefined);
  }

  search(query: string) {
    const q = simplify(query);
    if (q === '') return [];
    const hits: { rank: number; title: Title }[] = [];
    for (const title of this.catalog.titles) {
      const name = simplify(title.name);
      let rank = -1;
      if (name.startsWith(q)) rank = 0;
      else if (name.includes(` ${q}`)) rank = 1;
      else if (name.includes(q)) rank = 2;
      else if (title.items.some((item) => simplify(this.best(item)?.metadata.episodeTitle ?? '').includes(q))) rank = 3;
      if (rank >= 0) hits.push({ rank, title });
    }
    return hits.sort((a, b) => a.rank - b.rank).map((hit) => this.card(hit.title));
  }

  home(filter: Filter, everyone: Profile[]) {
    const keep = (t: Title) => filter === 'all' || t.kind === filter;
    const titles = this.catalog.titles.filter(keep);
    const up = new Map(titles.map((t) => [t.id, computeUpNext(this.catalog, this.profile, t)]));
    const info = (t: Title) => this.best(t.items[0]!)?.info ?? null;

    const rows: unknown[] = [];
    const addRow = (id: string, name: string, list: Title[], minItems: number, type = 'titles') => {
      if (list.length === 0 || list.length < minItems) return;
      const items = list.slice(0, ROW_LIMIT).map((t) => this.card(t, up.get(t.id)));
      rows.push({ id, name, type, items });
    };

    const continuing = continueWatching(this.catalog, this.profile).map((u) => u.title).filter(keep);
    addRow('continue', `Continue Watching for ${this.profile.name}`, continuing, 1, 'continue');
    addRow('my-list', 'My List', this.myList().filter(keep), 1);

    // Most played across every profile.
    const plays = new Map<string, number>();
    for (const profile of everyone) {
      for (const [fileId, progress] of Object.entries(profile.progress)) {
        const location = this.catalog.locate(fileId);
        if (location) plays.set(location.title.id, (plays.get(location.title.id) ?? 0) + progress.plays);
      }
    }
    const played = (t: Title) => plays.get(t.id) ?? 0;
    const top = titles.filter((t) => played(t) > 0).sort((a, b) => played(b) - played(a)).slice(0, 10);
    addRow('top10', 'Top 10 in Your Library', top, 3, 'top10');

    const recent = [...titles].sort((a, b) => b.added - a.added).slice(0, 20);
    addRow('recent', 'Recently Added', recent, 1);

    // Untouched titles, in a different order each day.
    const day = Math.floor(Date.now() / 86_400_000);
    const untouched = titles.filter((t) => up.get(t.id)!.lastActivity === 0);
    addRow('fresh', 'New to You', shuffled(untouched, day), 4);

    if (filter === 'all') {
      addRow('shows', 'TV Shows', titles.filter((t) => t.kind === 'show'), 1);
      addRow('movies', 'Movies', titles.filter((t) => t.kind === 'movie'), 1);
    } else {
      addRow('all', filter === 'show' ? 'All TV Shows' : 'All Movies', titles, 1);
    }

    addRow('binge', 'Bingeworthy Series', titles.filter((t) => t.kind === 'show' && t.items.length >= 8), 2);
    addRow('uhd', 'Stunning in 4K', titles.filter((t) => (info(t)?.height ?? 0) >= 1600), 2);
    addRow('epic', 'Epic Movies', titles.filter((t) => t.kind === 'movie' && (info(t)?.duration ?? 0) >= 2.5 * 3600), 2);
    addRow('quick', 'Quick Watches', titles.filter((t) => {
      const duration = info(t)?.duration ?? 0;
      return t.kind === 'movie' && duration > 0 && duration < 100 * 60;
    }), 2);

    const decades = new Map<number, Title[]>();
    for (const t of titles) {
      if (t.year === null) continue;
      const decade = Math.floor(t.year / 10) * 10;
      decades.set(decade, [...(decades.get(decade) ?? []), t]);
    }
    for (const decade of [...decades.keys()].sort((a, b) => b - a)) {
      addRow(`decade-${decade}`, `From the ${decade}s`, decades.get(decade)!, 3);
    }

    const again = titles
      .filter((t) => up.get(t.id)!.reason === 'rewatch' && up.get(t.id)!.lastActivity > 0)
      .sort((a, b) => up.get(b.id)!.lastActivity - up.get(a.id)!.lastActivity);
    addRow('again', 'Watch It Again', again, 1);

    // Billboard: something unwatched with artwork, rotating daily through
    // the most recent additions.
    const withArt = recent.filter((t) => this.titleImage(t) !== null);
    let billboard = withArt.filter((t) => up.get(t.id)!.lastActivity === 0);
    if (billboard.length === 0) billboard = withArt;
    if (billboard.length === 0) billboard = recent.slice(0, 1);
    billboard = billboard.slice(0, 8);
    const pick = billboard.length > 0 ? billboard[day % billboard.length]! : null;

    return { hero: pick ? this.card(pick, up.get(pick.id)) : null, rows, count: titles.length };
  }
}
