import { test } from 'node:test';
import assert from 'node:assert/strict';
import { doorSummary, openSpells } from '../web/src/doors.js';

const min = 60_000;

test('openSpells pairs openings with closings', () => {
  const events = [
    { ts: 10 * min, closed: false },
    { ts: 15 * min, closed: true },
    { ts: 50 * min, closed: false },
  ];
  const spells = openSpells(true, events, 0, 60 * min);
  assert.deepEqual(spells, [
    { from: 10 * min, to: 15 * min, fromStart: false, ongoing: false },
    { from: 50 * min, to: 60 * min, fromStart: false, ongoing: true },
  ]);
  assert.deepEqual(doorSummary(spells), { opens: 2, openSec: 15 * 60, longestSec: 10 * 60 });
});

test('a door already open when the window starts is clipped, not counted as an opening', () => {
  const spells = openSpells(false, [{ ts: 5 * min, closed: true }], 0, 60 * min);
  assert.deepEqual(spells, [{ from: 0, to: 5 * min, fromStart: true, ongoing: false }]);
  assert.equal(doorSummary(spells).opens, 0);
});

test('an unknown starting state ignores a leading close', () => {
  assert.deepEqual(openSpells(null, [{ ts: 5 * min, closed: true }], 0, 60 * min), []);
});
