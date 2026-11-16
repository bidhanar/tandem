import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  addWaiting, applyRequest, emptyState, expectedPosition, isRolling, removeWaiting, type RoomState,
} from '../src/room.ts';

const ME = 'client-a';
const PARTNER = 'client-b';
const BOTH = [ME, PARTNER];
const T0 = 1_000_000;

/** A room with a video loaded and both people ready, playing since T0. */
function playing(): RoomState {
  let state = applyRequest(emptyState(T0), { action: 'load', mediaType: 'youtube', mediaId: 'vid' }, ME, BOTH, T0)!;
  state = removeWaiting(state, ME, T0, 0);
  return removeWaiting(state, PARTNER, T0, 0);
}

test('a new room has nothing loaded and ignores play, pause and seek', () => {
  const state = emptyState(T0);
  assert.equal(state.version, 0);
  assert.equal(applyRequest(state, { action: 'play' }, ME, BOTH, T0), null);
  assert.equal(applyRequest(state, { action: 'pause' }, ME, BOTH, T0), null);
  assert.equal(applyRequest(state, { action: 'seek', position: 5 }, ME, BOTH, T0), null);
});

test('load sets the media and waits for everyone before starting', () => {
  const state = applyRequest(
    emptyState(T0), { action: 'load', mediaType: 'youtube', mediaId: 'vid', mediaTitle: 'A video' }, ME, BOTH, T0 + 5,
  )!;
  assert.deepEqual(
    [state.mediaType, state.mediaId, state.mediaTitle, state.isPlaying, state.position, state.version, state.updatedBy],
    ['youtube', 'vid', 'A video', true, 0, 1, ME],
  );
  assert.deepEqual(state.waitingFor, BOTH);
  assert.equal(isRolling(state, T0 + 10_000), false);
  assert.equal(expectedPosition(state, T0 + 10_000), 0);
});

test('playback starts when the last person is ready', () => {
  let state = applyRequest(emptyState(T0), { action: 'load', mediaType: 'youtube', mediaId: 'vid' }, ME, BOTH, T0)!;
  state = removeWaiting(state, ME, T0 + 800, 0);
  assert.equal(isRolling(state, T0 + 900), false);
  state = removeWaiting(state, PARTNER, T0 + 2000, 0);
  assert.equal(isRolling(state, T0 + 2000), true);
  assert.equal(expectedPosition(state, T0 + 5000), 3);
});

test('position advances while playing and holds while paused', () => {
  const state = playing();
  assert.equal(expectedPosition(state, T0 + 4000), 4);
  const paused = applyRequest(state, { action: 'pause', position: 4.2 }, PARTNER, BOTH, T0 + 4300)!;
  assert.deepEqual([paused.isPlaying, paused.position, paused.updatedBy], [false, 4.2, PARTNER]);
  assert.equal(expectedPosition(paused, T0 + 60_000), 4.2);
});

test('play resumes from where it was paused', () => {
  const paused = applyRequest(playing(), { action: 'pause', position: 10 }, ME, BOTH, T0 + 10_000)!;
  const resumed = applyRequest(paused, { action: 'play' }, PARTNER, BOTH, T0 + 30_000)!;
  assert.equal(resumed.position, 10);
  assert.equal(expectedPosition(resumed, T0 + 32_000), 12);
});

test('pause without a position uses where playback should be', () => {
  const paused = applyRequest(playing(), { action: 'pause' }, ME, BOTH, T0 + 7000)!;
  assert.equal(paused.position, 7);
});

test('seek moves the position and keeps playing or paused as it was', () => {
  const seeked = applyRequest(playing(), { action: 'seek', position: 120 }, ME, BOTH, T0 + 3000)!;
  assert.deepEqual([seeked.isPlaying, seeked.position], [true, 120]);
  assert.equal(expectedPosition(seeked, T0 + 4000), 121);

  const paused = applyRequest(seeked, { action: 'pause', position: 121 }, ME, BOTH, T0 + 4000)!;
  const seekedPaused = applyRequest(paused, { action: 'seek', position: 30 }, ME, BOTH, T0 + 9000)!;
  assert.deepEqual([seekedPaused.isPlaying, seekedPaused.position], [false, 30]);
});

test('every change raises the version by one and stamps who and when', () => {
  let state = playing();
  const start = state.version;
  state = applyRequest(state, { action: 'pause', position: 1 }, ME, BOTH, T0 + 1)!;
  state = applyRequest(state, { action: 'play' }, PARTNER, BOTH, T0 + 2)!;
  state = applyRequest(state, { action: 'seek', position: 9 }, ME, BOTH, T0 + 3)!;
  assert.equal(state.version, start + 3);
  assert.deepEqual([state.updatedAt, state.updatedBy], [T0 + 3, ME]);
});

