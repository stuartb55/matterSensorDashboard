// Calendar-day views over /api/daily: 31 days of hourly buckets regrouped into
// the viewer's local days. Grouping happens here, not in SQL, because
// date_bin's days are UTC and a local day may not be 24 hours long.

const pad = (n) => String(n).padStart(2, '0');

/** Local calendar day of an epoch-second time, as YYYY-MM-DD. */
export function localDayKey(sec) {
  const d = new Date(sec * 1000);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Bucket indices per local day, oldest day first. */
export function dayIndices(t) {
  const days = [];
  let current = null;
  t.forEach((sec, i) => {
    const key = localDayKey(sec);
    if (!current || current.key !== key) {
      current = { key, startSec: sec, idx: [] };
      days.push(current);
    }
    current.idx.push(i);
  });
  return days;
}

/**
 * Energy per bucket in kWh. From the meter's lifetime counter where it has
 * one: each bucket is the rise since the previous bucket's top (a drop is a
 * reset and counts as zero), so nothing between buckets is lost. Where the
 * counter is missing, average power times bucket length, flagged as estimated.
 */
export function bucketEnergy(series, bucketSec) {
  const { kwhLo = [], kwhHi = [], watts = [] } = series;
  const out = [];
  const estimated = [];
  let prevHi = null;
  for (let i = 0; i < watts.length; i += 1) {
    const hi = kwhHi[i];
    if (hi != null) {
      const from = prevHi ?? kwhLo[i] ?? hi;
      out.push(hi >= from ? hi - from : 0);
      estimated.push(false);
      prevHi = hi;
    } else if (watts[i] != null) {
      out.push((watts[i] * bucketSec) / 3600 / 1000);
      estimated.push(true);
    } else {
      out.push(null);
      estimated.push(false);
    }
  }
  return { kwh: out, estimated };
}

/**
 * kWh per local day. `partial` marks a day the data doesn't fully cover (the
 * first day of the window, and today); `estimated` a day where any part came
 * from integrated power rather than the counter.
 */
export function dailyEnergy(t, series, bucketSec) {
  const { kwh, estimated } = bucketEnergy(series, bucketSec);
  const today = localDayKey(Date.now() / 1000);
  const days = dayIndices(t);
  return days.map((day, n) => {
    let total = 0;
    let seen = false;
    let est = false;
    for (const i of day.idx) {
      if (kwh[i] == null) continue;
      total += kwh[i];
      seen = true;
      est ||= estimated[i];
    }
    return {
      key: day.key,
      startSec: day.startSec,
      kwh: seen ? total : null,
      estimated: est,
      partial: n === 0 || day.key === today,
    };
  });
}

/**
 * Always-on draw: a low percentile of hourly average power, so the quietest
 * hours of the night set it rather than one odd reading.
 */
export function baseLoad(watts, percentile = 0.05) {
  const vals = watts.filter((v) => v != null).sort((a, b) => a - b);
  if (vals.length < 24) return null;
  return vals[Math.floor(percentile * (vals.length - 1))];
}

/** Daily low and high of a climate series, per local day, with their times. */
export function dailyHighLow(t, lo, hi) {
  return dayIndices(t).map((day) => {
    let min = null;
    let max = null;
    for (const i of day.idx) {
      if (lo[i] != null && (min == null || lo[i] < min.value)) min = { value: lo[i], sec: t[i] };
      if (hi[i] != null && (max == null || hi[i] > max.value)) max = { value: hi[i], sec: t[i] };
    }
    return { key: day.key, startSec: day.startSec, min, max };
  });
}

/**
 * Rough time until a battery reaches its low mark, from the trend of its
 * daily averages (averaging first smooths out the daily temperature swing
 * that coin cells show). Needs a week of days to say anything.
 * Returns { perDay, daysLeft, steady } or null when there is too little data.
 * `low` is the level that counts as needing a change.
 */
export function batteryForecast(t, batt, low) {
  const days = dayIndices(t)
    .map((day) => {
      const vals = day.idx.map((i) => batt[i]).filter((v) => v != null);
      return vals.length ? { x: day.startSec / 86400, y: vals.reduce((a, b) => a + b, 0) / vals.length } : null;
    })
    .filter(Boolean);
  if (days.length < 7) return null;

  const n = days.length;
  const mx = days.reduce((a, d) => a + d.x, 0) / n;
  const my = days.reduce((a, d) => a + d.y, 0) / n;
  let sxy = 0;
  let sxx = 0;
  for (const d of days) {
    sxy += (d.x - mx) * (d.y - my);
    sxx += (d.x - mx) ** 2;
  }
  const perDay = sxx ? sxy / sxx : 0;
  const latest = days.at(-1).y;
  // Falling by less than one part in ten thousand of its level a day is
  // indistinguishable from noise over a month.
  const steady = perDay >= -Math.abs(latest) * 1e-4;
  if (steady) return { perDay, daysLeft: null, steady: true };
  return { perDay, daysLeft: Math.max(0, (latest - low) / -perDay), steady: false };
}
