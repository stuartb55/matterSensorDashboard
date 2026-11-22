import { query, probe } from './influx.js';
import { SOURCES, lookup, sensorsForSource, SENSORS } from './sensors.js';

// Range presets. User input is matched against these keys only — no interval
// string ever reaches SQL from the client.
// `label` is what the range buttons show; the frontend reads this list from
// /api/sensors rather than keeping its own copy.
export const RANGES = {
  '1h': { label: '1H', interval: '1 hour', bucket: '1 minute', bucketSec: 60, spanSec: 3600 },
  '6h': { label: '6H', interval: '6 hours', bucket: '2 minutes', bucketSec: 120, spanSec: 6 * 3600 },
  '24h': { label: '24H', interval: '24 hours', bucket: '5 minutes', bucketSec: 300, spanSec: 24 * 3600 },
  '7d': { label: '7D', interval: '7 days', bucket: '30 minutes', bucketSec: 1800, spanSec: 7 * 86400 },
  '30d': { label: '30D', interval: '30 days', bucket: '3 hours', bucketSec: 10800, spanSec: 30 * 86400 },
  // Long ranges scan far more rows (Ruuvi tags broadcast about once a
  // second), so they get more time before the query is abandoned. How far back
  // they reach depends on the database's retention; a series simply starts
  // partway along the axis where data runs out, as Matter already does.
  '90d': {
    label: '90D',
    interval: '90 days',
    bucket: '12 hours',
    bucketSec: 43200,
    spanSec: 90 * 86400,
    timeoutMs: 45_000,
  },
  '1y': {
    label: '1Y',
    interval: '365 days',
    bucket: '1 day',
    bucketSec: 86400,
    spanSec: 365 * 86400,
    timeoutMs: 60_000,
  },
  // Not a button: 31 days of hourly buckets behind /api/daily, which the
  // frontend regroups into local calendar days (date_bin days are UTC).
  daily: {
    label: 'Daily',
    interval: '31 days',
    bucket: '1 hour',
    bucketSec: 3600,
    spanSec: 31 * 86400,
    timeoutMs: 30_000,
    hidden: true,
  },
};

/** Range keys a client may ask /api/history for. */
export const isPublicRange = (key) => Boolean(RANGES[key]) && !RANGES[key].hidden;

/** The public shape of the range presets, in button order. */
export function publicRanges() {
  return Object.entries(RANGES)
    .filter(([key]) => isPublicRange(key))
    .map(([key, { label, spanSec }]) => ({ key, label, spanSec }));
}

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

/**
 * Earliest past end time a client may ask for. Well beyond the longest
 * range, so any window that could hold data is reachable.
 */
const MAX_LOOKBACK_SEC = 400 * 86400;

/**
 * Validate a client-supplied window end (epoch seconds). Returns the integer,
 * null for "now", or throws. Only a number that passes this ever reaches SQL,
 * and then only as an ISO timestamp built here.
 */
export function parseEnd(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isInteger(n) || n < now - MAX_LOOKBACK_SEC) {
    throw Object.assign(new Error('end must be epoch seconds within the last 400 days'), {
      code: 'bad_end',
    });
  }
  // A future end is just "now".
  return n >= now ? null : n;
}

const isoSec = (sec) => new Date(sec * 1000).toISOString();

/**
 * The time condition for a range, ending now (relative to the database's own
 * clock) or at a fixed past instant. `after` is the window's open start, also
 * used to look up the state in force before it.
 */
export function timeWindow(range, endSec = null) {
  const { interval, spanSec } = RANGES[range];
  if (endSec == null) {
    const after = `now() - INTERVAL '${interval}'`;
    return { after, clause: `time > ${after}` };
  }
  const after = `'${isoSec(endSec - spanSec)}'`;
  return { after, clause: `time > ${after} AND time <= '${isoSec(endSec)}'` };
}

/**
 * Longest stretch read in one history query. InfluxDB has no disk to spill a
 * sort to, so a month or more of once-a-second Ruuvi rows in one statement
 * fails with "Memory Exhausted while Sorting" (measured 2026-11-22: 7d fine,
 * 30d and longer failing). A week is a whole number of every preset's buckets,
 * and date_bin anchors buckets to the epoch, so splitting at multiples of a
 * week never cuts a bucket in two.
 */
export const CHUNK_SEC = 7 * 86400;

/**
 * The time conditions that together cover a range, oldest first. A range of
 * a week or less is one condition, exactly timeWindow()'s. A longer one is cut
 * at epoch-aligned week boundaries into half-open pieces, so a row on a
 * boundary is read once; the newest piece is open-ended when the range ends
 * now, as timeWindow()'s is.
 */