test('last write wins', () => {
  const state = playing();
  const first = applyRequest(state, { action: 'seek', position: 50 }, ME, BOTH, T0 + 100)!;
  const second = applyRequest(first, { action: 'seek', position: 80 }, PARTNER, BOTH, T0 + 101)!;
  assert.deepEqual([second.position, second.updatedBy], [80, PARTNER]);
});

test('nonsense requests are ignored', () => {
  const state = playing();
  for (const request of [
    { action: 'seek' },
    { action: 'seek', position: -1 },
    { action: 'seek', position: Number.NaN },
    { action: 'pause', position: 'ten' },
    { action: 'dance' },
    { action: 'load', mediaType: 'vimeo', mediaId: 'x' },
    { action: 'load', mediaType: 'youtube', mediaId: '' },
    { action: 'load', mediaType: 'youtube' },
    null,
  ]) {
    assert.equal(applyRequest(state, request as any, ME, BOTH, T0 + 1), null, JSON.stringify(request));
  }
});

test('buffering holds the room at the current position, keeping the wish to play', () => {
  const stalled = addWaiting(playing(), PARTNER, T0 + 5000);
  assert.deepEqual([stalled.isPlaying, stalled.position, stalled.waitingFor], [true, 5, [PARTNER]]);
  assert.equal(expectedPosition(stalled, T0 + 9000), 5);

  const resumed = removeWaiting(stalled, PARTNER, T0 + 9000, 0);
  assert.equal(expectedPosition(resumed, T0 + 10_000), 6);
});

test('a countdown delays the restart for everyone', () => {
  const stalled = addWaiting(playing(), PARTNER, T0 + 5000);
  const resumed = removeWaiting(stalled, PARTNER, T0 + 9000, 3000);
  assert.equal(resumed.updatedAt, T0 + 12_000);
  assert.equal(isRolling(resumed, T0 + 11_000), false);
  assert.equal(expectedPosition(resumed, T0 + 11_000), 5);
  assert.equal(expectedPosition(resumed, T0 + 13_000), 6);
});

test('buffering during a pause does not start playback when it ends', () => {
  const paused = applyRequest(playing(), { action: 'pause', position: 3 }, ME, BOTH, T0 + 3000)!;
  const resumed = removeWaiting(addWaiting(paused, PARTNER, T0 + 4000), PARTNER, T0 + 6000, 0);
  assert.equal(isRolling(resumed, T0 + 7000), false);
  assert.equal(expectedPosition(resumed, T0 + 7000), 3);
});

test('a pause pressed while someone buffers stays a pause', () => {
  const stalled = addWaiting(playing(), PARTNER, T0 + 5000);
  const paused = applyRequest(stalled, { action: 'pause' }, ME, BOTH, T0 + 6000)!;
  assert.equal(paused.position, 5);
  assert.equal(isRolling(removeWaiting(paused, PARTNER, T0 + 8000, 0), T0 + 9000), false);
});

test('repeated buffer reports change nothing', () => {
  const state = playing();
  const stalled = addWaiting(state, PARTNER, T0 + 1000);
  assert.equal(addWaiting(stalled, PARTNER, T0 + 2000), stalled);
  assert.equal(removeWaiting(state, PARTNER, T0 + 2000, 0), state);
});

test('both buffering: resumes only when both are back', () => {
  let state = addWaiting(playing(), ME, T0 + 1000);
  state = addWaiting(state, PARTNER, T0 + 1500);
  state = removeWaiting(state, ME, T0 + 2000, 0);
  assert.equal(isRolling(state, T0 + 2500), false);
  state = removeWaiting(state, PARTNER, T0 + 3000, 0);
  assert.equal(expectedPosition(state, T0 + 4000), 2);
});

test('a restored room continues the media from where it had got to', async () => {
  const { restoredState } = await import('../src/room.ts');
  const state = restoredState(
    { mediaType: 'youtube', mediaId: 'vid', mediaTitle: 'A video', isPlaying: true, position: 95.5 }, T0,
  );
  assert.deepEqual(
    [state.mediaType, state.mediaId, state.mediaTitle, state.isPlaying, state.position, state.updatedAt, state.version, state.waitingFor],
    ['youtube', 'vid', 'A video', true, 95.5, T0, 1, []],
  );
  assert.equal(expectedPosition(state, T0 + 2000), 97.5);
});

test('a restore with bad or missing media gives an empty room', async () => {
  const { restoredState } = await import('../src/room.ts');
  for (const info of [null, 'x', {}, { mediaType: 'vimeo', mediaId: 'x' }, { mediaType: 'youtube', mediaId: '' }]) {
    const state = restoredState(info, T0);
    assert.deepEqual([state.mediaId, state.version, state.isPlaying], [null, 0, false], JSON.stringify(info));
  }
  const odd = restoredState({ mediaType: 'local', mediaId: 'v1.x', position: -4, isPlaying: 'yes' }, T0);
  assert.deepEqual([odd.position, odd.isPlaying], [0, false]);
});
