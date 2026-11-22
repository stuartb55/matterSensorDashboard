// Stands in for InfluxDB in tests. The server modules read their settings at
// import time, so this must be imported before them.
process.env.INFLUX_TOKEN ??= 'test-token';
process.env.INFLUX_URL ??= 'http://influx.test';

const realFetch = globalThis.fetch;
let handler = () => [];

/** Every statement sent since the last reset, as { db, sql }. */
export const sent = [];

/** Every line protocol write, as { db, precision, token, lines[] }. */
export const written = [];

/**
 * Answer each query with `fn({ db, sql })`'s return value as the JSON rows.
 * Throwing from `fn` turns into an HTTP 500 from "InfluxDB".
 */
export function answer(fn) {
  handler = fn;
  sent.length = 0;
}

globalThis.fetch = async (url, init) => {
  if (!String(url).startsWith(process.env.INFLUX_URL)) return realFetch(url, init);
  const u = new URL(url);
  if (u.pathname === '/api/v3/write_lp') {
    written.push({
      db: u.searchParams.get('db'),
      precision: u.searchParams.get('precision'),
      token: init.headers.Authorization.replace(/^Bearer /, ''),
      lines: String(init.body).split('\n'),
    });
    return new Response(null, { status: 204 });
  }
  const { db, q } = JSON.parse(init.body);
  sent.push({ db, sql: q, token: init.headers.Authorization.replace(/^Bearer /, '') });
  try {
    const rows = await handler({ db, sql: q });
    return new Response(JSON.stringify(rows ?? []), { status: 200 });
  } catch (err) {
    return new Response(err.message, { status: 500 });
  }
};

/** Naive UTC timestamp in InfluxDB's own format (no zone suffix). */
export const influxTime = (ms) => new Date(ms).toISOString().replace('Z', '');
