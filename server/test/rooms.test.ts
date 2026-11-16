import assert from 'node:assert/strict';
import { test } from 'node:test';

import { restoredState } from '../src/room.ts';
import { Rooms } from '../src/rooms.ts';

test('a lost room comes back under its old code; an existing one is reused', () => {
  const rooms = new Rooms();
  const state = restoredState({ mediaType: 'youtube', mediaId: 'vid', position: 3 }, 1000);
  const room = rooms.restore('abc234', state, [])!;
  assert.equal(room.code, 'ABC234');
  assert.equal(rooms.get('ABC234'), room);
  assert.equal(rooms.restore('ABC234', restoredState(null, 2000), []), room); // first one wins
});

test('codes we would never make are not restored', () => {
  const rooms = new Rooms();
  for (const code of ['', 'ABC', 'ABCDEFG', 'ABC10O']) { // too short, too long, look-alike characters
    assert.equal(rooms.restore(code, restoredState(null, 0), []), undefined, code);
  }
});
