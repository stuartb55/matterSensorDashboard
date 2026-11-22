// Thin client over the InfluxDB 3 SQL endpoint.
//
// The InfluxDB token lives only here, server-side. The browser never receives
// it and never sends SQL — callers pass fully-formed statements built in
// queries.js from an allowlisted registry.

const INFLUX_URL = (process.env.INFLUX_URL || 'http://localhost:8181').replace(/\/$/, '');
const INFLUX_TOKEN = process.env.INFLUX_TOKEN || process.env.influxdb_token;

if (!INFLUX_TOKEN) {
  throw new Error('INFLUX_TOKEN (or influxdb_token) must be set — check .env');
}

// Optional second token for the Hue light history database: the recorder
// writes light states there and the history endpoint reads them back. It is
// separate so the main token can stay read-only on the sensor databases.
const HISTORY_TOKEN = (process.env.HUE_HISTORY_TOKEN || '').trim();
export const historyTokenSet = Boolean(HISTORY_TOKEN);

const QUERY_TIMEOUT_MS = 15_000;
const WRITE_TIMEOUT_MS = 10_000;
// The container healthcheck gives up at 5s, so the probe must fail first.
const PROBE_TIMEOUT_MS = 4_000;

export class InfluxError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'InfluxError';
    this.status = status;
  }
}

/**
 * Run a SQL query against a database and return an array of row objects.
 */
export async function query(db, sql, { timeoutMs = QUERY_TIMEOUT_MS, history = false } = {}) {
  if (history && !HISTORY_TOKEN) throw new InfluxError('HUE_HISTORY_TOKEN is not set', 503);
  const signal = AbortSignal.timeout(timeoutMs);
  let res;
  try {
    res = await fetch(`${INFLUX_URL}/api/v3/query_sql`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${history ? HISTORY_TOKEN : INFLUX_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ db, q: sql, format: 'json' }),
      signal,
    });
  } catch (err) {
    // Covers connection refused (InfluxDB restarting) and query timeouts.
    throw new InfluxError(`cannot reach InfluxDB at ${INFLUX_URL}: ${err.message}`, 503);
  }

  const body = await res.text();
  if (!res.ok) {
    throw new InfluxError(`query failed (${res.status}): ${body.slice(0, 300)}`, 502);
  }

  try {
    return JSON.parse(body);
  } catch {
    throw new InfluxError(`unparseable response: ${body.slice(0, 200)}`, 502);
  }
}

/**
 * Write line protocol (second precision) with the history token. Used only by
 * the Hue recorder; nothing else in the dashboard writes to InfluxDB.
 */
export async function writeLines(db, lines) {
  if (!HISTORY_TOKEN) throw new InfluxError('HUE_HISTORY_TOKEN is not set', 503);
  if (!lines.length) return;
  const params = new URLSearchParams({ db, precision: 'second' });
  let res;
  try {
    res = await fetch(`${INFLUX_URL}/api/v3/write_lp?${params}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${HISTORY_TOKEN}`,
        'Content-Type': 'text/plain; charset=utf-8',
      },
      body: lines.join('\n'),
      signal: AbortSignal.timeout(WRITE_TIMEOUT_MS),
    });
  } catch (err) {
    throw new InfluxError(`cannot reach InfluxDB at ${INFLUX_URL}: ${err.message}`, 503);
  }
  if (!res.ok) {
    const body = await res.text();
    throw new InfluxError(`write failed (${res.status}): ${body.slice(0, 300)}`, 502);
  }
}

/**
 * Liveness probe used by /health. Deliberately a query rather than InfluxDB's
 * /ping: this token is scoped to the sensor databases, while /ping needs a
 * system-level token and answers 403 here. A trivial query also proves the
 * path the app actually depends on, not just that the port is open.
 */
export async function probe(db) {
  await query(db, 'SELECT 1', { timeoutMs: PROBE_TIMEOUT_MS });
}

export const influxUrl = INFLUX_URL;
