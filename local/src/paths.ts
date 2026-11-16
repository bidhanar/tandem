import path from 'node:path';

/** The page's files. This code runs from local/dist/src, so they are three levels up. */
export const WEB_DIR = path.resolve(import.meta.dirname, '..', '..', '..', 'web');
