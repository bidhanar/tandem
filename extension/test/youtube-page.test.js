import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  inviteCode, inviteLink, pageOf, parseStart, samePage, shareablePath, videoIdOf, watchPath,
} from '../src/youtube-page.js';

test('video pages', () => {
  assert.deepEqual(pageOf('/watch?v=dQw4w9WgXcQ'), { kind: 'watch', videoId: 'dQw4w9WgXcQ', start: 0, path: '/watch?v=dQw4w9WgXcQ' });
  assert.equal(pageOf('/watch?v=dQw4w9WgXcQ&t=1m30s&list=PL123').start, 90);
  assert.equal(pageOf('https://www.youtube.com/watch?v=dQw4w9WgXcQ').kind, 'watch');
  assert.equal(pageOf('/watch?v=short').kind, 'other');
  assert.equal(pageOf('/watch').kind, 'other');
});

test('start times', () => {
  assert.equal(parseStart('90'), 90);
  assert.equal(parseStart('90s'), 90);
  assert.equal(parseStart('1h2m3s'), 3723);
  assert.equal(parseStart('2m'), 120);
  assert.equal(parseStart(null), 0);
  assert.equal(parseStart('soon'), 0);
});

test('places for finding something to watch are followed', () => {
  for (const path of [
    '/', '/results?search_query=cats', '/playlist?list=PL123', '/@SomeChannel', '/@SomeChannel/videos',
    '/channel/UC123', '/feed/trending', '/feed/subscriptions', '/shorts/dQw4w9WgXcQ', '/hashtag/music',
  ]) {
    assert.equal(pageOf(path).kind, 'page', path);
  }
});

test('anything else is never followed', () => {
  for (const path of [
    '/logout', '/account', '/account_privacy', '/premium', '/upload', '/signin', '/feed/unknown',
    '/results', '/playlist', '/@', '//evil.example/x', 'https://evil.example/', 'https://m.youtube.com/',
    'javascript:alert(1)',
  ]) {
    assert.equal(pageOf(path).kind, 'other', path);
  }
});

test('the same video is the same page, whatever else the address says', () => {
  assert.ok(samePage(pageOf('/watch?v=dQw4w9WgXcQ'), pageOf('/watch?v=dQw4w9WgXcQ&t=10s')));
  assert.ok(!samePage(pageOf('/watch?v=dQw4w9WgXcQ'), pageOf('/watch?v=jNQXAC9IVRw')));
  assert.ok(samePage(pageOf('/results?search_query=a'), pageOf('/results?search_query=a')));
  assert.ok(!samePage(pageOf('/results?search_query=a'), pageOf('/results?search_query=b')));
  assert.ok(!samePage(pageOf('/'), null));
});

test('video addresses', () => {
  assert.equal(watchPath('dQw4w9WgXcQ'), '/watch?v=dQw4w9WgXcQ');
  assert.equal(watchPath('dQw4w9WgXcQ', 75.9), '/watch?v=dQw4w9WgXcQ&t=75s');
  assert.equal(pageOf(watchPath('dQw4w9WgXcQ', 75.9)).start, 75);
});

test('channel addresses YouTube can only open with a reload are sent by id', () => {
  const id = 'UCSMOQeBJ2RAnuFungnQOxLg';
  assert.equal(shareablePath('/@BlenderOfficial', id), `/channel/${id}`);
  assert.equal(shareablePath('/@BlenderOfficial/videos', id), `/channel/${id}/videos`);
  assert.equal(shareablePath('/c/BlenderFoundation/playlists?view=1', id), `/channel/${id}/playlists?view=1`);
  assert.equal(shareablePath('/@BlenderOfficial', null), '/@BlenderOfficial'); // id not known: as it is
  assert.equal(shareablePath('/@BlenderOfficial', 'FEtrending'), '/@BlenderOfficial'); // not a channel id
  assert.equal(shareablePath('/results?search_query=a', id), '/results?search_query=a');
  assert.equal(pageOf(shareablePath('/@BlenderOfficial', id)).kind, 'page');
});

test('invite links', () => {
  assert.equal(inviteLink('K7QPXM', 'dQw4w9WgXcQ'), 'https://www.youtube.com/watch?v=dQw4w9WgXcQ#tandem=K7QPXM');
  assert.equal(inviteLink('K7QPXM', null), 'https://www.youtube.com/#tandem=K7QPXM');
  assert.equal(inviteCode('#tandem=K7QPXM'), 'K7QPXM');
  assert.equal(inviteCode('#tandem=k7qpxm'), 'K7QPXM');
  assert.equal(inviteCode('#t=10&tandem=K7QPXM'), 'K7QPXM');
  assert.equal(inviteCode('#tandem=<script>'), null);
  assert.equal(inviteCode('#something'), null);
  assert.equal(inviteCode(''), null);
});

test('the video a link points to', () => {
  assert.equal(videoIdOf('https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL1'), 'dQw4w9WgXcQ');
  assert.equal(videoIdOf('https://youtu.be/dQw4w9WgXcQ?t=5'), 'dQw4w9WgXcQ');
  assert.equal(videoIdOf('https://m.youtube.com/watch?v=dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.equal(videoIdOf('https://www.youtube.com/shorts/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.equal(videoIdOf('https://www.youtube.com/@someone'), null);
  assert.equal(videoIdOf('https://example.com/watch?v=dQw4w9WgXcQ'), null);
  assert.equal(videoIdOf('not a link'), null);
});
