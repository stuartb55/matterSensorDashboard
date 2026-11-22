import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shapeWeather } from '../server/weather.js';

test('shapeWeather keeps past hours only and nulls bad values', () => {
  const now = Math.floor(Date.now() / 1000);
  const hour = 3600;
  const shaped = shapeWeather({
    current: { time: now, temperature_2m: 7.2, relative_humidity_2m: 88 },
    hourly: {
      time: [now - 2 * hour, now - hour, now + hour],
      temperature_2m: [6.5, null, 9],
      relative_humidity_2m: [90, 89, 80],
    },
  });
  assert.deepEqual(shaped.current, { tempC: 7.2, humidity: 88, ts: now });
  assert.deepEqual(shaped.hourly.t, [now - 2 * hour, now - hour]);
  assert.deepEqual(shaped.hourly.temp, [6.5, null]);
  assert.deepEqual(shaped.hourly.hum, [90, 89]);
});

test('shapeWeather survives an empty body', () => {
  assert.deepEqual(shapeWeather({}).hourly, { t: [], temp: [], hum: [] });
});
