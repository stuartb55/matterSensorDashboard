import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bridgeGaps, energyUsed, spansDays, summarise, trend } from '../web/src/format.js';

test('bridgeGaps fills short runs between readings only', () => {
  // 60s buckets, 120s bridge: runs of up to two nulls are filled.
  assert.deepEqual(bridgeGaps([1, null, 3], 60, 120), [1, 2, 3]);
  assert.deepEqual(bridgeGaps([1, null, null, null, 5], 60, 120), [1, null, null, null, 5]);
  // Leading and trailing nulls have nothing on one side, so they stay gaps.
  assert.deepEqual(bridgeGaps([null, 1, null], 60, 120), [null, 1, null]);
});

test('bridgeGaps never changes its input', () => {
  const raw = [1, null, 3];
  bridgeGaps(raw, 60, 120);
  assert.deepEqual(raw, [1, null, 3]);
});

test('summarise ignores padding nulls', () => {
  assert.deepEqual(summarise([null, 2, 4, null]), { min: 2, max: 4, avg: 3, n: 2 });
  assert.equal(summarise([null, null]), null);
});

test('trend is last minus first real reading', () => {
  assert.equal(trend([null, 20, 21, 22.5, null]), 2.5);
  assert.equal(trend([null]), null);
});

test('energyUsed reads the counter and treats a reset as zero', () => {
  const series = {
    kwhLo: [10, 10.5, null, 0.1],
    kwhHi: [10.5, 11, null, 0.3],
    watts: [100, 100, null, 100],
  };
  const used = energyUsed(series, 3600);
  assert.equal(used.estimated, false);
  // 0.5 + 0.5 from the counter; the drop to 0.3 is a reset and adds nothing.
  assert.ok(Math.abs(used.kwh - 1.0) < 1e-9);
});

test('energyUsed falls back to integrating power', () => {
  const used = energyUsed({ kwhLo: [null, null], kwhHi: [null, null], watts: [1000, 500] }, 3600);
  assert.deepEqual(used, { kwh: 1.5, estimated: true });
});

test('spansDays tells hour ranges from day ranges', () => {
  assert.equal(spansDays('24h'), false);
  assert.equal(spansDays('7d'), true);
  assert.equal(spansDays('1y'), true);
});
