import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { parseFilename } from '../src/filenameParser.ts';

type Expected = {
  path: string; season: number | null; episode: number | null; year: number | null;
  source: string | null; tags: string[]; title: string | null;
};

// The same ground truth Synaxis tests its parser against.
const fixture = JSON.parse(
  // Tests run from local/dist/test; the fixture stays in local/test/fixtures.
  fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'test', 'fixtures', 'expected_metadata.json'), 'utf8'),
) as { entries: Expected[] };

test('parses every fixture filename as expected', () => {
  assert.ok(fixture.entries.length > 30);
  for (const expected of fixture.entries) {
    const parsed = parseFilename(path.basename(expected.path));
    const got = { season: parsed.season, episode: parsed.episode, year: parsed.year,
      source: parsed.source, tags: parsed.tags, title: parsed.title };
    const want = { season: expected.season, episode: expected.episode, year: expected.year,
      source: expected.source, tags: expected.tags, title: expected.title };
    assert.deepEqual(got, want, expected.path);
  }
});

test('reads an episode title when the filename has one', () => {
  assert.equal(parseFilename('Crimson Static - S01E01 - Pilot [720p] [HDTV] [x264].mkv').episodeTitle, 'Pilot');
  assert.equal(parseFilename('Show.S02E03.The.Long.Night.1080p.WEB-DL.x264.mkv').episodeTitle, 'The Long Night');
  assert.equal(parseFilename('The.Silent.Orbit.S01E01.1080p.WEB-DL.x264-SPARKS.mkv').episodeTitle, null);
});

test('a name with no markers is all title', () => {
  const parsed = parseFilename('holiday_video.mp4');
  assert.equal(parsed.title, 'holiday video');
  assert.equal(parsed.season, null);
  assert.equal(parsed.year, null);
});
