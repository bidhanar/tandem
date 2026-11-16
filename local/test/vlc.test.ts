import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseVlcStatus, vlcArguments } from '../src/vlc.ts';

test('reads a playing status, using the precise fraction for position', () => {
  const s = parseVlcStatus(JSON.stringify({
    state: 'playing', time: 42, length: 90, position: 0.4725, rate: 1.05,
    information: { category: { meta: { filename: 'Film.mkv' } } },
  }))!;
  assert.equal(s.state, 'playing');
  assert.ok(Math.abs(s.position - 42.525) < 1e-9);
  assert.equal(s.duration, 90);
  assert.equal(s.rate, 1.05);
  assert.equal(s.filename, 'Film.mkv');
});

test('stopped status has no length', () => {
  const s = parseVlcStatus('{"state":"stopped","length":-1,"position":0,"rate":1}')!;
  assert.deepEqual([s.state, s.position, s.duration, s.filename], ['stopped', 0, 0, '']);
});

test('ignores replies that are not a status', () => {
  assert.equal(parseVlcStatus('<html>401 Unauthorized</html>'), null);
  assert.equal(parseVlcStatus('[]'), null);
  assert.equal(parseVlcStatus('{"length":90}'), null);
});

test('command line: control interface on this computer only, resume point on the first item', () => {
  const args = vlcArguments({ executable: 'vlc', fullscreen: true }, [
    { fileId: 'a', path: '/v/one.mkv', title: 'Show · S1:E1', start: 61.26 },
    { fileId: 'b', path: '/v/two.mkv', title: 'Show · S1:E2', start: 0 },
  ], 4242, 'secret');
  for (const flag of ['--extraintf=http', '--http-host=127.0.0.1', '--http-port=4242', '--http-password=secret', '--fullscreen']) {
    assert.ok(args.includes(flag), flag);
  }
  assert.deepEqual(args.slice(-5), ['/v/one.mkv', ':start-time=61.3', ':meta-title=Show · S1:E1', '/v/two.mkv', ':meta-title=Show · S1:E2']);
});
