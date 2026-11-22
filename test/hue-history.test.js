import { test } from 'node:test';
import assert from 'node:assert/strict';

// Hue and the history token are read at import time, so set them first.
process.env.HUE_BRIDGE = 'bridge.test';
process.env.HUE_APP_KEY = 'app-key';
process.env.HUE_HISTORY_TOKEN = 'history-token';
const { answer, influxTime, sent, written } = await import('./influx-mock.js');
const { roomLines, fetchLightHistory, shapeLightHistory, startRecorder, lightHistoryEnabled, TABLE } =
  await import('../server/hue-history.js');
const { RANGES } = await import('../server/queries.js');

const room = (over) => ({
  id: 'lights:living_room',
  label: 'Living room',
  total: 3,
  onCount: 2,
  unreachable: 0,
  brightness: 61.6,
  ...over,
});

test('history is on once Hue and the token are both set', () => {
  assert.equal(lightHistoryEnabled, true);
});

test('roomLines writes one integer row per room, brightness only when lit', () => {
  const lines = roomLines(
    [room(), room({ id: 'lights:hall', onCount: 0, brightness: null, unreachable: 1 })],
    1_700_000_000,
  );
  assert.deepEqual(lines, [
    `${TABLE},room=living_room lit=2i,total=3i,unreachable=0i,brightness=62i 1700000000`,
    `${TABLE},room=hall lit=0i,total=3i,unreachable=1i 1700000000`,
  ]);
});

test('roomLines escapes line protocol specials in a room key', () => {
  const [line] = roomLines([room({ id: 'lights:a b,c=d' })], 1);
  assert.match(line, /room=a\\ b\\,c\\=d /);
});

test('the recorder writes to the history database with the history token', async () => {
  written.length = 0;
  const log = { info() {}, warn() {} };
  const timer = startRecorder(async () => ({ enabled: true, rooms: [room()] }), log);
  clearInterval(timer);
  // The first write happens straight away, without waiting a minute.
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(written.length, 1);
  assert.equal(written[0].db, 'hue');
  assert.equal(written[0].precision, 'second');
  assert.equal(written[0].token, 'history-token');
  assert.match(written[0].lines[0], /^hue_rooms,room=living_room lit=2i/);
});

test('a failing bridge is logged once, not every minute', async () => {
  const warnings = [];
  const log = { info() {}, warn: (_o, m) => warnings.push(m) };
  const timer = startRecorder(async () => {
    throw new Error('bridge down');
  }, log);
  clearInterval(timer);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(warnings.length, 1);
});

test('fetchLightHistory reads with the history token and pads onto the shared axis', async () => {
  const end = 1_700_006_400; // a multiple of 300, so buckets line up
  const { bucketSec } = RANGES['24h'];
  answer(() => [
    { bucket: influxTime((end - 2 * bucketSec) * 1000), room: 'hall', share: 0.5, lit: 1, lit_max: 2 },
    { bucket: influxTime(end * 1000), room: 'hall', share: 1, lit: 2, lit_max: 2 },
    { bucket: influxTime((end - 99 * 86400) * 1000), room: 'hall', share: 1, lit: 1, lit_max: 1 },
  ]);
  const h = await fetchLightHistory('24h', end);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].db, 'hue');
  assert.equal(sent[0].token, 'history-token');
  assert.match(sent[0].sql, /FROM hue_rooms/);
  assert.match(sent[0].sql, /unreachable < total/);
  assert.match(sent[0].sql, /time > '[^']+' AND time <= '[^']+'/);

  assert.equal(h.enabled, true);
  assert.equal(h.bucketSec, bucketSec);
  const [hall] = h.rooms;
  assert.equal(hall.id, 'lights:hall');
  assert.equal(hall.share.length, h.t.length);
  assert.equal(hall.share.at(-1), 1);
  assert.equal(hall.share.at(-3), 0.5);
  assert.equal(hall.litMax.at(-3), 2);
  // Nulls, not zeros, where nothing was recorded; the out-of-window row is dropped.
  assert.equal(hall.share.at(-2), null);
  assert.equal(hall.share.filter((v) => v != null).length, 2);
});

test('shapeLightHistory gives an empty room list when nothing is recorded', () => {
  const h = shapeLightHistory([], '1h', 1_700_000_000);
  assert.deepEqual(h.rooms, []);
  assert.equal(h.t.length, 61);
});
