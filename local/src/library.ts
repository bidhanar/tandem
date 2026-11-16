// Ported from Synaxis (src/library_service.cpp), GPL-3.0-or-later,
// Copyright (C) 2026 Azhar Tanweer.

import fs from 'node:fs';
import path from 'node:path';

import { Catalog, loadVideoFiles, saveVideoFiles, scanVideoFiles, type ScanOptions, type VideoFile } from './catalog.ts';
import { mediaToolsMissing, probeMedia, writeThumbnail } from './probe.ts';

export type ScanProgress = {
  running: boolean;
  phase: 'idle' | 'scanning' | 'reading' | 'thumbnails';
  files: number; // video files found by the last walk
  done: number; // progress through the current phase
  total: number;
  version: number; // goes up whenever the catalog changes
  finished_at: number;
};

/** While reading files, show partial results this often. */
const PUBLISH_EVERY = 50;

const unixNow = () => Math.floor(Date.now() / 1000);

/**
 * Keeps the catalog up to date in the background: walks the folders, reads
 * new or changed files, and makes artwork. Readers always get a complete
 * catalog, so browsing never waits for a scan.
 */
export class Library {
  private readonly catalogFile: string;
  private readonly thumbsDir: string;
  private current: Catalog;
  private readonly state: ScanProgress = {
    running: false, phase: 'idle', files: 0, done: 0, total: 0, version: 1, finished_at: 0,
  };
  private pending: ScanOptions | null = null;
  private working = false;
  private readonly failedThumbs = new Set<string>(); // not retried every scan
  private readonly thumbVersions = new Map<string, number>(); // file id -> thumbnail mtime

  /** Loads the saved catalog, if any, so the library shows immediately. */
  constructor(dataDir: string) {
    this.catalogFile = path.join(dataDir, 'catalog.json');
    this.thumbsDir = path.join(dataDir, 'thumbs');
    fs.mkdirSync(this.thumbsDir, { recursive: true });
    for (const name of fs.readdirSync(this.thumbsDir)) {
      if (name.endsWith('.jpg') && !name.endsWith('.tmp.jpg')) this.noteThumbnail(name.slice(0, -4));
    }
    this.current = new Catalog(loadVideoFiles(this.catalogFile));
    this.state.files = this.current.files.length;
  }

  catalog(): Catalog {
    return this.current;
  }

  progress(): ScanProgress {
    return { ...this.state };
  }

  /** Starts a scan. One already running stops at its next step and restarts. */
  rescan(options: ScanOptions): void {
    this.pending = options;
    this.failedThumbs.clear(); // a manual rescan retries everything
    this.state.running = true;
    if (!this.working) void this.work();
  }

  thumbnailPath(fileId: string): string {
    return path.join(this.thumbsDir, `${fileId}.jpg`);
  }

  /** When the thumbnail was made (so its URL changes when it does), if it exists. */
  thumbnailVersion(fileId: string): number | undefined {
    return this.thumbVersions.get(fileId);
  }

  private noteThumbnail(fileId: string): void {
    try {
      this.thumbVersions.set(fileId, Math.floor(fs.statSync(this.thumbnailPath(fileId)).mtimeMs / 1000));
    } catch {
      this.thumbVersions.delete(fileId);
    }
  }

  private async work(): Promise<void> {
    this.working = true;
    while (this.pending) {
      const options = this.pending;
      this.pending = null;
      try {
        await this.runScan(options);
      } catch (error) {
        console.error('Library scan failed:', error);
      }
    }
    Object.assign(this.state, { running: false, phase: 'idle', done: 0, total: 0, finished_at: unixNow() });
    this.working = false;
  }

  private setPhase(phase: ScanProgress['phase'], total: number): void {
    Object.assign(this.state, { phase, done: 0, total });
  }

  private publish(files: VideoFile[]): void {
    saveVideoFiles(files, this.catalogFile);
    this.current = new Catalog(files.map((f) => ({ ...f })));
    this.state.files = files.length;
    this.state.version += 1;
  }

  private async runScan(options: ScanOptions): Promise<void> {
    const interrupted = () => this.pending !== null;

    this.setPhase('scanning', 0);
    const files = await scanVideoFiles(options, interrupted);
    if (interrupted()) return;

    // Unchanged files keep what was read from them last time.
    const toProbe: VideoFile[] = [];
    for (const file of files) {
      const known = this.current.findFile(file.id);
      if (known && known.probed && known.size === file.size && known.mtime === file.mtime) {
        file.probed = true;
        file.info = known.info;
      } else {
        toProbe.push(file);
      }
    }
    this.publish(files);

    this.setPhase('reading', toProbe.length);
    for (const [index, file] of toProbe.entries()) {
      if (interrupted()) return;
      file.info = await probeMedia(file.path);
      // Without ffprobe, leave the file marked unread so a later scan retries.
      file.probed = !mediaToolsMissing();
      this.state.done = index + 1;
      if ((index + 1) % PUBLISH_EVERY === 0) this.publish(files);
    }
    if (toProbe.length > 0) this.publish(files);

    await this.renderThumbnails();
  }

  private async renderThumbnails(): Promise<void> {
    const catalog = this.current;
    const todo = catalog.files
      .filter((f) => !this.failedThumbs.has(f.id) && (this.thumbnailVersion(f.id) ?? -1) < f.mtime)
      .sort((a, b) => b.mtime - a.mtime); // newest first: the home screen shows them first

    this.setPhase('thumbnails', todo.length);
    for (const file of todo) {
      if (this.pending || mediaToolsMissing()) return;
      const ok = await writeThumbnail(file.path, this.thumbnailPath(file.id), file.info?.duration ?? 0);
      if (ok) this.noteThumbnail(file.id);
      else this.failedThumbs.add(file.id);
      this.state.done += 1;
    }

    // Remove artwork of files no longer in the library.
    for (const id of [...this.thumbVersions.keys()]) {
      if (catalog.findFile(id)) continue;
      fs.rmSync(this.thumbnailPath(id), { force: true });
      this.thumbVersions.delete(id);
    }
  }
}
