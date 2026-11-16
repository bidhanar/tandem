/**
 * Pulls the video id out of a YouTube link. Accepts watch, youtu.be, shorts,
 * embed and live links, with or without extra parameters (&t=, &list=, &si=),
 * and a bare 11-character id. Returns null for anything else.
 */
export function parseYouTubeId(input) {
  const text = String(input ?? '').trim();
  if (ID.test(text)) return text;

  let url;
  try {
    url = new URL(text.includes('://') ? text : `https://${text}`);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase().replace(/^(www|m)\./, '');
  const parts = url.pathname.split('/').filter(Boolean);

  let id = null;
  if (host === 'youtu.be') {
    id = parts[0];
  } else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    if (parts[0] === 'watch') id = url.searchParams.get('v');
    else if (parts.length >= 2 && PATH_PREFIXES.has(parts[0])) id = parts[1];
  }
  return id && ID.test(id) ? id : null;
}

const ID = /^[A-Za-z0-9_-]{11}$/;
const PATH_PREFIXES = new Set(['shorts', 'embed', 'live', 'v']);

/**
 * Reads pasted text that may hold several links (separated by spaces, commas
 * or new lines). Returns the video ids in order, and the ids of any playlists
 * (links to a playlist page; a link to one video inside a playlist counts as
 * just that video).
 */
export function parseYouTubeLinks(text) {
  const videos = [];
  const playlists = [];
  let unknown = 0;
  for (const token of String(text ?? '').split(/[\s,]+/).filter(Boolean)) {
    const playlist = parsePlaylistId(token);
    const video = playlist ? null : parseYouTubeId(token);
    if (playlist) playlists.push(playlist);
    else if (video) videos.push(video);
    else unknown += 1;
  }
  return { videos, playlists, unknown };
}

function parsePlaylistId(token) {
  let url;
  try {
    url = new URL(token.includes('://') ? token : `https://${token}`);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase().replace(/^(www|m)\./, '');
  const list = url.searchParams.get('list');
  if (host !== 'youtube.com' || url.pathname !== '/playlist' || !list) return null;
  return /^[A-Za-z0-9_-]{10,}$/.test(list) ? list : null;
}
