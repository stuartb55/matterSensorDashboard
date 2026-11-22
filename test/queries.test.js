import { test } from 'node:test';
import assert from 'node:assert/strict';
import { answer, influxTime, sent } from './influx-mock.js';

const { parseInfluxTime, fetchHistory, fetchLatest, publicRanges, RANGES } = await import(
  '../server/queries.js'
);

test('parseInfluxTime reads naive timestamps as UTC', () => {
  assert.equal(parseInfluxTime('2026-08-14T09:32:29.417'), Date.UTC(2026, 7, 14, 9, 32, 29, 417));
  assert.equal(parseInfluxTime('2026-08-14T09:32:29Z'), Date.UTC(2026, 7, 14, 9, 32, 29));
  assert.equal(parseInfluxTime(null), null);
  assert.equal(parseInfluxTime('not a time'), null);
});

test('publicRanges lists every preset with a label', () => {
  const ranges = publicRanges();
  assert.deepEqual(ranges.map((r) => r.key), Object.keys(RANGES));
  for (const r of ranges) assert.ok(r.label && r.spanSec > 0);
});

test('fetchHistory pads every series to a shared epoch-anchored axis with nulls', async () => {
  const { bucketSec } = RANGES['1h'];
  const lastBucket = Math.floor(Date.now() / 1000 / bucketSec) * bucketSec;
  answer(({ db, sql }) => {
    if (db === 'ruuvi' && /date_bin/.test(sql) && /temp_lo/.test(sql)) {
      return [{ bucket: influxTime(lastBucket * 1000), key: 'Office', temp: 21.5, temp_lo: 21.4, temp_hi: 21.6, hum: 40 }];
    }
    return [];
  });

  const h = await fetchHistory('1h');
  assert.equal(h.bucketSec, bucketSec);
  for (let i = 1; i < h.t.length; i += 1) assert.equal(h.t[i] - h.t[i - 1], bucketSec);
  assert.equal(h.t.at(-1), lastBucket);

  const office = h.series.find((s) => s.id === 'office');
  assert.equal(office.temp.length, h.t.length);
  assert.equal(office.temp.at(-1), 21.5);
  assert.equal(office.temp[0], null);
  assert.ok(!h.series.some((s) => s.kind === 'door'), 'doors stay out of the history contract');
  assert.ok(sent.every(({ sql }) => !/;/.test(sql)));
});

test('fetchHistory rejects unknown ranges', async () => {
  await assert.rejects(fetchHistory('2w'));
});

test('fetchLatest returns every sensor, stale when silent', async () => {
  answer(() => []);
  const latest = await fetchLatest();
  const ids = latest.map((r) => r.id);
  assert.ok(ids.includes('living_room') && ids.includes('garage'));
  const office = latest.find((r) => r.id === 'office');
  assert.equal(office.tempC, null);
  assert.equal(office.stale, true);
  // A door's state is event-driven and never goes stale.
  assert.equal(latest.find((r) => r.id === 'garage').stale, false);
});

test('fetchLatest merges a Matter node whose fields arrive on separate rows', async () => {
  const now = Date.now();
  answer(({ db, sql }) => {
    if (db === 'matter' && /trank = 1/.test(sql)) {
      return [{ key: 'Kitchen', temp: 19.2, hum: 55, batt: 80, time: influxTime(now - 60_000) }];
    }
    return [];
  });
  const kitchen = (await fetchLatest()).find((r) => r.id === 'kitchen');
  assert.equal(kitchen.tempC, 19.2);
  assert.equal(kitchen.humidity, 55);
  assert.equal(kitchen.stale, false);
});

test('a failing CO2 query degrades to no CO2 rather than failing everything', async () => {
  answer(({ sql }) => {
    if (/co2 IS NOT NULL/.test(sql)) throw new Error('no field named co2');
    return [];
  });
  const air = (await fetchLatest()).find((r) => r.id === 'ruuvi_air');
  assert.equal(air.co2, null);
});
