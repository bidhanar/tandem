import assert from 'node:assert/strict';
import { test } from 'node:test';

import { addToQueue, MAX_QUEUE, removeFromQueue, takeFromQueue } from '../src/queue.ts';

const A = 'aaaaaaaaaaa', B = 'bbbbbbbbbbb', C = 'ccccccccccc';

test('adds valid video ids in order and skips anything else', () => {
  const queue = addToQueue([], [A, 'not an id', 42, B, null], 'ana');
  assert.deepEqual(queue.map((item) => item.mediaId), [A, B]);
  assert.ok(queue.every((item) => item.addedBy === 'ana' && item.id.length > 0));
  assert.notEqual(queue[0]!.id, queue[1]!.id);
});

test('nothing valid to add leaves the queue untouched', () => {
  const queue = addToQueue([], [A], 'ana');
  assert.equal(addToQueue(queue, ['nope'], 'ben'), queue);
  assert.equal(addToQueue(queue, 'aaaaaaaaaaa', 'ben'), queue);
});

test('the same video can be queued twice', () => {
  const queue = addToQueue(addToQueue([], [A], 'ana'), [A], 'ben');
  assert.equal(queue.length, 2);
});

test('the queue has a size limit', () => {
  const many = Array.from({ length: MAX_QUEUE + 50 }, () => A);
  assert.equal(addToQueue([], many, 'ana').length, MAX_QUEUE);
});

test('removes one entry by its id', () => {
  const queue = addToQueue([], [A, B, C], 'ana');
  const after = removeFromQueue(queue, queue[1]!.id);
  assert.deepEqual(after.map((item) => item.mediaId), [A, C]);
  assert.equal(removeFromQueue(queue, 'missing'), queue);
});

test('takes the first entry, or a chosen one', () => {
  const queue = addToQueue([], [A, B, C], 'ana');
  const first = takeFromQueue(queue);
  assert.equal(first.item?.mediaId, A);
  assert.deepEqual(first.queue.map((item) => item.mediaId), [B, C]);

  const chosen = takeFromQueue(queue, queue[2]!.id);
  assert.equal(chosen.item?.mediaId, C);
  assert.deepEqual(chosen.queue.map((item) => item.mediaId), [A, B]);

  assert.equal(takeFromQueue([]).item, null);
  assert.equal(takeFromQueue(queue, 'missing').item, null);
});
