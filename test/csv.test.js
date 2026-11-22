import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.TZ = 'UTC';
const { toCsv } = await import('../web/src/csv.js');

test('toCsv writes oldest first, skips empty rows and quotes awkward labels', () => {
  const csv = toCsv([0, 60, 120], [
    { label: 'Temp °C', values: [20.25, null, 21] },
    { label: 'Note, with comma', values: [1, null, null] },
  ]);
  const lines = csv.trim().split('\n');
  assert.equal(lines[0], 'time_utc,local_time,Temp °C,"Note, with comma"');
  assert.equal(lines.length, 3);
  assert.ok(lines[1].startsWith('1970-01-01T00:00:00.000Z,'));
  assert.ok(lines[1].endsWith(',20.25,1'));
  assert.ok(lines[2].endsWith(',21,'));
});
