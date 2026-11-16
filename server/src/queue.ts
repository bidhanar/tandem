// The room's shared queue of YouTube videos. Pure functions, like room.ts.

import crypto from 'node:crypto';

export type QueueItem = {
  id: string; // this entry's own id (the same video can be queued twice)
  mediaId: string; // YouTube video id
  addedBy: string; // client id
};

export const MAX_QUEUE = 200;
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

/** Adds videos to the end. Anything that isn't a YouTube video id is skipped. */
export function addToQueue(queue: QueueItem[], mediaIds: unknown, clientId: string): QueueItem[] {
  if (!Array.isArray(mediaIds)) return queue;
  const added = mediaIds
    .filter((id): id is string => typeof id === 'string' && VIDEO_ID.test(id))
    .slice(0, MAX_QUEUE - queue.length)
    .map((mediaId) => ({ id: crypto.randomBytes(6).toString('hex'), mediaId, addedBy: clientId }));
  return added.length > 0 ? [...queue, ...added] : queue;
}

export function removeFromQueue(queue: QueueItem[], id: unknown): QueueItem[] {
  return queue.some((item) => item.id === id) ? queue.filter((item) => item.id !== id) : queue;
}

/** Takes one entry out to be played: the given one, or the first. */
export function takeFromQueue(queue: QueueItem[], id?: unknown): { item: QueueItem | null; queue: QueueItem[] } {
  const item = id === undefined ? queue[0] : queue.find((entry) => entry.id === id);
  if (!item) return { item: null, queue };
  return { item, queue: queue.filter((entry) => entry !== item) };
}
