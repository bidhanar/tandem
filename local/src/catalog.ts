// Ported from Synaxis (src/catalog.cpp), GPL-3.0-or-later,
// Copyright (C) 2026 Azhar Tanweer.

import fs from 'node:fs';
import path from 'node:path';

import { parseFilename, type ParsedFilename } from './filenameParser.ts';

/** Facts read from inside the video file (by ffprobe). */
export type MediaInfo = {
  duration: number; // seconds; 0 when unknown
  width: number;
  height: number;
  codec: string; // "h264", "hevc", ...
  hdr: boolean;
};

/** A video file on disk plus everything known about it. */
export type VideoFile = {
  id: string; // fileId(path): the same every run
  path: string;
  size: number; // bytes
  mtime: number; // unix seconds; doubles as "date added"
  metadata: ParsedFilename;
  probed: boolean; // ffprobe has been tried
  info: MediaInfo | null; // set when it succeeded
};

export type TitleKind = 'movie' | 'show';

/**
 * One playable thing in a title: a movie, or one episode. When the library
 * has several copies they're all listed, best first.
 */
export type TitleItem = {
  season: number | null;
  episode: number | null;
  fileIds: string[];
};

/** What you browse: a movie, or a show with its episodes in watch order. */
export type Title = {
  id: string;
  kind: TitleKind;
  name: string;
  year: number | null;
  items: TitleItem[];
  added: number; // newest file's mtime
};

export const VIDEO_EXTENSIONS = new Set([
  'mp4', 'mkv', 'mov', 'avi', 'webm', 'wmv', 'flv', 'm4v', 'mpg', 'mpeg', 'ts',
]);

/** Folders that never hold your videos but are slow to walk. */
const SKIPPED_FOLDERS = new Set(['node_modules', 'AppData', '$RECYCLE.BIN']);

/** 16 hex digits: an FNV-1a style hash of the text (same start value as Synaxis). */
function hash16(text: string): string {
  let h = 1469598103934665603n;
  for (const byte of Buffer.from(text, 'utf8')) {
    h ^= BigInt(byte);
    h = (h * 1099511628211n) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, '0');
}

/** Short id for a file, used in URLs and saved history. */
export function fileId(filePath: string): string {
  return hash16(filePath);
}

/**
 * Grouping key that ignores case and punctuation, so "Rick & Morty" and
 * "rick.and.morty" end up in the same show.
 */
export function normalizeKey(name: string): string {
  let out = '';
  let space = false;
  for (const c of name) {
    if (c === '&') {
      out += out === '' || space ? 'and ' : ' and ';
      space = true;
    } else if (c === "'") {
      continue;
    } else if (/[a-z0-9]/i.test(c)) {
      out += c.toLowerCase();
      space = false;
    } else if (out !== '' && !space) {
      out += ' ';
      space = true;
    }
  }
  return out.trimEnd();
}

function titleCase(text: string): string {
  let start = true;
  let out = '';
  for (const c of text) {
    if (/[a-z]/i.test(c)) {
      out += start ? c.toUpperCase() : c;
      start = false;
    } else {
      out += c;
      start = c === ' ' || c === '-';
    }
  }
  return out;
}

/**
 * The name to group a file under when its filename has no usable title, e.g.
 * "S01E01.mkv" inside "Show Name/Season 1/".
 */
function fallbackName(file: VideoFile): string {
  if (file.metadata.season !== null) {
    let dir = path.dirname(file.path);
    if (/^(season|series|s)[\s._-]*\d+$/i.test(path.basename(dir))) dir = path.dirname(dir);
    if (path.basename(dir)) return path.basename(dir);
  }
  return path.parse(file.path).name;
}

const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Sorts the best copy first: highest resolution, then largest. */
function compareCopies(a: VideoFile, b: VideoFile): number {
  const heightA = a.info?.height ?? 0;
  const heightB = b.info?.height ?? 0;
  if (heightA !== heightB) return heightB - heightA;
  if (a.size !== b.size) return b.size - a.size;
  return compareText(a.path, b.path);
}

export type ScanOptions = {
  roots: string[];
  minSize: number; // bytes; smaller files are skipped
};

/**
 * Walks every root for video files of at least `minSize` bytes. Hidden
 * folders, symlinked folders and a few system folders are skipped, unreadable folders are ignored,
 * and overlapping roots don't produce duplicates. Sorted by path.
 */
export async function scanVideoFiles(
  options: ScanOptions,
  cancelled: () => boolean = () => false,
): Promise<VideoFile[]> {
  const files: VideoFile[] = [];
  const seen = new Set<string>();
  for (const root of options.roots) {
    const pending = [root];
    while (pending.length > 0) {
      if (cancelled()) return files;
      const dir = pending.pop()!;
      let entries: fs.Dirent[];
      try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true });
      } catch {
        continue; // can't read this folder
      }
      for (const entry of entries) {
        if (entry.name.startsWith('.') || SKIPPED_FOLDERS.has(entry.name)) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          pending.push(full);
          continue;
        }
        const extension = path.extname(entry.name).slice(1).toLowerCase();
        if (!entry.isFile() || !VIDEO_EXTENSIONS.has(extension)) continue;
        try {
          const stat = await fs.promises.stat(full);
          if (stat.size < options.minSize) continue;
          const real = await fs.promises.realpath(full);
          if (seen.has(real)) continue;
          seen.add(real);
          files.push({
            id: fileId(real),
            path: real,
            size: stat.size,
            mtime: Math.floor(stat.mtimeMs / 1000),
            metadata: parseFilename(path.basename(real)),
            probed: false,
            info: null,
          });
        } catch {
          continue; // vanished or unreadable
        }
      }
    }
  }
  return files.sort((a, b) => compareText(a.path, b.path));
}

