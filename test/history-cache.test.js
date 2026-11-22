import { test } from 'node:test';
import assert from 'node:assert/strict';
import './influx-mock.js';

const { cacheLongHistory } = await import('../server/history-cache.js');

function counting() {
  const calls = [];
  const fetcher = async (range, ids, end) => {
    calls.push([range, ids, end]);
    return { range, n: calls.length };
  };
  return { calls, fetcher };
}

test('ranges of a week or less are never cached', async () => {
  const { calls, fetcher } = counting();
  const cached = cacheLongHistory(fetcher);
  await cached('7d');
  await cached('7d');
  await cached('24h', null, 1_790_000_000);
  assert.equal(calls.length, 3);
});

test('long ranges are cached per range, sensors and end until the TTL passes', async () => {
  let clock = 0;
  const { calls, fetcher } = counting();
  const cached = cacheLongHistory(fetcher, { ttlMs: 1000, now: () => clock });
  const a = await cached('1y');
  assert.equal((await cached('1y')).n, a.n);
  await cached('1y', ['office', 'bedroom']);
  assert.equal(calls.length, 2);
  await cached('1y', ['bedroom', 'office']);
  assert.equal(calls.length, 2, 'sensor order does not matter');
  await cached('1y', null, 1_790_000_000);
  await cached('30d');
  assert.equal(calls.length, 4);
  clock = 1000;
  assert.notEqual((await cached('1y')).n, a.n);
  assert.equal(calls.length, 5);
});

test('concurrent requests share one read and failures are not cached', async () => {
  let fail = true;
  let calls = 0;
  const cached = cacheLongHistory(async () => {
    calls += 1;
    await new Promise((r) => setTimeout(r, 1));
    if (fail) throw new Error('upstream');
    return { ok: true };
  });
  const results = await Promise.allSettled([cached('90d'), cached('90d')]);
  assert.equal(calls, 1);
  assert.ok(results.every((r) => r.status === 'rejected'));
  fail = false;
  assert.deepEqual(await cached('90d'), { ok: true });
  assert.equal(calls, 2);
});
