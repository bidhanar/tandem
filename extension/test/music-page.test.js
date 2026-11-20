import assert from 'node:assert/strict';
import { test } from 'node:test';

import { musicEndpoint, musicPageOf, musicShareablePath } from '../src/music-page.js';
import { samePage, watchPath } from '../src/youtube-page.js';

const CHANNEL = 'UCtIiZrzDsXk_rWeynT1ho4g';

test('songs', () => {
  assert.deepEqual(musicPageOf('/watch?v=i1o1p_DD6TU&list=RDAMVMi1o1p_DD6TU'),
    { kind: 'watch', videoId: 'i1o1p_DD6TU', start: 0, path: '/watch?v=i1o1p_DD6TU&list=RDAMVMi1o1p_DD6TU' });
  assert.equal(musicPageOf('https://music.youtube.com/watch?v=i1o1p_DD6TU').kind, 'watch');
  assert.equal(musicPageOf('/watch?v=short').kind, 'other');
  assert.deepEqual(musicEndpoint('/watch?v=i1o1p_DD6TU'), { watchEndpoint: { videoId: 'i1o1p_DD6TU' } });
  assert.deepEqual(musicEndpoint(watchPath('i1o1p_DD6TU', 75.9)), { watchEndpoint: { videoId: 'i1o1p_DD6TU', startTimeSeconds: 75 } });
});

test('places for finding something to listen to are followed, and open in place', () => {
  const expected = {
    '/': { browseEndpoint: { browseId: 'FEmusic_home' } },
    '/explore': { browseEndpoint: { browseId: 'FEmusic_explore' } },
    '/charts': { browseEndpoint: { browseId: 'FEmusic_charts' } },
    '/new_releases': { browseEndpoint: { browseId: 'FEmusic_new_releases' } },
    '/moods_and_genres': { browseEndpoint: { browseId: 'FEmusic_moods_and_genres' } },
    '/library': { browseEndpoint: { browseId: 'FEmusic_library_landing' } },
    '/search?q=daft+punk': { searchEndpoint: { query: 'daft punk' } },
    '/playlist?list=RDCLAK5uy_kCicKSTh7ylcZSwvrN0vV4dI3eqEpXR4A': { browseEndpoint: { browseId: 'VLRDCLAK5uy_kCicKSTh7ylcZSwvrN0vV4dI3eqEpXR4A' } },
    [`/channel/${CHANNEL}`]: { browseEndpoint: { browseId: CHANNEL } },
    '/browse/MPREb_LRyvIPGcPKM': { browseEndpoint: { browseId: 'MPREb_LRyvIPGcPKM' } },
  };
  for (const [path, endpoint] of Object.entries(expected)) {
    assert.equal(musicPageOf(path).kind, 'page', path);
    assert.deepEqual(musicEndpoint(path), endpoint, path);
  }
});

test('a channel by its handle is followed, but only opens by its id', () => {
  assert.equal(musicPageOf('/@shashwatsachdev').kind, 'page');
  assert.equal(musicEndpoint('/@shashwatsachdev'), null);
});

test('anything else is never followed', () => {
  for (const path of [
    '/logout', '/account', '/premium', '/upload', '/signin', '/search', '/search?q=', '/playlist',
    '/channel/UC123', `/channel/${CHANNEL}/extra`, '/browse/FEmusic_history', '/browse/VLsomething', '/@', '/@a/b',
    '/hasOwnProperty', '/constructor', '//evil.example/x', 'https://evil.example/', 'https://www.youtube.com/',
    'javascript:alert(1)',
  ]) {
    assert.equal(musicPageOf(path).kind, 'other', path);
    assert.equal(musicEndpoint(path), null, path);
  }
});

test('youtube.com pages that YouTube Music does not have are not followed', () => {
  for (const path of ['/results?search_query=cats', '/feed/trending', '/shorts/dQw4w9WgXcQ', '/hashtag/music']) {
    assert.equal(musicPageOf(path).kind, 'other', path);
  }
});

test('channels and albums are sent by id', () => {
  assert.equal(musicShareablePath('/@shashwatsachdev', CHANNEL), `/channel/${CHANNEL}`);
  assert.equal(musicShareablePath('/@shashwatsachdev', null), '/@shashwatsachdev'); // id not known: as it is
  assert.equal(musicShareablePath('/playlist?list=OLAK5uy_kCASMDAi_yW8u92E7a461A7VpWuDR_JO0', 'MPREb_LRyvIPGcPKM'), '/browse/MPREb_LRyvIPGcPKM');
  assert.equal(musicShareablePath('/playlist?list=RDCLAK5uy_k', 'VLRDCLAK5uy_k'), '/playlist?list=RDCLAK5uy_k'); // an ordinary playlist
  assert.equal(musicShareablePath('/search?q=a', CHANNEL), '/search?q=a');
  assert.equal(musicPageOf(musicShareablePath('/@shashwatsachdev', CHANNEL)).kind, 'page');
});

test('the same page, whatever else the address says', () => {
  assert.ok(samePage(musicPageOf('/watch?v=i1o1p_DD6TU'), musicPageOf('/watch?v=i1o1p_DD6TU&list=RDAMVMi1o1p_DD6TU')));
  assert.ok(!samePage(musicPageOf('/search?q=a'), musicPageOf('/search?q=b')));
});
