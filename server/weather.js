// Outdoor temperature and humidity from Open-Meteo, as a reference for the
// indoor readings. Open-Meteo is free and needs no key.
//
// Configured from the environment (`.env`), never from the repository:
//   WEATHER_LAT, WEATHER_LON   where to read the weather for. Two decimal
//                              places (about 1 km) is plenty, and keeps the
//                              exact address out of requests to Open-Meteo.
// With either missing the feature is off and /api/weather reports that. The
// coordinates are never sent to the browser.

const LAT = Number.parseFloat(process.env.WEATHER_LAT ?? '');
const LON = Number.parseFloat(process.env.WEATHER_LON ?? '');
const BASE = (process.env.WEATHER_URL || 'https://api.open-meteo.com/v1/forecast').replace(/\/$/, '');
const TIMEOUT_MS = 8000;
// Open-Meteo's own model updates at most hourly; this keeps well inside its
// fair-use limits however many tabs are open.
const TTL_MS = 15 * 60_000;
// The most history the forecast endpoint serves.
const PAST_DAYS = 92;

export const weatherEnabled =
  Number.isFinite(LAT) && Number.isFinite(LON) && Math.abs(LAT) <= 90 && Math.abs(LON) <= 180;

export class WeatherError extends Error {
  constructor(message, status = 503) {
    super(message);
    this.status = status;
  }
}

/**
 * Open-Meteo's response reduced to what the dashboard shows: the current
 * reading and an hourly series, times in epoch seconds.
 */
export function shapeWeather(body) {
  const cur = body?.current ?? {};
  const hourly = body?.hourly ?? {};
  const t = Array.isArray(hourly.time) ? hourly.time : [];
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const nowSec = Date.now() / 1000;
  // The forecast part of the hourly series is a prediction, not a reading,
  // so only hours already past are kept.
  const keep = t.map((ts) => ts <= nowSec);
  return {
    enabled: true,
    current: {
      tempC: num(cur.temperature_2m),
      humidity: num(cur.relative_humidity_2m),
      ts: num(cur.time),
    },
    hourly: {
      t: t.filter((_, i) => keep[i]),
      temp: (hourly.temperature_2m ?? []).filter((_, i) => keep[i]).map(num),
      hum: (hourly.relative_humidity_2m ?? []).filter((_, i) => keep[i]).map(num),
    },
  };
}

let cache = { at: 0, data: null, inflight: null };

async function load() {
  const params = new URLSearchParams({
    latitude: LAT.toFixed(2),
    longitude: LON.toFixed(2),
    current: 'temperature_2m,relative_humidity_2m',
    hourly: 'temperature_2m,relative_humidity_2m',
    past_days: String(PAST_DAYS),
    forecast_days: '1',
    timeformat: 'unixtime',
    timezone: 'GMT',
  });
  let res;
  try {
    res = await fetch(`${BASE}?${params}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    throw new WeatherError(`cannot reach Open-Meteo: ${err.message}`);
  }
  if (!res.ok) throw new WeatherError(`Open-Meteo answered ${res.status}`, 502);
  return shapeWeather(await res.json());
}

export async function fetchWeather() {
  if (!weatherEnabled) return { enabled: false };
  if (cache.data && Date.now() - cache.at < TTL_MS) return cache.data;
  if (!cache.inflight) {
    cache.inflight = load()
      .then((data) => {
        cache = { at: Date.now(), data, inflight: null };
        return data;
      })
      .catch((err) => {
        cache.inflight = null;
        throw err;
      });
  }
  return cache.inflight;
}
