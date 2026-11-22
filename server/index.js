import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';

import { influxUrl, InfluxError } from './influx.js';
import {
  fetchLatest,
  fetchHistory,
  fetchDoorEvents,
  feedHealth,
  probeUpstream,
  publicRanges,
  isPublicRange,
  RANGES,
  DEFAULT_RANGE,
} from './queries.js';
import { publicRegistry } from './sensors.js';
import { floorplan } from './floorplan.js';
import { fetchLights, HueError } from './hue.js';
import { fetchWeather, WeatherError } from './weather.js';

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

app.get('/api/sensors', async () => ({
  sensors: publicRegistry(),
  ranges: publicRanges(),
  defaultRange: DEFAULT_RANGE,
}));

app.get('/api/floorplan', async (_req, reply) => {
  try {
    return await floorplan();
  } catch (err) {
    app.log.error({ err: err.message }, 'floor plan config unreadable');
    return reply.code(500).send({ error: 'bad_floorplan', message: err.message });
  }
});

// Same reasoning as the latest-readings cache: every open tab polls, and the
// bridge is a small embedded device that rate-limits busy clients.
const LIGHTS_TTL_MS = 10_000;
let lightsCache = { at: 0, data: null, inflight: null };

async function cachedLights() {
  if (lightsCache.data && Date.now() - lightsCache.at < LIGHTS_TTL_MS) return lightsCache.data;
  if (!lightsCache.inflight) {
    lightsCache.inflight = fetchLights()
      .then((data) => {
        lightsCache = { at: Date.now(), data, inflight: null };
        return data;
      })
      .catch((err) => {
        lightsCache.inflight = null;
        throw err;
      });
  }
  return lightsCache.inflight;
}

app.get('/api/lights', async (_req, reply) => {
  try {
    return { ...(await cachedLights()), fetchedAt: Date.now() };
  } catch (err) {
    app.log.error({ err: err.message }, 'hue bridge request failed');
    const status = err instanceof HueError ? err.status : 500;
    return reply.code(status).send({ error: 'hue_unavailable', message: err.message });
  }
});

// Outdoor reference from Open-Meteo; cached inside weather.js for 15 minutes.
app.get('/api/weather', async (_req, reply) => {
  try {
    return await fetchWeather();
  } catch (err) {
    app.log.error({ err: err.message }, 'weather request failed');
    const status = err instanceof WeatherError ? err.status : 500;
    return reply.code(status).send({ error: 'weather_unavailable', message: err.message });
  }
});

app.get('/api/readings/latest', async (_req, reply) => {
  try {
    const readings = await cachedLatest();
    return { readings, feeds: feedHealth(readings), fetchedAt: Date.now() };
  } catch (err) {
    return sendUpstreamError(reply, err, app.log);
  }
});

app.get('/api/history', async (req, reply) => {
  const range = String(req.query.range || DEFAULT_RANGE);
  if (!isPublicRange(range)) {
    return reply.code(400).send({ error: 'bad_range', allowed: publicRanges().map((r) => r.key) });
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

app.get('/api/doors/events', async (req, reply) => {
  const range = String(req.query.range || DEFAULT_RANGE);
  if (!isPublicRange(range)) {
    return reply.code(400).send({ error: 'bad_range', allowed: publicRanges().map((r) => r.key) });
  }
  try {
    return await fetchDoorEvents(range);
  } catch (err) {
    return sendUpstreamError(reply, err, app.log);
  }
});

// Thirty-one days of hourly buckets for every sensor, which the browser
// regroups into calendar days for energy totals and daily highs and lows. It
// only changes hour by hour, so it is cached for ten minutes.
const DAILY_TTL_MS = 10 * 60_000;
let dailyCache = { at: 0, data: null, inflight: null };

function energyTariff() {
  const perKwh = Number.parseFloat(process.env.ENERGY_PRICE ?? '');
  if (!Number.isFinite(perKwh) || perKwh < 0) return null;
  return { perKwh, currency: (process.env.ENERGY_CURRENCY || '£').slice(0, 3) };
}

app.get('/api/daily', async (_req, reply) => {
  try {
    if (!dailyCache.data || Date.now() - dailyCache.at >= DAILY_TTL_MS) {
      if (!dailyCache.inflight) {
        dailyCache.inflight = fetchHistory('daily')
          .then((data) => {
            dailyCache = { at: Date.now(), data, inflight: null };
            return data;
          })
          .catch((err) => {
            dailyCache.inflight = null;
            throw err;
          });
      }
      await dailyCache.inflight;
    }
    return { ...dailyCache.data, tariff: energyTariff() };
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
