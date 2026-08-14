import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';

import { influxUrl, InfluxError } from './influx.js';
import { fetchLatest, fetchHistory, probeUpstream, RANGES, DEFAULT_RANGE } from './queries.js';
import { publicRegistry } from './sensors.js';

const PORT = Number(process.env.PORT || 8090);
const HOST = process.env.HOST || '0.0.0.0';
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DIST = path.join(ROOT, 'web', 'dist');

const app = Fastify({
  logger: { level: process.env.LOG_LEVEL || 'info' },
});

// Latest readings are polled by every open tab; a short TTL keeps a handful of
// phones and desktops from multiplying load on InfluxDB.
const LATEST_TTL_MS = 10_000;
let latestCache = { at: 0, data: null, inflight: null };

async function cachedLatest() {
  const now = Date.now();
  if (latestCache.data && now - latestCache.at < LATEST_TTL_MS) return latestCache.data;
  // Collapse concurrent misses into one upstream query.
  if (!latestCache.inflight) {
    latestCache.inflight = fetchLatest()
      .then((data) => {
        latestCache = { at: Date.now(), data, inflight: null };
        return data;
      })
      .catch((err) => {
        latestCache.inflight = null;
        throw err;
      });
  }
  return latestCache.inflight;
}

function sendUpstreamError(reply, err, log) {
  log.error({ err: err.message }, 'upstream query failed');
  const status = err instanceof InfluxError ? err.status : 500;
  return reply.code(status).send({ error: 'upstream_unavailable', message: err.message });
}

app.get('/health', async (_req, reply) => {
  try {
    const { db } = await probeUpstream();
    return { ok: true, influx: { url: influxUrl, db } };
  } catch (err) {
    // Logged as well as returned: the container healthcheck discards the body,
    // so without this an unhealthy container gives no reason in the logs.
    app.log.error({ err: err.message }, 'health probe failed');
    return reply.code(503).send({ ok: false, influx: { url: influxUrl }, message: err.message });
  }
});

app.get('/api/sensors', async () => ({ sensors: publicRegistry() }));

app.get('/api/readings/latest', async (_req, reply) => {
  try {
    return { readings: await cachedLatest(), fetchedAt: Date.now() };
  } catch (err) {
    return sendUpstreamError(reply, err, app.log);
  }
});

app.get('/api/history', async (req, reply) => {
  const range = String(req.query.range || DEFAULT_RANGE);
  if (!RANGES[range]) {
    return reply.code(400).send({ error: 'bad_range', allowed: Object.keys(RANGES) });
  }
  const ids = req.query.sensors
    ? String(req.query.sensors).split(',').map((s) => s.trim()).filter(Boolean)
    : null;
  try {
    return await fetchHistory(range, ids);
  } catch (err) {
    return sendUpstreamError(reply, err, app.log);
  }
});

// Static frontend. Absent in server-only development, where Vite serves it.
if (fs.existsSync(DIST)) {
  await app.register(fastifyStatic, { root: DIST });
  // SPA fallback: unknown non-API paths return the app shell.
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/')) {
      return reply.code(404).send({ error: 'not_found' });
    }
    return reply.sendFile('index.html');
  });
} else {
  app.log.warn(`no build at ${DIST} — API only (run "npm run build" or use the Vite dev server)`);
}

try {
  await app.listen({ port: PORT, host: HOST });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    await app.close();
    process.exit(0);
  });
}
