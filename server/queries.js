import { query, probe } from './influx.js';
import { SOURCES, lookup, sensorsForSource, SENSORS } from './sensors.js';

// Range presets. User input is matched against these keys only — no interval
// string ever reaches SQL from the client.
export const RANGES = {
  '1h': { interval: '1 hour', bucket: '1 minute', bucketSec: 60, spanSec: 3600 },
  '6h': { interval: '6 hours', bucket: '2 minutes', bucketSec: 120, spanSec: 6 * 3600 },
  '24h': { interval: '24 hours', bucket: '5 minutes', bucketSec: 300, spanSec: 24 * 3600 },
  '7d': { interval: '7 days', bucket: '30 minutes', bucketSec: 1800, spanSec: 7 * 86400 },
  '30d': { interval: '30 days', bucket: '3 hours', bucketSec: 10800, spanSec: 30 * 86400 },
};

export const DEFAULT_RANGE = '24h';

/**
 * Upstream check behind /health. Any registered database exercises the same
 * credentials and endpoint the real queries use, so the first one is enough.
 */
export async function probeUpstream() {
  const { db } = Object.values(SOURCES)[0];
  await probe(db);
  return { db };
}

// How far back to look for a "current" reading. Wide enough that an offline
// sensor still appears in the UI as stale rather than silently vanishing.
const LATEST_LOOKBACK = '24 hours';

/**
 * InfluxDB 3 returns naive timestamps ("2026-08-14T09:32:29.417994087") that
 * are UTC but carry no zone suffix. Date.parse would read those as local time,
 * so the suffix has to be added before parsing.
 */
export function parseInfluxTime(value) {
  if (value == null) return null;
  const hasZone = /[Zz]$|[+-]\d{2}:?\d{2}$/.test(value);
  const ms = Date.parse(hasZone ? value : `${value}Z`);
  return Number.isNaN(ms) ? null : ms;
}

/** Registry values only, but quoted defensively all the same. */
function sqlList(values) {
  return values.map((v) => `'${String(v).replace(/'/g, "''")}'`).join(', ');
}

// ---------------------------------------------------------------------------
// Latest readings
// ---------------------------------------------------------------------------

async function latestRuuvi(sensors) {
  if (!sensors.length) return [];
  const src = SOURCES.ruuvi;
  const sql = `
    SELECT DISTINCT ON (${src.tag})
      ${src.tag} AS key, ${src.temp} AS temp, ${src.hum} AS hum,
      ${src.batt} AS batt, rssi, time
    FROM ${src.table}
    WHERE time > now() - INTERVAL '${LATEST_LOOKBACK}'
      AND ${src.tag} IN (${sqlList(sensors.map((s) => s.key))})
    ORDER BY ${src.tag}, time DESC`;
  return query(src.db, sql);
}

/**
 * CO2 is read separately from the main Ruuvi query for two reasons: the Ruuvi
 * Air broadcasts more than one data format, so its newest row may not carry
 * CO2 at all, and a failure here (column missing, say) must not take every
 * Ruuvi card offline with it. It degrades to no CO2 value instead.
 */
async function latestCo2(sensors) {
  if (!sensors.length) return [];
  const src = SOURCES.ruuvi;
  const sql = `
    SELECT DISTINCT ON (${src.tag})
      ${src.tag} AS key, ${src.co2} AS co2
    FROM ${src.table}
    WHERE time > now() - INTERVAL '${LATEST_LOOKBACK}'
      AND ${src.tag} IN (${sqlList(sensors.map((s) => s.key))})
      AND ${src.co2} IS NOT NULL
    ORDER BY ${src.tag}, time DESC`;
  try {
    return await query(src.db, sql);
  } catch (err) {
    console.warn(`CO2 query failed: ${err.message}`);
    return [];
  }
}

/**
 * The Matter writer emits temperature and humidity as separate rows a couple of
 * milliseconds apart, so "the most recent row per node" has one field populated
 * and the other null. Rank each field independently instead, pushing nulls to
 * the back, then take rank 1 of each.
 */
