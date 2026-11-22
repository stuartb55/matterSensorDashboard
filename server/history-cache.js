import { RANGES, CHUNK_SEC } from './queries.js';

// Ranges over a week are read from InfluxDB a week at a time (timeChunks), so
// a 1Y chart costs tens of seconds of database work. Their buckets are hours
// to a day wide, so a ten-minute-old answer looks the same, and the browser's
// two-minute history poll would otherwise keep InfluxDB busy with them.
export const LONG_HISTORY_TTL_MS = 10 * 60_000;
const MAX_ENTRIES = 32;

/**
 * Wrap a fetchHistory-shaped function so ranges over a week are cached per
 * range, sensor list and end, and concurrent requests for the same answer
 * share one read. Shorter ranges pass straight through. A failed read is
 * never cached.
 */
export function cacheLongHistory(fetcher, { ttlMs = LONG_HISTORY_TTL_MS, now = Date.now } = {}) {
  const entries = new Map();
  return function cachedHistory(range, ids = null, end = null) {
    if (!RANGES[range] || RANGES[range].spanSec <= CHUNK_SEC) return fetcher(range, ids, end);
    const key = JSON.stringify([range, ids?.length ? [...ids].sort() : null, end]);
    let entry = entries.get(key);
    if (entry && !entry.pending && now() - entry.at >= ttlMs) {
      entries.delete(key);
      entry = undefined;
    }
    if (!entry) {
      entry = { at: 0, data: null, pending: null };
      entry.pending = fetcher(range, ids, end).then(
        (data) => {
          Object.assign(entry, { at: now(), data, pending: null });
          return data;
        },
        (err) => {
          if (entries.get(key) === entry) entries.delete(key);
          throw err;
        },
      );
      entries.set(key, entry);
      while (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value);
    }
    return entry.pending ?? Promise.resolve(entry.data);
  };
}
