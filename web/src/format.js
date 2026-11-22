export const fmtTemp = (v) => (v == null ? '—' : v.toFixed(1));
export const fmtHum = (v) => (v == null ? '—' : Math.round(v).toString());
export const fmtCo2 = (v) => (v == null ? '—' : Math.round(v).toString());

export function fmtAge(sec) {
  if (sec == null) return 'no data';
  if (sec < 90) return 'just now';
  const m = Math.round(sec / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/**
 * Range keys are a count and a unit (`6h`, `7d`, `1y`). Anything measured in
 * hours fits inside a day or two, so times alone identify a point on it.
 */
export const spansDays = (range) => !/h$/.test(range);

/** Axis/tooltip time formatting, chosen by how wide the window is. */
export function fmtTime(unixSec, range) {
  const d = new Date(unixSec * 1000);
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (!spansDays(range)) return time;
  const day = d.toLocaleDateString([], { day: 'numeric', month: 'short' });
  return `${day} ${time}`;
}

export function fmtTick(unixSec, range) {
  const d = new Date(unixSec * 1000);
  if (spansDays(range)) {
    return d.toLocaleDateString([], { day: 'numeric', month: 'short' });
  }
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/**
 * Y-axis tick labels at just enough precision for the tick spacing. Rounding
 * every tick to a whole number collapses a 0.5-degree ladder into duplicate
 * labels ("26, 26, 25, 25").
 */
export function axisValues(splits) {
  const step =
    splits.length > 1 ? Math.abs(splits[1] - splits[0]) : 1;
  const dp = step >= 1 ? 0 : step >= 0.1 ? 1 : 2;
  return splits.map((v) => (v == null ? '' : v.toFixed(dp)));
}

/** Battery voltage (Ruuvi) and percentage (Matter) need different thresholds. */
export function batteryLow(value, kind) {
  if (value == null) return false;
  return kind === 'volts' ? value < 2.5 : value < 20;
}

export const fmtBattery = (value, kind) =>
  value == null ? null : kind === 'volts' ? `${value.toFixed(2)}V` : `${Math.round(value)}%`;

/** Min / max / mean over a series, ignoring the nulls that pad the axis. */
export function summarise(values) {
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  let n = 0;
  for (const v of values) {
    if (v == null) continue;
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
    n += 1;
  }
  return n ? { min, max, avg: sum / n, n } : null;
}

/**
 * Connect short breaks in a series so a sensor that reports more slowly than
 * the bucket width draws as a line rather than a dashed trail.
 *
 * Only runs no longer than `bridgeSec` are filled, and only between two real
 * readings — a genuine outage stays a visible gap. The filled values are for
 * drawing only; the table view and the statistics always use the raw series,
 * so no interpolated number is ever presented as a reading.
 */
export function bridgeGaps(values, bucketSec, bridgeSec) {
  if (!values || !bridgeSec || !bucketSec) return values;
  const maxRun = Math.max(1, Math.floor(bridgeSec / bucketSec));
  const out = values.slice();

  let i = 0;
  while (i < values.length) {
    if (values[i] != null) {
      i += 1;
      continue;
    }
    let j = i;
    while (j < values.length && values[j] == null) j += 1;

    const before = i > 0 ? values[i - 1] : null;
    const after = j < values.length ? values[j] : null;
    const run = j - i;
    if (before != null && after != null && run <= maxRun) {
      const stepValue = (after - before) / (run + 1);
      for (let k = 0; k < run; k += 1) out[i + k] = before + stepValue * (k + 1);
    }
    i = j;
  }
  return out;
}

/**
 * Change between the earliest and latest readings in the window, used for the
 * trend cue on each card.
 */
export function trend(values) {
  let first = null;
  let last = null;
  for (const v of values) {
    if (v == null) continue;
    if (first == null) first = v;
    last = v;
  }
  if (first == null || last == null) return null;
  return last - first;
}

/** Watts below a kilowatt, kilowatts above, so a kettle reads "2.85 kW". */
export function fmtPower(w) {
  if (w == null) return { value: '—', unit: 'W' };
  if (Math.abs(w) >= 1000) return { value: (w / 1000).toFixed(2), unit: 'kW' };
  return { value: Math.abs(w) < 10 ? w.toFixed(1) : Math.round(w).toString(), unit: 'W' };
}

export const fmtEnergy = (kwh) =>
  kwh == null ? '—' : kwh < 10 ? kwh.toFixed(2) : kwh.toFixed(1);
export const fmtVolts = (v) => (v == null ? '—' : Math.round(v).toString());
export const fmtAmps = (a) => (a == null ? '—' : a.toFixed(2));

/** "235 V · 0.62 A", leaving out whichever the meter doesn't report. */
export const fmtElectrical = (volts, amps) =>
  [volts != null && `${fmtVolts(volts)} V`, amps != null && `${fmtAmps(amps)} A`]
    .filter(Boolean)
    .join(' · ');

/**
 * Energy used across the window, in kWh.
 *
 * Read from the meter's cumulative counter where there is one: the sum of its
 * rises between buckets, starting from the lowest value in the first bucket.
 * A drop means the counter was reset, so it counts as zero rather than as
 * negative use. Without a counter, average power is integrated over each
 * bucket instead, which undercounts across gaps, so it is flagged `estimated`.
 */
export function energyUsed(series, bucketSec) {
  if (!series) return null;
  const { kwhLo, kwhHi, watts } = series;

  let prev = null;
  let total = 0;
  let seen = false;
  for (let i = 0; i < kwhHi.length; i += 1) {
    const hi = kwhHi[i];
    if (hi == null) continue;
    if (prev == null) prev = kwhLo[i] ?? hi;
    if (hi > prev) total += hi - prev;
    prev = hi;
    seen = true;
  }
  if (seen) return { kwh: total, estimated: false };

  if (!bucketSec) return null;
  let wh = 0;
  let n = 0;
  for (const w of watts) {
    if (w == null) continue;
    wh += (w * bucketSec) / 3600;
    n += 1;
  }
  return n ? { kwh: wh / 1000, estimated: true } : null;
}

/**
 * Seconds of the window spent at or above `level`, counting whole buckets of
 * the raw series. Buckets with no reading count as unknown, not as below.
 */
export function timeAtOrAbove(values, level, bucketSec) {
  if (!values || !bucketSec) return null;
  let n = 0;
  let seen = false;
  for (const v of values) {
    if (v == null) continue;
    seen = true;
    if (v >= level) n += 1;
  }
  // The axis has one more bucket than the span holds (both ends are
  // included), so a level held throughout must not read as longer than it.
  return seen ? Math.min(n, values.length - 1) * bucketSec : null;
}

/** "3h 20m", "45m", "0m". */
export function fmtDuration(sec) {
  if (sec == null) return '—';
  const m = Math.round(sec / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d}d ${h % 24}h` : `${d}d`;
}

/**
 * Dew point in °C from temperature (°C) and relative humidity (%), by the
 * Magnus formula (Sonntag 1990 constants), good to about 0.1 °C indoors.
 * The temperature at which a surface starts collecting condensation.
 */
export function dewPoint(tempC, rh) {
  if (tempC == null || rh == null || rh <= 0) return null;
  const a = 17.62;
  const b = 243.12;
  const g = Math.log(Math.min(rh, 100) / 100) + (a * tempC) / (b + tempC);
  return (b * g) / (a - g);
}

/** Water vapour actually in the air, in grams per cubic metre. */
export function absoluteHumidity(tempC, rh) {
  if (tempC == null || rh == null) return null;
  const saturation = 6.112 * Math.exp((17.67 * tempC) / (tempC + 243.5)); // hPa
  return (saturation * rh * 2.1674) / (273.15 + tempC);
}

/**
 * Relative humidity at which mould can take hold if it lasts. Most building
 * guidance puts the line at 70% sustained over hours, not a passing shower.
 */
export const DAMP_RH = 70;

/** Element-wise dew point over two aligned series, null where either is. */
export const dewPointSeries = (temp, hum) => temp.map((t, i) => dewPoint(t, hum[i]));
