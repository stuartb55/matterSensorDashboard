import { test } from 'node:test';
import assert from 'node:assert/strict';
import { baseLoad, bucketEnergy, dailyEnergy, dayIndices, localDayKey } from '../web/src/daily.js';

// Pin the zone so day boundaries are predictable.
process.env.TZ = 'UTC';

test('bucketEnergy counts the rise between buckets and treats a drop as a reset', () => {
  const { kwh, estimated } = bucketEnergy(
    { kwhLo: [10, 10.6, 0.1, null], kwhHi: [10.5, 11, 0.3, null], watts: [0, 0, 0, 500] },
    3600,
  );
  assert.deepEqual(kwh.map((v) => Math.round(v * 100) / 100), [0.5, 0.5, 0, 0.5]);
  assert.deepEqual(estimated, [false, false, false, true]);
});

test('dailyEnergy groups hourly buckets into local days', () => {
  const day = 86400;
  const start = Date.UTC(2026, 10, 1) / 1000;
  const t = Array.from({ length: 48 }, (_, i) => start + i * 3600);
  const hi = t.map((_, i) => 100 + (i + 1) * 0.1);
  const lo = t.map((_, i) => 100 + i * 0.1);
  const days = dailyEnergy(t, { kwhLo: lo, kwhHi: hi, watts: t.map(() => 100) }, 3600);
  assert.equal(days.length, 2);
  assert.equal(days[0].key, '2026-11-01');
  assert.ok(Math.abs(days[0].kwh - 2.4) < 1e-9);
  assert.ok(Math.abs(days[1].kwh - 2.4) < 1e-9);
  assert.equal(days[0].partial, true);
  assert.equal(days[1].partial, false);
  assert.equal(localDayKey(start + day), '2026-11-02');
  assert.equal(dayIndices(t)[1].idx[0], 24);
});

test('baseLoad needs a day of data and ignores the odd low reading', () => {
  assert.equal(baseLoad([10, 20]), null);
  const watts = [5, ...Array.from({ length: 99 }, (_, i) => 40 + i)];
  assert.equal(baseLoad(watts), 43);
});

test('dailyHighLow finds each day\'s extremes and when they fell', async () => {
  const { dailyHighLow } = await import('../web/src/daily.js');
  const start = Date.UTC(2026, 10, 1) / 1000;
  const t = [start, start + 3600, start + 86400];
  const days = dailyHighLow(t, [18, 17, 16], [20, 22, null]);
  assert.deepEqual(days[0].min, { value: 17, sec: start + 3600 });
  assert.deepEqual(days[0].max, { value: 22, sec: start + 3600 });
  assert.deepEqual(days[1].min, { value: 16, sec: start + 86400 });
  assert.equal(days[1].max, null);
});
