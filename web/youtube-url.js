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
