// Ported from Synaxis (src/feed.cpp), GPL-3.0-or-later,
// Copyright (C) 2026 Azhar Tanweer.

import type { Catalog, Title, TitleItem } from './catalog.ts';
import { MIN_RESUME_SECONDS, type Profile, type Progress } from './watchState.ts';

export type UpNextReason =
  | 'start' // never watched (or barely): start at the beginning
  | 'resume' // stopped partway: pick up where they left off
  | 'next' // finished an episode: on to the next one
  | 'rewatch'; // finished everything: back to the start

/** What pressing Play on a title should do for a profile. */
export type UpNext = {
  title: Title;
  item: number; // index into title.items
  fileId: string; // which copy to play
  position: number; // seconds to start at
  duration: number; // seconds, 0 if unknown
  reason: UpNextReason;
  lastActivity: number; // newest progress update on the title; 0 if none
};

/** The most recently touched copy of an item, if any copy was ever played. */
function latestProgress(profile: Profile, item: TitleItem): { progress: Progress; fileId: string } | null {
  let latest: { progress: Progress; fileId: string } | null = null;
  for (const fileId of item.fileIds) {
    const progress = profile.progress[fileId];
    if (progress && (!latest || progress.updated > latest.progress.updated)) latest = { progress, fileId };
  }
  return latest;
}

/** Starting an item fresh, or resuming it if it was left partway through. */
function startOrResume(catalog: Catalog, profile: Profile, title: Title, item: number, fresh: UpNextReason): UpNext {
  const up: UpNext = {
    title,
    item,
    fileId: title.items[item]!.fileIds[0]!,
    position: 0,
    duration: 0,
    reason: fresh,
    lastActivity: 0,
  };
  const latest = latestProgress(profile, title.items[item]!);
  if (latest && !latest.progress.completed && latest.progress.position >= MIN_RESUME_SECONDS) {
    up.fileId = latest.fileId;
    up.position = latest.progress.position;
    up.reason = 'resume';
  }
  up.duration =
    latest && latest.progress.duration > 0
      ? latest.progress.duration
      : (catalog.findFile(up.fileId)?.info?.duration ?? 0);
  return up;
}

export function computeUpNext(catalog: Catalog, profile: Profile, title: Title): UpNext {
  // Find the item touched most recently.
  let lastItem: number | null = null;
  let lastActivity = 0;
  let last: Progress | null = null;
  title.items.forEach((item, index) => {
    const latest = latestProgress(profile, item);
    if (latest && latest.progress.updated >= lastActivity) {
      lastItem = index;
      lastActivity = latest.progress.updated;
      last = latest.progress;
    }
  });

  let up: UpNext;
  if (lastItem === null) {
    up = startOrResume(catalog, profile, title, 0, 'start');
  } else if (!last!.completed) {
    up = startOrResume(catalog, profile, title, lastItem, 'start');
  } else if (title.kind === 'show' && lastItem + 1 < title.items.length) {
    up = startOrResume(catalog, profile, title, lastItem + 1, 'next');
  } else {
    up = startOrResume(catalog, profile, title, 0, 'rewatch');
    up.position = 0;
    up.reason = 'rewatch';
  }
  up.lastActivity = lastActivity;
  return up;
}

/**
 * Titles with something to pick up (a resume point or the next episode), most
 * recently watched first, minus ones dismissed since they were last played.
 */
export function continueWatching(catalog: Catalog, profile: Profile): UpNext[] {
  const result: UpNext[] = [];
  for (const title of catalog.titles) {
    const up = computeUpNext(catalog, profile, title);
    if (up.lastActivity === 0) continue;
    if (up.reason !== 'resume' && up.reason !== 'next') continue;
    const dismissed = profile.dismissed[title.id];
    if (dismissed !== undefined && dismissed >= up.lastActivity) continue;
    result.push(up);
  }
  return result.sort((a, b) => b.lastActivity - a.lastActivity);
}
