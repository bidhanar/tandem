// What a youtube.com address is, as far as watching together goes. No page,
// network or browser APIs in here, so it can be unit tested.
//
// A page is one of:
//   { kind: 'watch', videoId, start, path }  a video (start: seconds from &t=, or 0)
//   { kind: 'page', path }                   somewhere your partner's tab may follow you to
//   { kind: 'other', path }                  anything else; never sent or followed
//
// Your partner can make your tab open any 'page', so only places for
// finding something to watch are on the list. Account settings, sign-out,
// uploads and the like are not.

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

/** Pages that are followed, by their first path segment. */
const FOLLOWED = new Set(['results', 'playlist', 'feed', 'channel', 'c', 'user', 'shorts', 'hashtag', 'gaming', 'podcasts']);
/** Under /feed/, the ones that are for browsing. */
const FEEDS = new Set(['trending', 'explore', 'subscriptions', 'history', 'playlists', 'library', 'you', 'music', 'gaming', 'news', 'sports', 'courses', 'podcasts']);

/** Reads `t` from a watch link: 90, 90s, 1m30s or 1h2m3s. */
export function parseStart(value) {
  const text = String(value ?? '').trim();
  if (/^\d+$/.test(text)) return Number(text);
  const parts = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(text);
  if (!text || !parts) return 0;
  const [, h = 0, m = 0, s = 0] = parts;
  return Number(h) * 3600 + Number(m) * 60 + Number(s);
}

/**
 * Describes a path on youtube.com, including its query: '/watch?v=…', '/results?search_query=…'.
 * Also accepts a full https://www.youtube.com address.
 */
export function pageOf(address) {
  let url;
  try {
    url = new URL(String(address ?? ''), 'https://www.youtube.com');
  } catch {
    return { kind: 'other', path: '' };
  }
  const path = url.pathname + url.search;
  if (url.origin !== 'https://www.youtube.com') return { kind: 'other', path };

  const parts = url.pathname.split('/').filter(Boolean);
  if (url.pathname === '/watch') {
    const videoId = url.searchParams.get('v');
    if (videoId && VIDEO_ID.test(videoId)) return { kind: 'watch', videoId, start: parseStart(url.searchParams.get('t')), path };
    return { kind: 'other', path };
  }
  if (parts.length === 0) return { kind: 'page', path };
  const [first, second] = parts;
  if (first.startsWith('@') && first.length > 1) return { kind: 'page', path }; // a channel
  if (!FOLLOWED.has(first)) return { kind: 'other', path };
  if (first === 'feed' && !FEEDS.has(second)) return { kind: 'other', path };
  if (first === 'results' && !url.searchParams.get('search_query')) return { kind: 'other', path };
  if (first === 'playlist' && !url.searchParams.get('list')) return { kind: 'other', path };
  return { kind: 'page', path };
}

/** Whether two pages show the same thing. A video is the same video whatever else its address says. */
export function samePage(a, b) {
  if (!a || !b || a.kind !== b.kind) return false;
  if (a.kind === 'watch') return a.videoId === b.videoId;
  return a.path === b.path;
}

const CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;

/**
 * The address to send your partner for a page. YouTube opens /@handle and
 * /c/name channel addresses only with a full page load, which would take
 * their tab out of the room for a moment, so those go as /channel/<id>,
 * which it opens in place. `channelId` is the channel's id, if known.
 */
export function shareablePath(path, channelId) {
  if (!CHANNEL_ID.test(channelId ?? '')) return path;
  const url = new URL(path, 'https://www.youtube.com');
  const [first, ...rest] = url.pathname.split('/').filter(Boolean);
  let tail;
  if (first?.startsWith('@')) tail = rest;
  else if (first === 'c' && rest.length > 0) tail = rest.slice(1);
  else return path;
  return `/channel/${channelId}${tail.map((part) => `/${part}`).join('')}${url.search}`;
}

/** The address of a video, starting at `seconds`. */
export function watchPath(videoId, seconds = 0) {
  const start = Math.floor(Math.max(0, seconds || 0));
  return `/watch?v=${videoId}${start > 0 ? `&t=${start}s` : ''}`;
}
