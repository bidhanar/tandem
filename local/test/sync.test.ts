import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { Catalog, fileId, type VideoFile } from '../src/catalog.ts';
import { parseFilename } from '../src/filenameParser.ts';
import { findMatch, hashEnds, makeMediaId, mediaIdOf, parseMediaId } from '../src/fingerprint.ts';
import { PositionEstimator } from '../src/positionEstimator.ts';

function fileOn(disk: string, name: string, content: Buffer, duration: number): VideoFile {
  const filePath = path.join(disk, name);
  fs.writeFileSync(filePath, content);
  return {
    id: fileId(filePath), path: filePath, size: content.length, mtime: 1,
    metadata: parseFilename(name), probed: true,
    info: { duration, width: 1920, height: 1080, codec: 'h264', hdr: false },
  };
}

test('media ids round-trip and reject anything else', () => {
  const id = { hash: 'ab'.repeat(16), size: 123456789, duration: 5400 };
  assert.deepEqual(parseMediaId(makeMediaId(id)), id);
  assert.equal(makeMediaId({ ...id, duration: 5400.4 }), makeMediaId(id));
  for (const bad of ['', 'dQw4w9WgXcQ', 'v1.xyz.1.1', 'v2.' + 'ab'.repeat(16) + '.1.1']) {
    assert.equal(parseMediaId(bad), null, bad);
  }
});

test('the hash covers the first and last 4 MB, and the whole of a small file', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mendu-test-'));
  const big = Buffer.alloc(9 * 1024 * 1024, 1);
  const file = path.join(dir, 'a.bin');
  fs.writeFileSync(file, big);
  const original = await hashEnds(file, big.length);

  big[4 * 1024 * 1024 + 100] = 2; // the middle isn't read
  fs.writeFileSync(file, big);
  assert.equal(await hashEnds(file, big.length), original);

  big[big.length - 1] = 2; // the end is
  fs.writeFileSync(file, big);
  assert.notEqual(await hashEnds(file, big.length), original);

  const small = path.join(dir, 'b.bin');
  fs.writeFileSync(small, Buffer.from('hello'));
  const smallHash = await hashEnds(small, 5);
  fs.writeFileSync(small, Buffer.from('hellp'));
  assert.notEqual(await hashEnds(small, 5), smallHash);
  fs.rmSync(dir, { recursive: true });
});

test('matching: the same file, another copy of the same length, or nothing', async () => {
  const mine = fs.mkdtempSync(path.join(os.tmpdir(), 'mendu-mine-'));
  const theirs = fs.mkdtempSync(path.join(os.tmpdir(), 'mendu-theirs-'));
  const film = Buffer.alloc(5000, 7);

  const sent = fileOn(mine, 'Film.2010.mkv', film, 5400);
  const wanted = parseMediaId(await mediaIdOf(sent))!;

  // Same bytes under a different name and folder: an exact match.
  const same = fileOn(theirs, 'film (2010) renamed.mkv', film, 5400);
  const sameSizeOtherBytes = fileOn(theirs, 'Other.mkv', Buffer.alloc(5000, 9), 300);
  let match = await findMatch(new Catalog([same, sameSizeOtherBytes]), wanted);
  assert.equal(match.exact?.path, same.path);

  // A different encode of the same film: same length, different bytes.
  const otherCopy = fileOn(theirs, 'Film.2010.720p.mkv', Buffer.alloc(3000, 3), 5400.6);
  match = await findMatch(new Catalog([otherCopy, sameSizeOtherBytes]), wanted);
  assert.equal(match.exact, null);
  assert.deepEqual(match.sameLength.map((f) => f.path), [otherCopy.path]);

  // Nothing like it.
  match = await findMatch(new Catalog([sameSizeOtherBytes]), wanted);
  assert.deepEqual([match.exact, match.sameLength], [null, []]);

  fs.rmSync(mine, { recursive: true });
  fs.rmSync(theirs, { recursive: true });
});

test('stepped VLC readings become a smooth position', () => {
  const estimator = new PositionEstimator(100);
  let now = 10_000;
  let truth = 50;
  let reported = truth;
  let worst = 0;
  for (let i = 0; i < 100; i++) {
    now += 100;
    truth += 0.1;
    if (i % 4 === 0) reported = truth; // VLC refreshes its value every 400 ms
    const { position, stalled } = estimator.update(reported, true, 1, now);
    if (i > 4) worst = Math.max(worst, Math.abs(position - truth));
    assert.equal(stalled, false);
  }
  assert.ok(worst <= 0.06, `worst error ${worst.toFixed(3)} s`); // raw readings are up to 0.4 s old
});

test('paused readings are used as they are, and a seek is followed at once', () => {
  const estimator = new PositionEstimator(100);
  assert.equal(estimator.update(20, false, 1, 1000).position, 20);
  assert.equal(estimator.update(20, false, 1, 5000).position, 20);
  assert.equal(estimator.update(300, false, 1, 5100).position, 300);
  const resumed = estimator.update(300, true, 1, 5200).position;
  assert.ok(resumed >= 300 && resumed < 300.2);
});

test('a value that stops moving while "playing" is reported as stuck', () => {
  const estimator = new PositionEstimator(100);
  estimator.update(10, true, 1, 1000);
  assert.equal(estimator.update(10, true, 1, 1500).stalled, false);
  const stuck = estimator.update(10, true, 1, 2600);
  assert.deepEqual([stuck.stalled, stuck.position], [true, 10]);
  assert.equal(estimator.update(10.4, true, 1, 2700).stalled, false);
});
