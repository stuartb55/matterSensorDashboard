import { test } from 'node:test';
import assert from 'node:assert/strict';
import { heatingCycles } from '../web/src/heating.js';

test('a climb past the threshold is a heating cycle; small wobbles are not', () => {
  const t = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
  const temp = [40, 40.1, 42, 43.9, 43.9, 46, 45.8, 45.5, 45.6, 45.4];
  assert.deepEqual(heatingCycles(t, temp, 2), [{ from: 0, to: 5, startC: 40, endC: 46 }]);
  assert.deepEqual(heatingCycles(t, [40, 40.5, 40, 40.5, 40], 2), []);
});

test('a gap in the data ends a climb', () => {
  const t = [0, 1, 2, 3, 4];
  assert.deepEqual(heatingCycles(t, [40, 41.5, null, 43, 44], 2), []);
});
