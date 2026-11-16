// Ported from Synaxis (src/watch_state.cpp), GPL-3.0-or-later,
// Copyright (C) 2026 Azhar Tanweer.

import crypto from 'node:crypto';
import fs from 'node:fs';

import { writeFileSafely } from './catalog.ts';

/** How far a profile got through one file. */
export type Progress = {
  position: number; // seconds
  duration: number; // seconds; 0 if unknown
  updated: number; // unix seconds of the last change
  completed: boolean;
  plays: number; // times playback was started
};

export type Profile = {
  id: string;
  name: string;
  avatar: number; // index into the page's avatar palette
  progress: Record<string, Progress>; // by file id
  my_list: Record<string, number>; // title id -> time added
  dismissed: Record<string, number>; // title id -> time removed from Continue Watching
};

/** Resume points below this count as "not really started". */
export const MIN_RESUME_SECONDS = 10;

/** Position reports arrive every second; don't rewrite the file that often. */
const SAVE_INTERVAL_SECONDS = 5;

/** Watched to the end: within the last 5% (credits) or the last 30 seconds. */
export function isFinished(position: number, duration: number): boolean {
  if (duration <= 0) return false;
  return duration - position <= Math.max(30, duration * 0.05);
}

const emptyProgress = (): Progress => ({ position: 0, duration: 0, updated: 0, completed: false, plays: 0 });

/** Each profile's viewing history, kept in a JSON file. */
export class WatchState {
  private readonly file: string;
  private list: Profile[] = [];
  private dirty = false;
  private lastSave = 0;

  constructor(file: string) {
    this.file = file;
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      this.list = (data.profiles as any[]).map((p) => ({
        id: String(p.id),
        name: String(p.name),
        avatar: Number(p.avatar ?? 0),
        progress: p.progress ?? {},
        my_list: p.my_list ?? {},
        dismissed: p.dismissed ?? {},
      }));
    } catch {
      // No history yet (or unreadable): start empty.
    }
  }

  profiles(): Profile[] {
    return this.list;
  }

  profile(id: string): Profile | undefined {
    return this.list.find((p) => p.id === id);
  }

  addProfile(name: string, avatar: number): Profile {
    let id: string;
    do {
      id = crypto.randomBytes(4).toString('hex');
    } while (this.profile(id));
    const profile: Profile = { id, name, avatar, progress: {}, my_list: {}, dismissed: {} };
    this.list.push(profile);
    this.save();
    return profile;
  }

  updateProfile(id: string, name: string, avatar: number): boolean {
    const profile = this.profile(id);
    if (!profile) return false;
    profile.name = name;
    profile.avatar = avatar;
    this.save();
    return true;
  }

  removeProfile(id: string): boolean {
    const before = this.list.length;
    this.list = this.list.filter((p) => p.id !== id);
    if (this.list.length === before) return false;
    this.save();
    return true;
  }

  /** Playback of a file began. */
  recordStart(profileId: string, fileId: string, now: number): void {
    const profile = this.profile(profileId);
    if (!profile) return;
    const progress = (profile.progress[fileId] ??= emptyProgress());
    progress.plays += 1;
    progress.updated = now;
    this.save();
  }

  /** A position report while playing. Call flush() when playback ends. */
  recordPosition(profileId: string, fileId: string, position: number, duration: number, now: number): void {
    const profile = this.profile(profileId);
    if (!profile) return;
    const progress = (profile.progress[fileId] ??= emptyProgress());
    const wasCompleted = progress.completed;
    progress.position = position;
    if (duration > 0) progress.duration = duration;
    progress.completed = isFinished(position, progress.duration);
    progress.updated = now;
    this.dirty = true;
    if (progress.completed !== wasCompleted || now - this.lastSave >= SAVE_INTERVAL_SECONDS) {
      this.save();
      this.lastSave = now;
    }
  }

  /** Marks files watched (position jumps to the end) or unwatched (history cleared). */
  setWatched(profileId: string, fileIds: string[], watched: boolean, now: number): void {
    const profile = this.profile(profileId);
    if (!profile) return;
    for (const id of fileIds) {
      if (!watched) {
        delete profile.progress[id];
        continue;
      }
      const progress = (profile.progress[id] ??= emptyProgress());
      progress.position = progress.duration;
      progress.completed = true;
      progress.updated = now;
    }
    this.save();
  }

  /** Returns whether the title is in the list afterwards. */
  toggleMyList(profileId: string, titleId: string, now: number): boolean {
    const profile = this.profile(profileId);
    if (!profile) return false;
    const added = !(titleId in profile.my_list);
    if (added) profile.my_list[titleId] = now;
    else delete profile.my_list[titleId];
    this.save();
    return added;
  }

  /** Hides a title from Continue Watching until it's played again. */
  dismiss(profileId: string, titleId: string, now: number): void {
    const profile = this.profile(profileId);
    if (!profile) return;
    profile.dismissed[titleId] = now;
    this.save();
  }

  flush(): void {
    if (this.dirty) this.save();
  }

  private save(): void {
    writeFileSafely(this.file, JSON.stringify({ version: 1, profiles: this.list }, null, 1));
    this.dirty = false;
  }
}