async function latestMatter(sensors) {
  if (!sensors.length) return [];
  const src = SOURCES.matter;
  const rank = (col, alias) =>
    `row_number() OVER (PARTITION BY ${src.tag} ` +
    `ORDER BY CASE WHEN ${col} IS NULL THEN 1 ELSE 0 END, time DESC) AS ${alias}`;

  const sql = `
    SELECT ${src.tag} AS key,
      max(${src.temp}) FILTER (WHERE trank = 1) AS temp,
      max(${src.hum})  FILTER (WHERE hrank = 1) AS hum,
      max(${src.batt}) FILTER (WHERE brank = 1) AS batt,
      max(time) FILTER (WHERE trank = 1) AS time
    FROM (
      SELECT ${src.tag}, ${src.temp}, ${src.hum}, ${src.batt}, time,
        ${rank(src.temp, 'trank')},
        ${rank(src.hum, 'hrank')},
        ${rank(src.batt, 'brank')}
      FROM ${src.table}
      WHERE time > now() - INTERVAL '${LATEST_LOOKBACK}'
        AND ${src.tag} IN (${sqlList(sensors.map((s) => s.key))})
    )
    GROUP BY ${src.tag}`;
  return query(src.db, sql);
}

/**
 * A contact sensor writes only when its state changes, so its current state
 * may be much older than the normal latest-reading lookback. Fetch that state
 * independently; an unchanged door is not considered stale.
 */
async function latestDoorStates(sensors) {
  if (!sensors.length) return [];
  const src = SOURCES.matter;
  const sql = `
    SELECT DISTINCT ON (${src.tag})
      ${src.tag} AS key, ${src.contact} AS closed, time AS state_time
    FROM ${src.table}
    WHERE ${src.tag} IN (${sqlList(sensors.map((s) => s.key))})
      AND ${src.contact} IS NOT NULL
    ORDER BY ${src.tag}, time DESC`;
  return query(src.db, sql);
}

/**
 * Current reading for every registered sensor, normalised across both sources.
 * Sensors with no recent data are still returned, with null values, so the UI
 * can show them as offline.
 */
