// What a music.youtube.com address is, as far as listening together goes:
// youtube-page.js's counterpart for YouTube Music. No page, network or
// browser APIs in here, so it can be unit tested.
//
// A page is one of the same three kinds:
//   { kind: 'watch', videoId, start, path }  a song (YouTube Music's player page)
//   { kind: 'page', path }                   somewhere your partner's tab may follow you to
//   { kind: 'other', path }                  anything else; never sent or followed
//
// YouTube Music opens a page in place only when told what the page is (an
// "endpoint": a browse id, a search, a video), not from its address, so
// musicEndpoint() makes one. Paths that exist on both sites (/, /channel/…,
// /playlist?list=…) mean the same on both, so a youtube.com tab and a
// YouTube Music tab in one room follow each other there.

import { parseStart } from './youtube-page.js';

const ORIGIN = 'https://music.youtube.com';
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;
const ALBUM_ID = /^MPREb_[A-Za-z0-9_-]+$/;
const LIST_ID = /^[A-Za-z0-9_-]{2,80}$/;

/** Pages with a fixed address, and the browse id YouTube Music opens each by. */
const PLACES = {
  '/': 'FEmusic_home',
  '/explore': 'FEmusic_explore',
  '/charts': 'FEmusic_charts',
  '/new_releases': 'FEmusic_new_releases',
  '/moods_and_genres': 'FEmusic_moods_and_genres',
  '/library': 'FEmusic_library_landing',
};

/** The page at an address, and the endpoint that opens it in place (null if none does). */
function parse(address) {
  let url;
  try {
    url = new URL(String(address ?? ''), ORIGIN);
  } catch {
    return { page: { kind: 'other', path: '' }, endpoint: null };
  }
  const path = url.pathname + url.search;
  const other = { page: { kind: 'other', path }, endpoint: null };
  if (url.origin !== ORIGIN) return other;
  const page = (endpoint) => ({ page: { kind: 'page', path }, endpoint });
  const browse = (browseId) => page({ browseEndpoint: { browseId } });
  const param = (name) => url.searchParams.get(name) ?? '';
  const [first, second, ...rest] = url.pathname.split('/').filter(Boolean);

  if (url.pathname === '/watch') {
    const videoId = param('v');
    if (!VIDEO_ID.test(videoId)) return other;
    const start = parseStart(param('t'));
    return {
      page: { kind: 'watch', videoId, start, path },
      endpoint: { watchEndpoint: { videoId, ...(start > 0 ? { startTimeSeconds: start } : {}) } },
    };
  }
  if (Object.hasOwn(PLACES, url.pathname)) return browse(PLACES[url.pathname]);
  if (url.pathname === '/search' && param('q').trim()) return page({ searchEndpoint: { query: param('q') } });
  if (url.pathname === '/playlist' && LIST_ID.test(param('list'))) return browse(`VL${param('list')}`);
  if (first === 'channel' && CHANNEL_ID.test(second ?? '') && !rest.length) return browse(second);
  if (first === 'browse' && ALBUM_ID.test(second ?? '') && !rest.length) return browse(second); // an album
  // A channel by its handle: followed, but sent by its id (musicShareablePath), which is what opens it.
  if (first?.startsWith('@') && first.length > 1 && !second) return page(null);
  return other;
}

/** Describes a path on music.youtube.com, including its query. Also accepts a full address. */
export function musicPageOf(address) {
  return parse(address).page;
}

/**
 * What YouTube Music needs to be given to open a page in place, or null.
 * `{ watchEndpoint: { videoId } }` plays a song; `{ browseEndpoint: … }` and
 * `{ searchEndpoint: … }` open the other pages.
 */
export function musicEndpoint(address) {
  return parse(address).endpoint;
}

/**
 * The address to send your partner for a page. YouTube Music shows a
 * channel as /@handle and an album as /playlist?list=OLAK…, but opens them
 * only by their ids, so those go as /channel/<id> and /browse/<album id>.
 * `browseId` is the id the page was opened with, if known.
 */
export function musicShareablePath(path, browseId) {
  const { pathname } = new URL(path, ORIGIN);
  if (pathname.startsWith('/@') && CHANNEL_ID.test(browseId ?? '')) return `/channel/${browseId}`;
  if (pathname === '/playlist' && ALBUM_ID.test(browseId ?? '')) return `/browse/${browseId}`;
  return path;
}
