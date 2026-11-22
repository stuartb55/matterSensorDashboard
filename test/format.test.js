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

test('dew point and absolute humidity match reference values', async () => {
  const { absoluteHumidity, dewPoint, dewPointSeries } = await import('../web/src/format.js');
  // 20 °C at 50% RH: dew point 9.3 °C, 8.6 g/m3.
  assert.ok(Math.abs(dewPoint(20, 50) - 9.26) < 0.05);
  assert.ok(Math.abs(absoluteHumidity(20, 50) - 8.63) < 0.05);
  // Saturated air condenses at its own temperature.
  assert.ok(Math.abs(dewPoint(15, 100) - 15) < 1e-9);
  assert.deepEqual(dewPointSeries([20, null], [50, 40]).map((v) => v && Math.round(v)), [9, null]);
});

test('alignHourly marks each hour on short buckets and averages on long ones', async () => {
  const { alignHourly, meanSeries } = await import('../web/src/format.js');
  const h = 3600;
  const hourT = [0, h, 2 * h, 3 * h];
  const temps = [1, 2, null, 4];
  assert.deepEqual(alignHourly([0, 60, h, h + 60, 2 * h], hourT, temps, 60), [1, null, 2, null, null]);
  assert.deepEqual(alignHourly([0, 2 * h], hourT, temps, 2 * h), [1.5, 4]);
  assert.deepEqual(meanSeries([[1, null, 3], [3, null, null]]), [2, null, 3]);
});