/** The library at one moment: files grouped into titles. Never changes. */
export class Catalog {
  readonly files: VideoFile[];
  readonly titles: Title[] = [];
  private readonly fileById = new Map<string, VideoFile>();
  private readonly titleById = new Map<string, Title>();
  private readonly location = new Map<string, { title: Title; item: number }>();

  constructor(files: VideoFile[] = []) {
    this.files = files;
    for (const file of files) this.fileById.set(file.id, file);

    type Group = { kind: TitleKind; year: number | null; files: VideoFile[]; names: Map<string, number> };
    const groups = new Map<string, Group>();
    for (const file of files) {
      const m = file.metadata;
      const isEpisode = m.season !== null && m.episode !== null;
      let name = m.title ?? fallbackName(file);
      let key = normalizeKey(name);
      if (key === '') {
        name = path.parse(file.path).name;
        key = normalizeKey(name);
      }
      key = (isEpisode ? 'show:' : 'movie:') + key;
      if (!isEpisode && m.year !== null) key += `|${m.year}`;

      let group = groups.get(key);
      if (!group) {
        group = { kind: isEpisode ? 'show' : 'movie', year: null, files: [], names: new Map() };
        groups.set(key, group);
      }
      group.files.push(file);
      group.names.set(name, (group.names.get(name) ?? 0) + 1);
      if (m.year !== null && (group.year === null || m.year < group.year)) group.year = m.year;
    }

    for (const key of [...groups.keys()].sort(compareText)) {
      const group = groups.get(key)!;
      const title: Title = {
        id: hash16(key),
        kind: group.kind,
        name: pickDisplayName(group.names),
        year: group.year,
        items: [],
        added: Math.max(...group.files.map((f) => f.mtime)),
      };

      if (group.kind === 'movie') {
        title.items.push({ season: null, episode: null, fileIds: group.files.map((f) => f.id) });
      } else {
        const episodes = new Map<string, TitleItem>();
        for (const file of group.files) {
          const { season, episode } = file.metadata;
          const episodeKey = `${season}:${episode}`;
          let item = episodes.get(episodeKey);
          if (!item) {
            item = { season, episode, fileIds: [] };
            episodes.set(episodeKey, item);
          }
          item.fileIds.push(file.id);
        }
        // Watch order, with specials (season 0) after the regular seasons.
        const order = (item: TitleItem) => (item.season === 0 ? Infinity : item.season!);
        title.items = [...episodes.values()].sort(
          (a, b) => order(a) - order(b) || a.episode! - b.episode!,
        );
      }
      for (const item of title.items) {
        item.fileIds.sort((a, b) => compareCopies(this.fileById.get(a)!, this.fileById.get(b)!));
      }
      this.titles.push(title);
    }

    this.titles.sort((a, b) => compareText(normalizeKey(a.name), normalizeKey(b.name)));
    for (const title of this.titles) {
      this.titleById.set(title.id, title);
      title.items.forEach((item, index) => {
        for (const id of item.fileIds) this.location.set(id, { title, item: index });
      });
    }
  }

  findFile(id: string): VideoFile | undefined {
    return this.fileById.get(id);
  }

  findTitle(id: string): Title | undefined {
    return this.titleById.get(id);
  }

  /** The title holding a file, and which of its items that is. */
  locate(id: string): { title: Title; item: number } | undefined {
    return this.location.get(id);
  }
}

/**
 * The most common spelling, preferring ones with capitals ("Mad Max" over
 * "mad max"); title-cased if every spelling is lowercase.
 */
function pickDisplayName(names: Map<string, number>): string {
  let best = '';
  let bestVotes = -1;
  let bestHasUpper = false;
  for (const spelling of [...names.keys()].sort(compareText)) {
    const votes = names.get(spelling)!;
    const hasUpper = /[A-Z]/.test(spelling);
    const better = hasUpper !== bestHasUpper ? hasUpper : votes > bestVotes;
    if (better) {
      best = spelling;
      bestVotes = votes;
      bestHasUpper = hasUpper;
    }
  }
  return bestHasUpper ? best : titleCase(best);
}

/** Saves scan results so the next start doesn't re-read every file. */
export function saveVideoFiles(files: VideoFile[], file: string): void {
  const data = {
    version: 1,
    files: files.map((f) => ({ path: f.path, size: f.size, mtime: f.mtime, probed: f.probed, info: f.info })),
  };
  writeFileSafely(file, JSON.stringify(data));
}

/** Returns an empty list if the file is missing or damaged. */
export function loadVideoFiles(file: string): VideoFile[] {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return (data.files as any[]).map((f) => ({
      id: fileId(f.path),
      path: f.path,
      size: f.size,
      mtime: f.mtime,
      metadata: parseFilename(path.basename(f.path)), // re-parsed so parser fixes apply
      probed: Boolean(f.probed),
      info: f.info ?? null,
    }));
  } catch {
    return [];
  }
}

/** Writes to a temporary file first, so a crash can't leave half a file. */
export function writeFileSafely(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, text);
  fs.renameSync(temporary, file);
}
