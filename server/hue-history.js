// Hue light history: the server records each Hue room's state into InfluxDB
// once a minute, and reads it back bucketed onto the same axis as the sensor
// history.
//
// The bridge keeps no history of its own, so without this recorder there is
// nothing to look back at. It is the only place the dashboard writes to
// InfluxDB, and it writes only to its own database with its own token:
//   HUE_HISTORY_TOKEN  a token that can read and write HUE_HISTORY_DB
//   HUE_HISTORY_DB     the database to record into (default "hue")
// It runs only when Hue itself is configured and the token is set. Light
// control is not part of this: nothing is ever written to the bridge.
//
// One row per room per minute, in table `hue_rooms`:
//   tag   room         the slug from the room's `lights:<slug>` id
//   field lit          lights on in the room
//   field total        lights in the room
//   field unreachable  lights not answering (off at the wall)
//   field brightness   average brightness of the lit ones, when any are lit
// A row is written every minute whether or not anything changed, so a gap in
// the table means the recorder wasn't running, not that the lights were off.

import { hueEnabled } from './hue.js';
import { historyTokenSet, query, writeLines } from './influx.js';
import { RANGES, timeWindow, bucketAxis, parseInfluxTime } from './queries.js';

export const HISTORY_DB = (process.env.HUE_HISTORY_DB || 'hue').trim();
export const TABLE = 'hue_rooms';
export const RECORD_EVERY_SEC = 60;

if (!/^[A-Za-z0-9_-]{1,64}$/.test(HISTORY_DB)) {
  throw new Error('HUE_HISTORY_DB may only contain letters, digits, "-" and "_"');
}

export const lightHistoryEnabled = hueEnabled && historyTokenSet;

const roomKey = (id) => String(id).replace(/^lights:/, '');
// Room slugs are [a-z0-9_] already; escape line protocol's specials anyway.
const escTag = (v) => String(v).replace(/[\\,= ]/g, (c) => `\\${c}`);
const int = (v) => `${Math.round(v)}i`;

/** One line of line protocol per room. Exported for testing. */
export function roomLines(rooms, atSec) {
  return rooms.map((r) => {
    const fields = [`lit=${int(r.onCount)}`, `total=${int(r.total)}`, `unreachable=${int(r.unreachable)}`];
    if (r.brightness != null) fields.push(`brightness=${int(r.brightness)}`);
    return `${TABLE},room=${escTag(roomKey(r.id))} ${fields.join(',')} ${atSec}`;
  });
}

/**
 * Record every minute until the process exits. `getLights` is the server's
 * cached bridge read, so recording adds no extra load on the bridge while
 * tabs are open. Failures are logged once per run of failures, not every
 * minute, and recording carries on.
 */
export function startRecorder(getLights, log) {
  if (!lightHistoryEnabled) return null;
  let failing = false;
  const tick = async () => {
    try {
      const data = await getLights();
      if (!data?.enabled) return;
      await writeLines(HISTORY_DB, roomLines(data.rooms, Math.floor(Date.now() / 1000)));
      if (failing) log.info('hue history recording resumed');
      failing = false;
    } catch (err) {
      if (!failing) log.warn({ err: err.message }, 'hue history recording failed; will keep trying');
      failing = true;
    }
  };
  tick();
  const timer = setInterval(tick, RECORD_EVERY_SEC * 1000);
  timer.unref();
  log.info(`recording Hue light history into "${HISTORY_DB}" every ${RECORD_EVERY_SEC}s`);
  return timer;
}

/**
 * Bucketed light history for every recorded room, on the shared axis:
 * `{ enabled, range, end, bucketSec, bridgeSec, t[], rooms: [{ id, share[], lit[], litMax[] }] }`.
 * `share` is the fraction of the bucket's samples with any light on (0–1),
 * `lit` the average number on and `litMax` the most on at once. Buckets with
 * no samples are null, and samples where every light was unreachable are
 * left out, since the room's state is unknown then.
 */
export async function fetchLightHistory(range, endSec = null) {
  if (!lightHistoryEnabled) return { enabled: false };
  if (!RANGES[range]) throw new Error(`unknown range: ${range}`);
  const { bucket, bucketSec, timeoutMs } = RANGES[range];
  const rows = await query(
    HISTORY_DB,
    `
    SELECT date_bin(INTERVAL '${bucket}', time) AS bucket,
      room,
      avg(CASE WHEN lit > 0 THEN 1.0 ELSE 0.0 END) AS share,
      avg(lit) AS lit,
      max(lit) AS lit_max
    FROM ${TABLE}
    WHERE ${timeWindow(range, endSec).clause}
      AND unreachable < total
    GROUP BY bucket, room
    ORDER BY bucket`,
    { timeoutMs, history: true },
  );
  return { enabled: true, ...shapeLightHistory(rows, range, endSec) };
}

/** Rows to padded series on the shared axis. Exported for testing. */
export function shapeLightHistory(rows, range, endSec = null) {
  const { bucketSec } = RANGES[range];
  const { t, count, indexOf } = bucketAxis(range, endSec);
  const rooms = new Map();
  const roomFor = (key) => {
    if (!rooms.has(key)) {
      rooms.set(key, {
        id: `lights:${key}`,
        share: new Array(count).fill(null),
        lit: new Array(count).fill(null),
        litMax: new Array(count).fill(null),
      });
    }
    return rooms.get(key);
  };
  for (const row of rows) {
    if (!row.room) continue;
    const ms = parseInfluxTime(row.bucket);
    if (ms == null) continue;
    const i = indexOf(Math.floor(ms / 1000));
    if (i === -1) continue;
    const room = roomFor(row.room);
    room.share[i] = row.share ?? null;
    room.lit[i] = row.lit ?? null;
    room.litMax[i] = row.lit_max ?? null;
  }
  return {
    range,
    end: endSec,
    bucketSec,
    // A missed minute or two is the recorder's timing, not an outage.
    bridgeSec: RECORD_EVERY_SEC * 3,
    t,
    rooms: [...rooms.values()],
  };
}
