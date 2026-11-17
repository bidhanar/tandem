// Puts the extension together in dist/, the folder a browser loads:
// the files in src/, the sync logic shared with Tandem's page (web/), and
// the Socket.IO client. Run with `npm run build` after `npm install`.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, 'dist');

fs.rmSync(out, { recursive: true, force: true });
fs.cpSync(path.join(here, 'src'), out, { recursive: true });

for (const file of ['sync-core.js', 'sync-config.js']) {
  fs.copyFileSync(path.join(here, '..', 'web', file), path.join(out, file));
}

// The browser bundle of Socket.IO, without the pointer to a source map we don't ship.
const socketIo = fs.readFileSync(path.join(here, 'node_modules', 'socket.io-client', 'dist', 'socket.io.esm.min.js'), 'utf8');
fs.writeFileSync(path.join(out, 'socket.io.esm.min.js'), socketIo.replace(/\n\/\/# sourceMappingURL=.*\s*$/, '\n'));

// A sync server address to start with, for packages sent to someone.
const server = process.env.TANDEM_SYNC_SERVER?.trim().replace(/\/+$/, '');
if (server) {
  fs.writeFileSync(path.join(out, 'defaults.js'), `export const DEFAULT_SERVER = ${JSON.stringify(server)};\n`);
  console.log(`Sync server preset: ${server}`);
}

// The version lives in package.json.
const { version } = JSON.parse(fs.readFileSync(path.join(here, 'package.json'), 'utf8'));
const manifestPath = path.join(out, 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
manifest.version = version;
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`Built Tandem extension ${version} in ${path.relative(process.cwd(), out) || '.'}`);
