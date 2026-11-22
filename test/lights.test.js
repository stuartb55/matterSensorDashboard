import { test } from 'node:test';
import assert from 'node:assert/strict';
import { firstRecorded, lightTotals } from '../web/src/lights.js';

test('lightTotals adds time on over recorded buckets only', () => {
  const room = { share: [null, 1, 0.5, 0, null], litMax: [null, 3, 1, 0, null] };
  const totals = lightTotals(room, 600);
  assert.equal(totals.onSec, 900);
  assert.equal(totals.recordedSec, 1800);
  assert.equal(totals.share, 0.5);
  assert.equal(totals.mostLit, 3);
});

test('lightTotals with nothing recorded has no share', () => {
  const totals = lightTotals({ share: [null, null], litMax: [null, null] }, 60);
  assert.deepEqual(totals, { onSec: 0, recordedSec: 0, share: null, mostLit: null });
  assert.equal(lightTotals(undefined, 60).share, null);
});

test('firstRecorded finds where recording started', () => {
  assert.equal(firstRecorded([null, null, 0, 1]), 2);
  assert.equal(firstRecorded([null]), -1);
});
