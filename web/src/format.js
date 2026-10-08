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

/** Axis/tooltip time formatting, chosen by how wide the window is. */
export function fmtTime(unixSec, range) {
  const d = new Date(unixSec * 1000);
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (range === '1h' || range === '6h') return time;
  const day = d.toLocaleDateString([], { day: 'numeric', month: 'short' });
  return range === '24h' ? time : `${day} ${time}`;
}

export function fmtTick(unixSec, range) {
  const d = new Date(unixSec * 1000);
  if (range === '7d' || range === '30d') {
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
