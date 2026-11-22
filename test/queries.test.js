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

test('long ranges keep the axis to a few hundred points', async () => {
  answer(() => []);
  for (const key of ['90d', '1y']) {
    const h = await fetchHistory(key);
    assert.ok(h.t.length > 100 && h.t.length < 400, `${key}: ${h.t.length} points`);
  }
});

test('CO2 history lands on the Ruuvi Air series only, and degrades on failure', async () => {
  const { bucketSec } = RANGES['1h'];
  const lastBucket = Math.floor(Date.now() / 1000 / bucketSec) * bucketSec;
  answer(({ sql }) => {
    if (/co2_hi/.test(sql)) return [{ bucket: influxTime(lastBucket * 1000), key: 'RuuviAir', co2: 640, co2_hi: 702 }];
    return [];
  });
  const h = await fetchHistory('1h');
  const air = h.series.find((s) => s.id === 'ruuvi_air');
  assert.equal(air.co2.at(-1), 640);
  assert.equal(air.co2Hi.at(-1), 702);
  assert.equal(h.series.find((s) => s.id === 'office').co2, undefined);

  answer(({ sql }) => {
    if (/co2_hi/.test(sql)) throw new Error('no field named co2');
    return [];
  });
  const degraded = await fetchHistory('1h');
  assert.ok(degraded.series.find((s) => s.id === 'ruuvi_air').co2.every((v) => v == null));
});

test('door rows collapse into state changes', async () => {
  const { doorTransitions, fetchDoorEvents } = await import('../server/queries.js');
  const t0 = Date.UTC(2026, 10, 20, 8);
  const at = (min) => influxTime(t0 + min * 60_000);
  const rows = [
    { closed: 1, time: at(0) }, // repeat of the initial state: not an event
    { closed: 0, time: at(5) },
    { closed: 0, time: at(6) },
    { closed: 1, time: at(9) },
  ];
  assert.deepEqual(doorTransitions(true, rows), [
    { ts: t0 + 5 * 60_000, closed: false },
    { ts: t0 + 9 * 60_000, closed: true },
  ]);
  // With no known prior state, the first row is an event.
  assert.equal(doorTransitions(null, rows).length, 3);

  answer(({ sql }) => {
    if (/DISTINCT ON/.test(sql)) return [{ key: 'Garage', closed: 1, time: at(-600) }];
    if (/contact_closed/.test(sql)) return rows.map((r) => ({ ...r, key: 'Garage' }));
    return [];
  });
  const out = await fetchDoorEvents('24h');
  const garage = out.doors.find((d) => d.id === 'garage');
  assert.equal(garage.initial, true);
  assert.equal(garage.events.length, 2);
  assert.equal(out.doors.find((d) => d.id === 'back_door').initial, null);
  assert.equal(out.end - out.start, 86400);
});

test('a feed is down only when every sensor on it is stale', async () => {
  const { feedHealth } = await import('../server/queries.js');
  const now = Date.now();
  answer(({ db, sql }) => {
    // Matter: one climate sensor reporting. Ruuvi: silent.
    if (db === 'matter' && /trank = 1/.test(sql)) {
      return [{ key: 'Kitchen', temp: 19, hum: 50, batt: 80, time: influxTime(now - 60_000) }];
    }
    return [];
  });
  const feeds = feedHealth(await fetchLatest());
  const ruuvi = feeds.find((f) => f.id === 'ruuvi');
  const matter = feeds.find((f) => f.id === 'matter');
  assert.deepEqual([ruuvi.down, ruuvi.lastSeenSec, ruuvi.label], [true, null, 'Ruuvi']);
  assert.equal(matter.down, false);
  assert.ok(matter.lastSeenSec >= 59 && matter.lastSeenSec <= 61);
});
