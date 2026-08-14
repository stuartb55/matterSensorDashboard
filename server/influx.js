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

const QUERY_TIMEOUT_MS = 15_000;
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
export async function query(db, sql, { timeoutMs = QUERY_TIMEOUT_MS } = {}) {
  const signal = AbortSignal.timeout(timeoutMs);
  let res;
  try {
    res = await fetch(`${INFLUX_URL}/api/v3/query_sql`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${INFLUX_TOKEN}`,
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
 * Liveness probe used by /health. Deliberately a query rather than InfluxDB's
 * /ping: this token is scoped to the sensor databases, while /ping needs a
 * system-level token and answers 403 here. A trivial query also proves the
 * path the app actually depends on, not just that the port is open.
 */
export async function probe(db) {
  await query(db, 'SELECT 1', { timeoutMs: PROBE_TIMEOUT_MS });
}

export const influxUrl = INFLUX_URL;
