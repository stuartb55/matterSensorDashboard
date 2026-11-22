/**
 * Spells of heating in a tank's temperature series: runs of rising buckets
 * whose total climb reaches `minRiseC`. A single flat or slightly falling
 * bucket inside a climb is tolerated (sensor noise, or the burner cycling),
 * a missing reading ends it. Reads the raw series, never a bridged copy.
 * Returns [{ from, to, startC, endC }] with times in epoch seconds, `to`
 * being the start of the bucket where the peak was reached.
 */
export function heatingCycles(t, temp, minRiseC, { tolerance = 1, epsilon = 0.05 } = {}) {
  const cycles = [];
  let start = null; // index where the climb began
  let peak = null; // index of the highest point so far
  let lapses = 0;

  const close = () => {
    if (start != null && peak != null && temp[peak] - temp[start] >= minRiseC) {
      cycles.push({ from: t[start], to: t[peak], startC: temp[start], endC: temp[peak] });
    }
    start = null;
    peak = null;
    lapses = 0;
  };

  for (let i = 1; i < temp.length; i += 1) {
    const prev = temp[i - 1];
    const cur = temp[i];
    if (prev == null || cur == null) {
      close();
      continue;
    }
    if (cur - prev > epsilon) {
      if (start == null) start = i - 1;
      if (peak == null || cur > temp[peak]) peak = i;
      lapses = 0;
    } else if (start != null) {
      lapses += 1;
      if (lapses > tolerance) close();
    }
  }
  close();
  return cycles;
}
