// Tells whether two people have the same video file without uploading it.
// A file's fingerprint is its size plus a SHA-256 of its first and last 4 MB;
// its length in seconds rides along so a different copy of the same film
// can be recognised too.

import crypto from 'node:crypto';
import fs from 'node:fs';

import type { Catalog, VideoFile } from './catalog.ts';

const CHUNK = 4 * 1024 * 1024;

/** What a room's `mediaId` says about a local file. */
export type MediaId = { hash: string; size: number; duration: number };

export function makeMediaId(id: MediaId): string {
  return `v1.${id.hash}.${id.size}.${Math.round(id.duration)}`;
}

export function parseMediaId(text: string): MediaId | null {
  const match = /^v1\.([0-9a-f]{32})\.(\d+)\.(\d+)$/.exec(text);
  return match ? { hash: match[1]!, size: Number(match[2]), duration: Number(match[3]) } : null;
}

/** SHA-256 (first 32 hex digits) of the first and last 4 MB; of everything if the file is smaller than 8 MB. */
export async function hashEnds(file: string, size: number): Promise<string> {
  const hash = crypto.createHash('sha256');
  const handle = await fs.promises.open(file, 'r');
  try {
    const read = async (position: number, length: number) => {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, position);
      hash.update(buffer.subarray(0, bytesRead));
    };
    if (size <= 2 * CHUNK) {
      await read(0, size);
    } else {
      await read(0, CHUNK);
      await read(size - CHUNK, CHUNK);
    }
  } finally {
    await handle.close();
  }
  return hash.digest('hex').slice(0, 32);
}

const cache = new Map<string, string>(); // "path|size|mtime" -> hash

async function hashOf(file: VideoFile): Promise<string> {
  const key = `${file.path}|${file.size}|${file.mtime}`;
  let hash = cache.get(key);
  if (!hash) {
    hash = await hashEnds(file.path, file.size);
    cache.set(key, hash);
  }
  return hash;
}

export async function mediaIdOf(file: VideoFile): Promise<string> {
  return makeMediaId({ hash: await hashOf(file), size: file.size, duration: file.info?.duration ?? 0 });
}

export type Match = {
  /** The very same file, if this library has it. */
  exact: VideoFile | null;
  /** Otherwise: files of the same length (within a second), probably other copies of it. */
  sameLength: VideoFile[];
};

/** Looks in the library for the file a room is playing. */
export async function findMatch(catalog: Catalog, wanted: MediaId): Promise<Match> {
  // Only files of exactly the right size can be the same file, so only
  // those need hashing.
  for (const file of catalog.files) {
    if (file.size !== wanted.size) continue;
    try {
      if ((await hashOf(file)) === wanted.hash) return { exact: file, sameLength: [] };
    } catch {
      // unreadable now; not a match
    }
  }
  const sameLength = wanted.duration > 0
    ? catalog.files.filter((f) => f.info && Math.abs(f.info.duration - wanted.duration) <= 1)
    : [];
  return { exact: null, sameLength };
}