export async function fetchLatest() {
  const doors = SENSORS.filter((sensor) => sensor.kind === 'door');
  const [ruuviRows, matterRows, doorStateRows, co2Rows] = await Promise.all([
    latestRuuvi(sensorsForSource('ruuvi')),
    latestMatter(sensorsForSource('matter').filter((sensor) => sensor.kind !== 'door')),
    latestDoorStates(doors),
    latestCo2(sensorsForSource('ruuvi').filter((sensor) => sensor.hasCo2)),
  ]);

  const readings = new Map();
  for (const [source, rows] of [['ruuvi', ruuviRows], ['matter', matterRows]]) {
    for (const row of rows) {
      const sensor = lookup(source, row.key);
      if (!sensor) continue; // device not in the registry
      readings.set(sensor.id, row);
    }
  }

  const doorStates = new Map();
  for (const row of doorStateRows) {
    const sensor = lookup('matter', row.key);
    if (sensor?.kind === 'door') doorStates.set(sensor.id, row);
  }

  const co2 = new Map();
  for (const row of co2Rows) {
    const sensor = lookup('ruuvi', row.key);
    if (sensor?.hasCo2) co2.set(sensor.id, row.co2);
  }

  const now = Date.now();
  return SENSORS.map((sensor) => {
    const row = readings.get(sensor.id);
    const state = doorStates.get(sensor.id);
    // Door contacts are event-driven. Only climate sensors have a freshness
    // timestamp; an unchanged door remains valid regardless of its age.
    const ts = sensor.kind === 'door' ? null : row ? parseInfluxTime(row.time) : null;
    const ageSec = ts == null ? null : Math.max(0, Math.round((now - ts) / 1000));
    const stale = sensor.kind !== 'door' && (
      ageSec == null || ageSec > (sensor.staleAfterSec ?? SOURCES[sensor.source].staleAfterSec)
    );
    const stateTs = state ? parseInfluxTime(state.state_time) : null;
    return {
      id: sensor.id,
      label: sensor.label,
      kind: sensor.kind,
      tempC: row?.temp ?? null,
      humidity: row?.hum ?? null,
      co2: co2.get(sensor.id) ?? null,
      hasCo2: Boolean(sensor.hasCo2),
      battery: sensor.noBattery ? null : row?.batt ?? null,
      batteryKind: SOURCES[sensor.source].battKind,
      rssi: row?.rssi ?? null,
      closed: sensor.kind === 'door' && state?.closed != null ? state.closed !== 0 : null,
      stateTs,
      ts,
      ageSec,
      stale,
    };
  });
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

async function historyForSource(source, sensors, range) {
  if (!sensors.length) return [];
  const src = SOURCES[source];
  const { interval, bucket } = RANGES[range];
  const sql = `
    SELECT date_bin(INTERVAL '${bucket}', time) AS bucket,
      ${src.tag} AS key,
      avg(${src.temp}) AS temp,
      min(${src.temp}) AS temp_lo,
      max(${src.temp}) AS temp_hi,
      avg(${src.hum}) AS hum
    FROM ${src.table}
    WHERE time > now() - INTERVAL '${interval}'
      AND ${src.tag} IN (${sqlList(sensors.map((s) => s.key))})
    GROUP BY bucket, ${src.tag}
    ORDER BY bucket`;
  return query(src.db, sql);
}

/**
 * Bucketed history on a shared, evenly spaced time axis.
 *
 * Every series is padded to the full axis with nulls, which is what lets the
 * Matter sensors — whose history only starts partway through longer ranges —
 * render as a short line rather than a run of zeros.
 */
export async function fetchHistory(range = DEFAULT_RANGE, ids = null) {
  if (!RANGES[range]) throw new Error(`unknown range: ${range}`);
  const { bucketSec, spanSec } = RANGES[range];

  // Contact state changes are discrete events, not a temperature/humidity
  // series. Keeping doors out of this contract avoids presenting null charts.
  const wanted = (ids?.length ? SENSORS.filter((s) => ids.includes(s.id)) : SENSORS)
    .filter((s) => s.kind !== 'door');
  if (!wanted.length) return { range, bucketSec, t: [], series: [] };

  const [ruuviRows, matterRows] = await Promise.all([
    historyForSource('ruuvi', wanted.filter((s) => s.source === 'ruuvi'), range),
    historyForSource('matter', wanted.filter((s) => s.source === 'matter'), range),
  ]);

  // date_bin anchors buckets to the epoch, so the axis is built the same way.
  const nowSec = Math.floor(Date.now() / 1000);
  const lastBucket = Math.floor(nowSec / bucketSec) * bucketSec;
  const firstBucket = Math.floor((nowSec - spanSec) / bucketSec) * bucketSec;
  const count = Math.round((lastBucket - firstBucket) / bucketSec) + 1;

  const t = Array.from({ length: count }, (_, i) => firstBucket + i * bucketSec);
  const indexOf = (sec) => {
    const i = Math.round((sec - firstBucket) / bucketSec);
    return i >= 0 && i < count ? i : -1;
  };

  const series = new Map(
    wanted.map((s) => [
      s.id,
      {
        id: s.id,
        label: s.label,
        kind: s.kind,
        // Longest silence that still counts as normal for this sensor. The
        // client bridges null runs up to this long so a sensor reporting more
        // slowly than the bucket width doesn't render as a dashed line, while
        // a genuine outage still shows as a break.
        bridgeSec: SOURCES[s.source].staleAfterSec,
        temp: new Array(count).fill(null),
        tempLo: new Array(count).fill(null),
        tempHi: new Array(count).fill(null),
        hum: new Array(count).fill(null),
      },
    ]),
  );

  for (const [source, rows] of [['ruuvi', ruuviRows], ['matter', matterRows]]) {
    for (const row of rows) {
      const sensor = lookup(source, row.key);
      if (!sensor) continue;
      const target = series.get(sensor.id);
      if (!target) continue;
      const ms = parseInfluxTime(row.bucket);
      if (ms == null) continue;
      const i = indexOf(Math.floor(ms / 1000));
      if (i === -1) continue;
      target.temp[i] = row.temp ?? null;
      target.tempLo[i] = row.temp_lo ?? null;
      target.tempHi[i] = row.temp_hi ?? null;
      target.hum[i] = row.hum ?? null;
    }
  }

  return { range, bucketSec, t, series: [...series.values()] };
}
