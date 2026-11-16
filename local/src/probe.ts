import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { promisify } from 'node:util';

import type { MediaInfo } from './catalog.ts';

const run = promisify(execFile);

/**
 * Reading a video's length and size, and making its artwork, is done by the
 * ffprobe and ffmpeg programs. When they aren't installed the library still
 * works, just without durations, quality badges or pictures.
 */
let toolsMissing = false;

export function mediaToolsMissing(): boolean {
  return toolsMissing;
}

function noteIfMissing(error: unknown): void {
  if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !toolsMissing) {
    toolsMissing = true;
    console.warn('ffmpeg/ffprobe not found: the library will have no artwork or durations.');
  }
}

/** Returns null if the file can't be read or has no video in it. */
export async function probeMedia(file: string): Promise<MediaInfo | null> {
  try {
    const { stdout } = await run(
      'ffprobe',
      ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', '-select_streams', 'v:0', file],
      { timeout: 20_000, maxBuffer: 4 * 1024 * 1024 },
    );
    const data = JSON.parse(stdout);
    const video = data.streams?.[0];
    if (!video) return null;
    return {
      duration: Number(data.format?.duration) || 0,
      width: Number(video.width) || 0,
      height: Number(video.height) || 0,
      codec: String(video.codec_name ?? ''),
      hdr: video.color_transfer === 'smpte2084' || video.color_transfer === 'arib-std-b67',
    };
  } catch (error) {
    noteIfMissing(error);
    return null;
  }
}

/**
 * Saves a frame from about a fifth of the way in as a JPEG 960 pixels wide.
 * ffmpeg's "thumbnail" filter picks the most typical of a run of frames,
 * which avoids most black or blank ones. Returns false on any failure.
 */
export async function writeThumbnail(video: string, out: string, duration: number): Promise<boolean> {
  const temporary = `${out}.tmp.jpg`;
  const seek = duration > 0 ? duration * 0.2 : 60;
  try {
    await run(
      'ffmpeg',
      ['-v', 'error', '-ss', seek.toFixed(1), '-i', video, '-frames:v', '1',
        '-vf', 'thumbnail=40,scale=960:-2', '-q:v', '4', '-y', temporary],
      { timeout: 60_000 },
    );
    await fs.promises.rename(temporary, out);
    return true;
  } catch (error) {
    noteIfMissing(error);
    await fs.promises.rm(temporary, { force: true });
    return false;
  }
}
