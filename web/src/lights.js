/**
 * Totals for one room's recorded light history. `share` is the fraction of
 * each bucket the room had a light on (null where nothing was recorded),
 * `litMax` the most lights on at once in each bucket.
 *
 * Time on is the sum of share × bucket width over recorded buckets, and the
 * share of time is taken over recorded time only, so a recorder outage reads
 * as missing, not as "off".
 */
export function lightTotals(room, bucketSec) {
  let onSec = 0;
  let recordedSec = 0;
  let mostLit = null;
  for (let i = 0; i < (room?.share.length ?? 0); i += 1) {
    const s = room.share[i];
    if (s == null) continue;
    onSec += s * bucketSec;
    recordedSec += bucketSec;
    const m = room.litMax[i];
    if (m != null && (mostLit == null || m > mostLit)) mostLit = m;
  }
  return {
    onSec,
    recordedSec,
    share: recordedSec ? onSec / recordedSec : null,
    mostLit,
  };
}

/** Index of the first bucket with anything recorded, or -1. */
export const firstRecorded = (values) => values.findIndex((v) => v != null);
