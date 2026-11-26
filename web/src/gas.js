// Calendar-day views of the heating gas from /api/gas, regrouped into the
// viewer's local days like daily.js does for the sensors, plus a
// weather-adjusted figure: gas per degree of indoor-outdoor difference.

import { localDayKey } from './daily.js';

const HALF_HOUR = 1800;

/** Epoch seconds of local midnight starting the day after `sec`'s day. */
function nextMidnight(sec) {
  const d = new Date(sec * 1000);
  return Math.floor(new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime() / 1000);
}

function midnight(sec) {
  const d = new Date(sec * 1000);
  return Math.floor(new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() / 1000);
}

// Meters occasionally skip a half hour (usually around midnight). A day short
// of this many still counts as whole rather than hiding its figures.
const MISSING_OK = 2;

/**
 * kWh per local day, oldest first. A day is `partial` when the meter hasn't
 * reported most of it yet: a day has 46, 48 or 50 half hours around the clock
 * changes, and up to MISSING_OK may be absent. A day with no readings at all
 * is not listed.
 */
export function gasDays(t, kwh) {
  const days = [];
  let cur = null;
  t.forEach((sec, i) => {
    const key = localDayKey(sec);
    if (!cur || cur.key !== key) {
      const start = midnight(sec);
      cur = { key, startSec: start, kwh: 0, count: 0, expected: (nextMidnight(sec) - start) / HALF_HOUR };
      days.push(cur);
    }
    if (kwh[i] != null) {
      cur.kwh += kwh[i];
      cur.count += 1;
    }
  });
  return days.map(({ key, startSec, kwh: total, count, expected }) => ({
    key,
    startSec,
    kwh: count ? total : null,
    partial: count < expected - MISSING_OK,
  }));
}

/** Mean of a series per local day: Map of YYYY-MM-DD to the mean. */
export function dayMeans(t, values) {
  const acc = new Map();
  t.forEach((sec, i) => {
    const v = values[i];
    if (v == null) return;
    const key = localDayKey(sec);
    const a = acc.get(key) ?? { sum: 0, n: 0 };
    a.sum += v;
    a.n += 1;
    acc.set(key, a);
  });
  const out = new Map();
  // A handful of hours is not a day's average.
  for (const [key, { sum, n }] of acc) if (n >= 12) out.set(key, sum / n);
  return out;
}

// Below this the house barely needs heat and the ratio swings wildly.
const MIN_DIFF_C = 3;

/**
 * Each day joined to the house and outdoor means and gas per degree, the
 * figure that stays put when only the weather changes. `perDegree` is null for
 * part days and days missing either temperature.
 */
export function withWeather(days, inside, outside) {
  return days.map((d) => {
    const tin = inside.get(d.key) ?? null;
    const tout = outside.get(d.key) ?? null;
    const diff = tin != null && tout != null ? tin - tout : null;
    const perDegree =
      !d.partial && d.kwh != null && diff != null && diff >= MIN_DIFF_C ? d.kwh / diff : null;
    return { ...d, insideC: tin, outsideC: tout, diffC: diff, perDegree };
  });
}

/**
 * The last `n` complete days against the `n` complete days before them:
 * totals, and gas per degree as total gas over total degree-days, so a mild
 * day with a high ratio doesn't outweigh a cold one.
 */
export function comparePeriods(days, n = 7) {
  const full = days.filter((d) => !d.partial && d.kwh != null);
  const sum = (list) => {
    if (list.length < n) return null;
    const kwh = list.reduce((a, d) => a + d.kwh, 0);
    const rated = list.filter((d) => d.perDegree != null);
    const degreeDays = rated.reduce((a, d) => a + d.diffC, 0);
    const ratedKwh = rated.reduce((a, d) => a + d.kwh, 0);
    return {
      kwh,
      days: list.length,
      perDegree: rated.length >= Math.ceil(n / 2) && degreeDays > 0 ? ratedKwh / degreeDays : null,
    };
  };
  const recent = sum(full.slice(-n));
  const before = sum(full.slice(-2 * n, -n));
  return { recent, before };
}

/** Cost of a day's gas, standing charge included when it is known. */
export function dayCost(kwh, tariff) {
  if (kwh == null || !tariff) return null;
  return kwh * tariff.perKwh + (tariff.standingPerDay ?? 0);
}
