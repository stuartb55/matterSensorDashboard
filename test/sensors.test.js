import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SENSORS, validateSensors } from '../server/sensors.js';

test('the built-in list passes its own validation', () => {
  assert.equal(validateSensors(DEFAULT_SENSORS).length, DEFAULT_SENSORS.length);
});

test('validateSensors keeps known fields only', () => {
  const [s] = validateSensors([
    { id: 'loft', label: 'Loft', kind: 'room', source: 'matter', key: 'Loft', slot: 3, sql: 'x' },
  ]);
  assert.deepEqual(s, { id: 'loft', label: 'Loft', kind: 'room', source: 'matter', key: 'Loft', slot: 3 });
});

test('validateSensors names every problem', () => {
  assert.throws(
    () =>
      validateSensors([
        { id: 'Bad Id', label: '', kind: 'oven', source: 'zigbee', key: '' },
        { id: 'a', label: 'A', kind: 'room', source: 'matter', key: 'A', hasCo2: true },
        { id: 'a', label: 'A2', kind: 'room', source: 'ruuvi', key: 'A2', slot: 9 },
      ]),
    (err) => {
      for (const bit of ['id must be', 'label is required', 'kind must be', 'source must be', 'key', 'hasCo2', 'used twice', 'slot']) {
        assert.ok(err.message.includes(bit), `missing: ${bit}`);
      }
      return true;
    },
  );
  assert.throws(() => validateSensors({}), /array/);
});
