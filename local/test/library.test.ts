import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { Catalog, fileId, normalizeKey, scanVideoFiles, type VideoFile } from '../src/catalog.ts';
import { computeUpNext, continueWatching } from '../src/feed.ts';
import { parseFilename } from '../src/filenameParser.ts';
import { isFinished, WatchState, type Profile } from '../src/watchState.ts';

function makeFile(filePath: string, height = 1080, size = 1000): VideoFile {
  return {
    id: fileId(filePath), path: filePath, size, mtime: 100,
    metadata: parseFilename(path.basename(filePath)), probed: true,
    info: { duration: 1000, width: 1920, height, codec: 'h264', hdr: false },
  };
}

const e1 = makeFile('/lib/Show.S01E01.mkv');
const e2 = makeFile('/lib/Show.S01E02.mkv');
const e3 = makeFile('/lib/Show.S01E03.mkv');
const movie = makeFile('/lib/Film.2010.mkv');
const catalog = new Catalog([e1, e2, e3, movie]);
const show = catalog.locate(e1.id)!.title;
const film = catalog.locate(movie.id)!.title;

const profileWith = (progress: Profile['progress'], dismissed: Profile['dismissed'] = {}): Profile =>
  ({ id: 'p', name: 'Test', avatar: 0, progress, my_list: {}, dismissed });
const played = (position: number, updated: number, completed = false) =>
  ({ position, duration: 1000, updated, completed, plays: 1 });

test('fileId is 16 hex digits and the same every time', () => {
  assert.equal(fileId(''), '14650fb0739d0383');
  assert.match(fileId('/videos/Film.mkv'), /^[0-9a-f]{16}$/);
  assert.equal(fileId('/videos/Film.mkv'), fileId('/videos/Film.mkv'));
  assert.notEqual(fileId('/videos/Film.mkv'), fileId('/videos/Film2.mkv'));
});

test('normalizeKey ignores case and punctuation', () => {
  assert.equal(normalizeKey('Rick & Morty'), normalizeKey('rick.and.morty'));
  assert.equal(normalizeKey("Grey's Anatomy"), 'greys anatomy');
});

test('groups episodes into a show and movies by name and year', () => {
  assert.equal(catalog.titles.length, 2);
  assert.equal(show.kind, 'show');
  assert.deepEqual(show.items.map((i) => i.episode), [1, 2, 3]);
  assert.equal(film.kind, 'movie');
  assert.equal(film.year, 2010);
  assert.equal(film.name, 'Film');
});

test('different spellings group together; specials go last; best copy first', () => {
  const hd = makeFile('/lib/rick.and.morty.s01e01.720p.mkv', 720);
  const uhd = makeFile('/lib/Rick & Morty/Rick & Morty - 1x01 - Pilot [2160p].mkv', 2160);
  const special = makeFile('/lib/Rick & Morty/Rick & Morty S00E01.mkv');
  const c = new Catalog([hd, uhd, special]);
  assert.equal(c.titles.length, 1);
  const title = c.titles[0]!;
  assert.equal(title.name, 'Rick & Morty');
  assert.deepEqual(title.items.map((i) => i.season), [1, 0]);
  assert.deepEqual(title.items[0]!.fileIds, [uhd.id, hd.id]);
});

test('an unnamed episode takes its show name from the folder', () => {
  const c = new Catalog([makeFile('/lib/Dark Matter/Season 1/S01E01.mkv')]);
  assert.equal(c.titles[0]!.name, 'Dark Matter');
});

test('up next: start, resume, next episode, rewatch', () => {
  assert.equal(computeUpNext(catalog, profileWith({}), show).reason, 'start');

  const resume = computeUpNext(catalog, profileWith({ [e2.id]: played(300, 50) }), show);
  assert.deepEqual([resume.reason, resume.item, resume.position], ['resume', 1, 300]);

  const next = computeUpNext(catalog, profileWith({ [e1.id]: played(1000, 50, true) }), show);
  assert.deepEqual([next.reason, next.item, next.position], ['next', 1, 0]);

  const rewatch = computeUpNext(catalog, profileWith({ [e3.id]: played(1000, 50, true) }), show);
  assert.deepEqual([rewatch.reason, rewatch.item], ['rewatch', 0]);

  const barely = computeUpNext(catalog, profileWith({ [movie.id]: played(4, 50) }), film);
  assert.deepEqual([barely.reason, barely.position], ['start', 0]);
});

test('continue watching: newest first, hides finished and dismissed titles', () => {
  const progress = { [e1.id]: played(1000, 10, true), [movie.id]: played(500, 20) };
  assert.deepEqual(continueWatching(catalog, profileWith(progress)).map((u) => u.title), [film, show]);
  assert.deepEqual(continueWatching(catalog, profileWith(progress, { [film.id]: 30 })).map((u) => u.title), [show]);
  assert.deepEqual(continueWatching(catalog, profileWith({ [movie.id]: played(1000, 20, true) })), []);
});

test('isFinished: last 5% or last 30 seconds', () => {
  assert.equal(isFinished(960, 1000), true);
  assert.equal(isFinished(900, 1000), false);
  assert.equal(isFinished(75, 100), true);
  assert.equal(isFinished(50, 0), false);
});

test('watch history survives a restart', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tandem-test-'));
  const file = path.join(dir, 'watch_state.json');
  const first = new WatchState(file);
  const profile = first.addProfile('Ana', 3);
  first.recordStart(profile.id, 'f1', 100);
  first.recordPosition(profile.id, 'f1', 980, 1000, 101);
  assert.equal(first.toggleMyList(profile.id, 't1', 102), true);

  const second = new WatchState(file).profile(profile.id)!;
  assert.equal(second.name, 'Ana');
  assert.deepEqual(second.progress.f1, { position: 980, duration: 1000, updated: 101, completed: true, plays: 1 });
  assert.deepEqual(second.my_list, { t1: 102 });

  const third = new WatchState(file);
  third.setWatched(profile.id, ['f1'], false, 103);
  assert.equal(new WatchState(file).profile(profile.id)!.progress.f1, undefined);
  fs.rmSync(dir, { recursive: true });
});

test('scan finds videos, skipping small files, hidden folders and other file types', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tandem-test-'));
  fs.mkdirSync(path.join(dir, 'Show', 'Season 1'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.hidden'));
  fs.writeFileSync(path.join(dir, 'Show', 'Season 1', 'Show.S01E01.mkv'), Buffer.alloc(2000));
  fs.writeFileSync(path.join(dir, 'Film.2010.MP4'), Buffer.alloc(2000));
  fs.writeFileSync(path.join(dir, 'sample.mkv'), Buffer.alloc(10));
  fs.writeFileSync(path.join(dir, 'notes.txt'), Buffer.alloc(2000));
  fs.writeFileSync(path.join(dir, '.hidden', 'Secret.mkv'), Buffer.alloc(2000));

  const files = await scanVideoFiles({ roots: [dir, path.join(dir, 'Show')], minSize: 1000 });
  assert.deepEqual(files.map((f) => path.basename(f.path)), ['Film.2010.MP4', 'Show.S01E01.mkv']);
  fs.rmSync(dir, { recursive: true });
});
