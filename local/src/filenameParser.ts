// Ported from Synaxis (src/filename_parser.cpp), GPL-3.0-or-later,
// Copyright (C) 2026 Azhar Tanweer.

import path from 'node:path';

/**
 * What a video's filename says about it. Fields are null/empty when the name
 * doesn't carry them. `title` is the series or movie name; `episodeTitle` is
 * the episode's own name when the filename has one ("... S01E01 - Pilot [720p]").
 */
export type ParsedFilename = {
  season: number | null;
  episode: number | null;
  year: number | null;
  source: string | null; // WEB-DL, BluRay, HDTV, CAM, ...
  title: string | null;
  tags: string[]; // PROPER, REPACK, IMAX, HDR, AMZN, NF
  episodeTitle: string | null;
};

const STANDARD_EPISODE = /[Ss](\d{1,2})[Ee](\d{1,2})/; // S01E01
const ALT_EPISODE = /\b(\d{1,2})x(\d{2})\b/; // 1x04 (but not the x in x264)
const YEAR = /\(?\b(19\d{2}|20\d{2})\b\)?/;
const SOURCE = /\b(WEB-DL|WEBRip|BluRay|BrRip|BDRip|DVDRip|HDRip|HDTV|HDTS|CAM)\b/i;
const TAG = /\b(PROPER|REPACK|IMAX|HDR|AMZN|NF)\b/gi;
// The first piece of release metadata after an episode marker.
const EPISODE_TITLE_END = new RegExp(
  String.raw`\[|\(|\b(?:\d{3,4}[pi]|[xh]\.?26[45]|HEVC|XviD|10.?bit|(?:19|20)\d{2}|` +
    String.raw`WEB-DL|WEBRip|BluRay|BrRip|BDRip|DVDRip|HDRip|HDTV|HDTS|CAM|` +
    String.raw`PROPER|REPACK|IMAX|HDR|AMZN|NF|UHD)\b`,
  'i',
);

/** Drops a leading "[GROUP]" tag and turns dots/underscores into spaces. */
function cleanTitle(raw: string): string {
  return raw
    .replace(/^\s*\[[^\]]*\]\s*/, '')
    .replace(/[._]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[ \-._]+|[ \-._]+$/g, '');
}

export function parseFilename(filename: string): ParsedFilename {
  const result: ParsedFilename = {
    season: null,
    episode: null,
    year: null,
    source: null,
    title: null,
    tags: [],
    episodeTitle: null,
  };

  // The leftmost marker is where the title ends and release details begin.
  let titleEnd: number | null = null;
  const marker = (index: number) => {
    if (titleEnd === null || index < titleEnd) titleEnd = index;
  };

  let episodeMarkerEnd: number | null = null;
  const episode = STANDARD_EPISODE.exec(filename) ?? ALT_EPISODE.exec(filename);
  if (episode) {
    result.season = Number(episode[1]);
    result.episode = Number(episode[2]);
    marker(episode.index);
    episodeMarkerEnd = episode.index + episode[0].length;
  }

  const year = YEAR.exec(filename);
  if (year) {
    result.year = Number(year[1]);
    marker(year.index);
  }

  const source = SOURCE.exec(filename);
  if (source) {
    result.source = source[1]!;
    marker(source.index);
  }

  for (const tag of filename.matchAll(TAG)) {
    result.tags.push(tag[1]!);
    marker(tag.index);
  }

  const stem = path.parse(filename).name;
  const title = cleanTitle(titleEnd === null ? stem : filename.slice(0, titleEnd));
  if (title) result.title = title;

  if (episodeMarkerEnd !== null && episodeMarkerEnd < stem.length) {
    let rest = stem.slice(episodeMarkerEnd);
    const end = EPISODE_TITLE_END.exec(rest);
    if (end) rest = rest.slice(0, end.index);
    const episodeTitle = cleanTitle(rest);
    if (episodeTitle) result.episodeTitle = episodeTitle;
  }
  return result;
}
