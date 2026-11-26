import { test } from 'node:test';
import assert from 'node:assert/strict';
import { comparePeriods, dayCost, dayMeans, gasDays, withWeather } from '../web/src/gas.js';

// A zone with clock changes, so 46- and 50-half-hour days are exercised.
process.env.TZ = 'Europe/London';

const HH = 1800;
const halfHours = (fromSec, n, value = 1) => ({
  t: Array.from({ length: n }, (_, i) => fromSec + i * HH),
  kwh: Array.from({ length: n }, () => value),
});

test('gasDays sums local days and marks days the meter has not fully reported', () => {
  const start = Date.parse('2026-11-20T00:00:00Z') / 1000; // GMT, so local midnight
  const { t, kwh } = halfHours(start, 48 + 10, 0.5);
  const days = gasDays(t, kwh);
  assert.equal(days.length, 2);
  assert.deepEqual(
    days.map((d) => [d.key, d.kwh, d.partial]),
    [
      ['2026-11-20', 24, false],
      ['2026-11-21', 5, true],
    ],
  );
});

test('gasDays expects 50 half hours on the day the clocks go back', () => {
  const start = Date.parse('2026-10-24T23:00:00Z') / 1000; // 00:00 BST on 25 Oct
  const full = halfHours(start, 50);
  assert.deepEqual(gasDays(full.t, full.kwh).map((d) => [d.key, d.kwh, d.partial]), [['2026-10-25', 50, false]]);
  const short = halfHours(start, 47);
  assert.equal(gasDays(short.t, short.kwh)[0].partial, true);
  // A skipped half hour or two doesn't make it a part day.
  const gappy = halfHours(start, 48);
  assert.equal(gasDays(gappy.t, gappy.kwh)[0].partial, false);
});

test('dayMeans ignores days with only a few hours', () => {
  const start = Date.parse('2026-11-20T00:00:00Z') / 1000;
  const t = Array.from({ length: 30 }, (_, i) => start + i * 3600);
  const v = t.map((_, i) => (i < 24 ? 20 : 5));
  const m = dayMeans(t, v);
  assert.equal(m.get('2026-11-20'), 20);
  assert.equal(m.has('2026-11-21'), false);
});

test('withWeather divides gas by the indoor-outdoor gap, but not for part or mild days', () => {
  const days = [
    { key: 'a', kwh: 45, partial: false },
    { key: 'b', kwh: 45, partial: true },
    { key: 'c', kwh: 5, partial: false },
    { key: 'd', kwh: 40, partial: false },
  ];
  const inside = new Map([['a', 19], ['b', 19], ['c', 19], ['d', 19]]);
  const outside = new Map([['a', 4], ['b', 4], ['c', 17]]);
  const out = withWeather(days, inside, outside);
  assert.equal(out[0].perDegree, 3);
  assert.equal(out[1].perDegree, null);
  assert.equal(out[2].perDegree, null);
  assert.equal(out[3].perDegree, null);
  assert.equal(out[3].insideC, 19);
});

test('comparePeriods weighs gas per degree by degree-days and needs full weeks', () => {
  const mk = (kwh, diffC) => ({ kwh, diffC, perDegree: kwh / diffC, partial: false });
  const before = Array.from({ length: 7 }, () => mk(40, 10));
  const recent = [...Array.from({ length: 6 }, () => mk(30, 10)), mk(60, 20)];
  const { recent: r, before: b } = comparePeriods([...before, ...recent, { kwh: 3, partial: true }], 7);
  assert.equal(r.kwh, 240);
  assert.equal(r.perDegree, 240 / 80);
  assert.equal(b.perDegree, 4);
  assert.equal(comparePeriods(recent, 7).before, null);
});

test('dayCost adds the standing charge when it is known', () => {
  assert.equal(dayCost(10, { perKwh: 0.07, standingPerDay: 0.3 }), 10 * 0.07 + 0.3);
  assert.equal(dayCost(10, { perKwh: 0.07, standingPerDay: null }), 10 * 0.07);
  assert.equal(dayCost(null, { perKwh: 0.07 }), null);
  assert.equal(dayCost(10, null), null);
});
