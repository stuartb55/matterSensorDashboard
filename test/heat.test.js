import { test } from 'node:test';
import assert from 'node:assert/strict';
import { binLabels, binOf, insidePolygon, rampStep, roomValues } from '../web/src/heat.js';

const square = [[0, 0], [10, 0], [10, 10], [0, 10]];

test('insidePolygon', () => {
  assert.equal(insidePolygon([5, 5], square), true);
  assert.equal(insidePolygon([15, 5], square), false);
  // An L shape: the notch is outside.
  const ell = [[0, 0], [10, 0], [10, 5], [5, 5], [5, 10], [0, 10]];
  assert.equal(insidePolygon([8, 8], ell), false);
  assert.equal(insidePolygon([2, 8], ell), true);
});

test('bins and their labels', () => {
  const edges = [16, 18, 20];
  assert.deepEqual([15.9, 16, 19, 20, 30].map((v) => binOf(v, edges)), [0, 1, 2, 3, 3]);
  assert.deepEqual(binLabels(edges), ['< 16', '16–18', '18–20', '≥ 20']);
  assert.equal(rampStep(0, 5), 0);
  assert.equal(rampStep(4, 5), 5);
});

test('roomValues averages live room sensors inside each room', () => {
  const readings = new Map([
    ['a', { kind: 'room', tempC: 20 }],
    ['b', { kind: 'room', tempC: 22 }],
    ['c', { kind: 'room', tempC: 30, stale: true }],
    ['d', { kind: 'equipment', tempC: 47 }],
  ]);
  const markers = { a: { x: 2, y: 2 }, b: { x: 8, y: 8 }, c: { x: 5, y: 5 }, d: { x: 5, y: 6 } };
  const other = [[20, 0], [30, 0], [30, 10], [20, 10]];
  assert.deepEqual(roomValues([square, other], markers, readings, 'tempC'), [21, null]);
});