export function timeChunks(range, endSec = null) {
  const { spanSec } = RANGES[range];
  if (spanSec <= CHUNK_SEC) return [timeWindow(range, endSec).clause];
  const end = endSec ?? Math.floor(Date.now() / 1000);
  const start = end - spanSec;
  const clauses = [];
  for (let lo = start; lo < end; ) {
    const hi = Math.min((Math.floor(lo / CHUNK_SEC) + 1) * CHUNK_SEC, end);
    const lower = lo === start ? `time > '${isoSec(lo)}'` : `time >= '${isoSec(lo)}'`;
    let upper = ` AND time < '${isoSec(hi)}'`;
    if (hi === end) upper = endSec == null ? '' : ` AND time <= '${isoSec(hi)}'`;
    clauses.push(lower + upper);
    lo = hi;
  }
  return clauses;
}

/**
 * Run a bucketed history statement over each of a range's time chunks in turn
 * and join the rows. One at a time, because running them together would ask
 * InfluxDB for the memory the split exists to avoid. Each piece gets the
 * range's own timeout; any failing piece fails the whole read, so a partial
 * history is never shown as complete.
 */
async function queryChunked(db, range, endSec, buildSql) {
  const { timeoutMs } = RANGES[range];
  const rows = [];
  for (const clause of timeChunks(range, endSec)) {
    rows.push(...(await query(db, buildSql(clause), { timeoutMs })));
  }
  return rows;
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

/** Rank rows per node by recency of a non-null value, nulls pushed last. */
function rankByField(src, col, alias) {
  return `row_number() OVER (PARTITION BY ${src.tag} ` +
    `ORDER BY CASE WHEN ${col} IS NULL THEN 1 ELSE 0 END, time DESC) AS ${alias}`;
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
  const rank = (col, alias) => rankByField(src, col, alias);

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

// ---------------------------------------------------------------------------
// Power meter
// ---------------------------------------------------------------------------

// Column lists change only when a new device starts writing, so they are
// looked up rarely.
const COLUMNS_TTL_MS = 10 * 60_000;
const columnCache = new Map();

/**
 * Columns that exist in a table, or null when the lookup itself fails (in which
 * case every configured column is tried and the query's own error decides).
 */
async function tableColumns(db, table) {
  const cacheKey = `${db}.${table}`;
  const hit = columnCache.get(cacheKey);
  if (hit && Date.now() - hit.at < COLUMNS_TTL_MS) return hit.cols;
  try {
    const rows = await query(
      db,
      `SELECT column_name FROM information_schema.columns WHERE table_name = ${sqlList([table])}`,
    );
    const cols = new Set(rows.map((r) => r.column_name));
    columnCache.set(cacheKey, { at: Date.now(), cols });
    return cols;
  } catch (err) {
    console.warn(`column lookup failed: ${err.message}`);
    return null;
  }
}

/**
 * Configured power fields that are actually present, as [name, { col, scale }].
 * A misnamed column drops that one measurement instead of the whole query.
 */
async function powerFields() {
  const src = SOURCES.matter;
  const cols = await tableColumns(src.db, src.table);
  return Object.entries(src.power).filter(([, f]) => !cols || cols.has(f.col));
}

const scaled = (value, field) => (value == null ? null : value * field.scale);

/**
 * Latest value of each electrical measurement. Ranked per field for the same
 * reason as latestMatter: a meter may write each measurement on its own row.
 * Like CO2, a failure here degrades to no power reading rather than taking the
 * climate cards down with it.
 */
async function latestPower(sensors) {
  if (!sensors.length) return [];
  const src = SOURCES.matter;
  try {
    const fields = await powerFields();
    if (!fields.length) return [];
    const sql = `
      SELECT ${src.tag} AS key,
        ${fields.map(([name, f]) => `max(${f.col}) FILTER (WHERE r_${name} = 1) AS ${name}`).join(',\n        ')},
        max(time) AS time
      FROM (
        SELECT ${src.tag}, ${fields.map(([, f]) => f.col).join(', ')}, time,
          ${fields.map(([name, f]) => rankByField(src, f.col, `r_${name}`)).join(',\n          ')}
        FROM ${src.table}
        WHERE time > now() - INTERVAL '${LATEST_LOOKBACK}'
          AND ${src.tag} IN (${sqlList(sensors.map((s) => s.key))})
      )
      GROUP BY ${src.tag}`;
    const rows = await query(src.db, sql);
    return rows.map((row) => {
      const out = { key: row.key, time: row.time };
      for (const [name, f] of fields) out[name] = scaled(row[name], f);
      return out;
    });
  } catch (err) {
    console.warn(`power query failed: ${err.message}`);
    return [];
  }
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
 * Health of each upstream feed, judged from the latest readings. A feed is
 * down when every sensor it carries has gone stale at once: one quiet sensor
 * is a flat battery, all of them together is the gateway or the writer that
 * feeds the database. Doors are left out, since a quiet door is just closed.
 */
export function feedHealth(readings) {
  const now = Date.now();
  return Object.entries(SOURCES).map(([id, src]) => {
    const ids = new Set(sensorsForSource(id).filter((s) => s.kind !== 'door').map((s) => s.id));
    const mine = readings.filter((r) => ids.has(r.id));
    const newest = mine.reduce((acc, r) => (r.ts != null && (acc == null || r.ts > acc) ? r.ts : acc), null);
    return {
      id,
      label: src.label,
      lastSeenSec: newest == null ? null : Math.max(0, Math.round((now - newest) / 1000)),
      down: mine.length > 0 && mine.every((r) => r.stale),
    };
  });
}

// ---------------------------------------------------------------------------
// Door events
// ---------------------------------------------------------------------------

/**
 * Collapse contact rows into state changes. A contact sensor may repeat its
 * current state (on reconnect, say), and a repeat is not an event.
 * `initial` is the state already in force when the window opened, or null.
 */
export function doorTransitions(initial, rows) {
  const events = [];
  let state = initial;
  for (const row of rows) {
    if (row.closed == null) continue;
    const closed = row.closed !== 0 && row.closed !== false;
    if (closed === state) continue;
    const ts = parseInfluxTime(row.time);
    if (ts == null) continue;
    events.push({ ts, closed });
    state = closed;
  }
  return events;
}

/**
 * Open/close history for every door over a range: the state when the window
 * opened, then each change inside it. Doors stay out of the history contract
 * (they are events, not a bucketed series), so they get their own shape:
 * `{ range, start, end, doors: [{ id, label, initial, events: [{ ts, closed }] }] }`,
 * with `start`/`end` in epoch seconds and event times in epoch milliseconds.
 */
export async function fetchDoorEvents(range = DEFAULT_RANGE, endSec = null) {
  if (!RANGES[range]) throw new Error(`unknown range: ${range}`);
  const { spanSec, timeoutMs } = RANGES[range];
  const win = timeWindow(range, endSec);
  const doors = SENSORS.filter((s) => s.kind === 'door');
  const end = endSec ?? Math.floor(Date.now() / 1000);
  const start = end - spanSec;
  if (!doors.length) return { range, start, end, doors: [] };

  const src = SOURCES.matter;
  const keys = sqlList(doors.map((s) => s.key));
  const [rows, priorRows] = await Promise.all([
    query(
      src.db,
      `
      SELECT ${src.tag} AS key, ${src.contact} AS closed, time
      FROM ${src.table}
      WHERE ${win.clause}
        AND ${src.tag} IN (${keys})
        AND ${src.contact} IS NOT NULL
      ORDER BY ${src.tag}, time`,
      { timeoutMs },
    ),
    // The state in force at the start of the window: the last change before
    // it, however long ago, as latestDoorStates does for the current state.
    query(
      src.db,
      `
      SELECT DISTINCT ON (${src.tag})
        ${src.tag} AS key, ${src.contact} AS closed, time
      FROM ${src.table}
      WHERE time <= ${win.after}
        AND ${src.tag} IN (${keys})
        AND ${src.contact} IS NOT NULL
      ORDER BY ${src.tag}, time DESC`,
      { timeoutMs },
    ),
  ]);

  const byKey = (list) => {
    const map = new Map();
    for (const row of list) {
      if (!map.has(row.key)) map.set(row.key, []);
      map.get(row.key).push(row);
    }
    return map;
  };
  const inWindow = byKey(rows);
  const prior = byKey(priorRows);

  return {
    range,
    start,
    end,
    doors: doors.map((door) => {
      const before = prior.get(door.key)?.[0]?.closed;
      const initial = before == null ? null : before !== 0 && before !== false;
      return {
        id: door.id,
        label: door.label,
        initial,
        events: doorTransitions(initial, inWindow.get(door.key) ?? []),
      };
    }),
  };
}

/**
 * Current reading for every registered sensor, normalised across both sources.
 * Sensors with no recent data are still returned, with null values, so the UI
 * can show them as offline.
 */
/** Temperature/humidity devices, as opposed to door contacts and meters. */
const isClimate = (sensor) => sensor.kind === 'room' || sensor.kind === 'equipment';

export async function fetchLatest() {
  const doors = SENSORS.filter((sensor) => sensor.kind === 'door');
  const meters = SENSORS.filter((sensor) => sensor.kind === 'power');
  const [ruuviRows, matterRows, doorStateRows, co2Rows, powerRows] = await Promise.all([
    latestRuuvi(sensorsForSource('ruuvi')),
    latestMatter(sensorsForSource('matter').filter((sensor) => isClimate(sensor))),
    latestDoorStates(doors),
    latestCo2(sensorsForSource('ruuvi').filter((sensor) => sensor.hasCo2)),
    latestPower(meters),
  ]);

  const readings = new Map();
  for (const [source, rows] of [['ruuvi', ruuviRows], ['matter', matterRows], ['matter', powerRows]]) {
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
      heating: sensor.heating ?? null,
      battery: sensor.noBattery ? null : row?.batt ?? null,
      batteryKind: SOURCES[sensor.source].battKind,
      rssi: row?.rssi ?? null,
      // Power meter only: watts, volts, amps and the cumulative kWh counter.
      watts: row?.watts ?? null,
      volts: row?.volts ?? null,
      amps: row?.amps ?? null,
      kwh: row?.kwh ?? null,
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

async function historyForSource(source, sensors, range, endSec) {
  if (!sensors.length) return [];
  const src = SOURCES[source];
  const { bucket } = RANGES[range];
  const sql = (window) => `
    SELECT date_bin(INTERVAL '${bucket}', time) AS bucket,
      ${src.tag} AS key,
      avg(${src.temp}) AS temp,
      min(${src.temp}) AS temp_lo,
      max(${src.temp}) AS temp_hi,
      avg(${src.hum}) AS hum,
      avg(${src.batt}) AS batt
    FROM ${src.table}
    WHERE ${window}
      AND ${src.tag} IN (${sqlList(sensors.map((s) => s.key))})
    GROUP BY bucket, ${src.tag}
    ORDER BY bucket`;
  return queryChunked(src.db, range, endSec, sql);
}

/**
 * Bucketed CO2, kept out of historyForSource for the same reasons as
 * latestCo2: only the Ruuvi Air carries it, and a failure here must cost the
 * CO2 chart alone, not every Ruuvi series.
 */
async function historyForCo2(sensors, range, endSec) {
  if (!sensors.length) return [];
  const src = SOURCES.ruuvi;
  const { bucket } = RANGES[range];
  const sql = (window) => `
    SELECT date_bin(INTERVAL '${bucket}', time) AS bucket,
      ${src.tag} AS key,
      avg(${src.co2}) AS co2,
      max(${src.co2}) AS co2_hi
    FROM ${src.table}
    WHERE ${window}
      AND ${src.tag} IN (${sqlList(sensors.map((s) => s.key))})
      AND ${src.co2} IS NOT NULL
    GROUP BY bucket, ${src.tag}
    ORDER BY bucket`;
  try {
    return await queryChunked(src.db, range, endSec, sql);
  } catch (err) {
    console.warn(`CO2 history query failed: ${err.message}`);
    return [];
  }
}

/**
 * Bucketed electrical history. Power keeps its min and max per bucket so a
 * kettle's short spike survives the averaging; the energy counter keeps both
 * ends of each bucket so consumption can be read off as its rise.
 */
const POWER_AGGREGATES = [
  ['watts', 'avg', 'watts'],
  ['wattsLo', 'min', 'watts'],
  ['wattsHi', 'max', 'watts'],
  ['volts', 'avg', 'volts'],
  ['amps', 'avg', 'amps'],
  ['kwhLo', 'min', 'kwh'],
  ['kwhHi', 'max', 'kwh'],
];

async function historyForPower(sensors, range, endSec) {
  if (!sensors.length) return [];
  const src = SOURCES.matter;
  const { bucket } = RANGES[range];
  try {
    const present = new Map(await powerFields());
    const aggs = POWER_AGGREGATES.filter(([, , field]) => present.has(field));
    if (!aggs.length) return [];
    const sql = (window) => `
      SELECT date_bin(INTERVAL '${bucket}', time) AS bucket,
        ${src.tag} AS key,
        ${aggs.map(([alias, fn, field]) => `${fn}(${present.get(field).col}) AS "${alias}"`).join(',\n        ')}
      FROM ${src.table}
      WHERE ${window}
        AND ${src.tag} IN (${sqlList(sensors.map((s) => s.key))})
      GROUP BY bucket, ${src.tag}
      ORDER BY bucket`;
    const rows = await queryChunked(src.db, range, endSec, sql);
    return rows.map((row) => {
      const out = { bucket: row.bucket, key: row.key };
      for (const [alias, , field] of aggs) out[alias] = scaled(row[alias], present.get(field));
      return out;
    });
  } catch (err) {
    console.warn(`power history query failed: ${err.message}`);
    return [];
  }
}

/**
 * The shared time axis for a range: evenly spaced bucket starts anchored to
 * the epoch, as date_bin anchors them, plus a lookup from a bucket's start
 * (epoch seconds) to its index, or -1 when it falls outside the axis.
 */
export function bucketAxis(range, endSec = null) {
  const { bucketSec, spanSec } = RANGES[range];
  const nowSec = endSec ?? Math.floor(Date.now() / 1000);
  const lastBucket = Math.floor(nowSec / bucketSec) * bucketSec;
  const firstBucket = Math.floor((nowSec - spanSec) / bucketSec) * bucketSec;
  const count = Math.round((lastBucket - firstBucket) / bucketSec) + 1;
  const t = Array.from({ length: count }, (_, i) => firstBucket + i * bucketSec);
  const indexOf = (sec) => {
    const i = Math.round((sec - firstBucket) / bucketSec);
    return i >= 0 && i < count ? i : -1;
  };
  return { t, count, indexOf };
}

const hasNoBattery = (sensor) => Boolean(sensor.noBattery);

/**
 * Bucketed history on a shared, evenly spaced time axis.
 *
 * Every series is padded to the full axis with nulls, which is what lets the
 * Matter sensors — whose history only starts partway through longer ranges —
 * render as a short line rather than a run of zeros.
 */
export async function fetchHistory(range = DEFAULT_RANGE, ids = null, endSec = null) {
  if (!RANGES[range]) throw new Error(`unknown range: ${range}`);
  const { bucketSec } = RANGES[range];

  // Contact state changes are discrete events, not a temperature/humidity
  // series. Keeping doors out of this contract avoids presenting null charts.
  const wanted = (ids?.length ? SENSORS.filter((s) => ids.includes(s.id)) : SENSORS)
    .filter((s) => s.kind !== 'door');
  if (!wanted.length) return { range, end: endSec, bucketSec, t: [], series: [] };

  const climate = wanted.filter(isClimate);
  const [ruuviRows, matterRows, powerRows, co2Rows] = await Promise.all([
    historyForSource('ruuvi', climate.filter((s) => s.source === 'ruuvi'), range, endSec),
    historyForSource('matter', climate.filter((s) => s.source === 'matter'), range, endSec),
    historyForPower(wanted.filter((s) => s.kind === 'power'), range, endSec),
    historyForCo2(climate.filter((s) => s.source === 'ruuvi' && s.hasCo2), range, endSec),
  ]);

  const { t, count, indexOf } = bucketAxis(range, endSec);

  const empty = () => new Array(count).fill(null);
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
        bridgeSec: s.staleAfterSec ?? SOURCES[s.source].staleAfterSec,
        // Meters carry electrical series; everything else is climate.
        ...(s.kind === 'power'
          ? Object.fromEntries(POWER_AGGREGATES.map(([alias]) => [alias, empty()]))
          : { temp: empty(), tempLo: empty(), tempHi: empty(), hum: empty(), batt: empty() }),
        // CO2 bucket average and peak, only on sensors that measure it.
        ...(s.hasCo2 ? { co2: empty(), co2Hi: empty() } : {}),
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
      target.batt[i] = hasNoBattery(sensor) ? null : row.batt ?? null;
    }
  }

  for (const row of co2Rows) {
    const sensor = lookup('ruuvi', row.key);
    const target = sensor?.hasCo2 && series.get(sensor.id);
    if (!target) continue;
    const ms = parseInfluxTime(row.bucket);
    if (ms == null) continue;
    const i = indexOf(Math.floor(ms / 1000));
    if (i === -1) continue;
    target.co2[i] = row.co2 ?? null;
    target.co2Hi[i] = row.co2_hi ?? null;
  }

  for (const row of powerRows) {
    const sensor = lookup('matter', row.key);
    const target = sensor && series.get(sensor.id);
    if (!target) continue;
    const ms = parseInfluxTime(row.bucket);
    if (ms == null) continue;
    const i = indexOf(Math.floor(ms / 1000));
    if (i === -1) continue;
    for (const [alias] of POWER_AGGREGATES) target[alias][i] = row[alias] ?? null;
  }

  return { range, end: endSec, bucketSec, t, series: [...series.values()] };
}
