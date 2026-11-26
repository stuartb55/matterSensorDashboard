import { test } from 'node:test';
import assert from 'node:assert/strict';

// Settings are read at import time, so they are set before the import below.
process.env.OCTOPUS_API_KEY = 'sk_test_key';
process.env.OCTOPUS_ACCOUNT = 'A-TEST0001';
process.env.OCTOPUS_URL = 'http://octopus.test';
delete process.env.GAS_PRICE;
delete process.env.GAS_UNITS;

const requests = [];
const realFetch = globalThis.fetch;
const NOW = Date.now();
const iso = (ms) => new Date(ms).toISOString();

globalThis.fetch = async (url, init = {}) => {
  if (!String(url).startsWith('http://octopus.test')) return realFetch(url, init);
  const u = new URL(url);
  requests.push({ path: u.pathname, auth: init.headers?.Authorization ?? null });
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
  if (u.pathname === '/v1/accounts/A-TEST0001/') {
    return json({
      properties: [
        {
          moved_in_at: '2015-01-01T00:00:00Z',
          moved_out_at: '2020-01-01T00:00:00Z',
          gas_meter_points: [{ mprn: 'OLD', meters: [{ serial_number: 'OLDSERIAL' }], agreements: [] }],
        },
        {
          moved_in_at: '2020-01-02T00:00:00Z',
          moved_out_at: null,
          gas_meter_points: [
            {
              mprn: '1234567890',
              meters: [{ serial_number: 'EMPTY' }, { serial_number: 'G4P0000' }],
              agreements: [
                { tariff_code: 'G-1R-VAR-OLD-A', valid_from: '2020-01-02T00:00:00Z', valid_to: '2026-09-06T00:00:00+01:00' },
                { tariff_code: 'G-1R-OE-FIX-18M-26-09-01-A', valid_from: '2026-09-06T00:00:00+01:00', valid_to: null },
              ],
            },
          ],
        },
      ],
    });
  }
  if (u.pathname === '/v1/gas-meter-points/1234567890/meters/EMPTY/consumption/') return json({ results: [] });
  if (u.pathname === '/v1/gas-meter-points/1234567890/meters/G4P0000/consumption/') {
    return json({
      results: [
        { consumption: 0.5, interval_start: iso(NOW - 2 * 3600_000), interval_end: iso(NOW - 1.5 * 3600_000) },
        { consumption: 0.25, interval_start: iso(NOW - 3 * 3600_000), interval_end: iso(NOW - 2.5 * 3600_000) },
      ],
    });
  }
  if (u.pathname.startsWith('/v1/products/')) {
    // Octopus answers 400 when period_to is not after period_from.
    const from = u.searchParams.get('period_from');
    const to = u.searchParams.get('period_to');
    if (to != null && Date.parse(to) <= Date.parse(from)) return json({ period_from: ['Must not be greater than period_to'] }, 400);
  }
  if (u.pathname.endsWith('/standard-unit-rates/')) {
    return json({
      results: [
        { value_inc_vat: 8.5, valid_from: iso(NOW + 30 * 86_400_000), valid_to: null },
        { value_inc_vat: 7.11018, valid_from: iso(NOW - 30 * 86_400_000), valid_to: iso(NOW + 30 * 86_400_000) },
      ],
    });
  }
  if (u.pathname.endsWith('/standing-charges/')) return json({ results: [{ value_inc_vat: 29.02998 }] });
  return json({ detail: 'not found' }, 404);
};

const { currentAgreement, currentGasPoints, fetchGas, kwhPerUnit, productOf, shapeConsumption } =
  await import('../server/octopus.js');

test('productOf takes the product out of a single-register gas tariff code', () => {
  assert.equal(productOf('G-1R-OE-FIX-18M-26-09-01-A'), 'OE-FIX-18M-26-09-01');
  assert.equal(productOf('E-1R-AGILE-24-10-01-C'), null);
  assert.equal(productOf(undefined), null);
});

test('kwhPerUnit converts cubic metres with the calorific value', () => {
  assert.equal(kwhPerUnit({ GAS_UNITS: 'kwh' }).factor, 1);
  const m3 = kwhPerUnit({});
  assert.equal(m3.units, 'm3');
  assert.ok(Math.abs(m3.factor - (39.5 * 1.02264) / 3.6) < 1e-9);
  assert.ok(Math.abs(kwhPerUnit({ GAS_CALORIFIC_VALUE: '40' }).factor - (40 * 1.02264) / 3.6) < 1e-9);
});

test('shapeConsumption sorts, converts, and drops unreadable or repeated rows', () => {
  const out = shapeConsumption(
    [
      { consumption: 2, interval_start: '2026-11-20T00:30:00Z' },
      { consumption: 1, interval_start: '2026-11-20T00:00:00Z' },
      { consumption: 9, interval_start: '2026-11-20T00:00:00Z' },
      { consumption: null, interval_start: '2026-11-20T01:00:00Z' },
      { consumption: 1, interval_start: 'nonsense' },
      { consumption: 3, interval_start: '2026-11-20T01:30:00+01:00' },
    ],
    10,
  );
  const s = (x) => Date.parse(x) / 1000;
  // 01:30+01:00 is 00:30Z again, so it is a repeat and the first reading stands.
  assert.deepEqual(out.t, [s('2026-11-20T00:00:00Z'), s('2026-11-20T00:30:00Z')]);
  assert.deepEqual(out.kwh, [10, 20]);
});

test('currentGasPoints skips properties moved out of; currentAgreement picks the live one', () => {
  const account = {
    properties: [
      { moved_out_at: '2020-01-01T00:00:00Z', gas_meter_points: [{ mprn: 'OLD' }] },
      { moved_out_at: null, gas_meter_points: [{ mprn: 'NEW', agreements: [] }] },
    ],
  };
  assert.deepEqual(currentGasPoints(account).map((p) => p.mprn), ['NEW']);
  const point = {
    agreements: [
      { tariff_code: 'G-1R-A-A', valid_from: '2020-01-01T00:00:00Z', valid_to: '2021-01-01T00:00:00Z' },
      { tariff_code: 'G-1R-B-A', valid_from: '2021-01-01T00:00:00Z', valid_to: null },
    ],
  };
  assert.equal(currentAgreement(point).tariff_code, 'G-1R-B-A');
});

test('fetchGas finds the meter with readings, prices it, and sends no identifiers to the browser', async () => {
  const data = await fetchGas();
  assert.equal(data.enabled, true);
  assert.equal(data.units, 'm3');
  assert.equal(data.t.length, 2);
  assert.ok(data.t[0] < data.t[1]);
  assert.ok(Math.abs(data.kwh[0] - 0.25 * data.kwhPerUnit) < 0.01);
  assert.ok(Math.abs(data.tariff.perKwh - 0.0711018) < 1e-9);
  assert.ok(Math.abs(data.tariff.standingPerDay - 0.2902998) < 1e-9);
  assert.equal(data.tariff.source, 'octopus');
  const body = JSON.stringify(data);
  for (const secret of ['1234567890', 'G4P0000', 'A-TEST0001', 'sk_test_key']) {
    assert.ok(!body.includes(secret), `${secret} leaked into the response`);
  }
  // The key goes to account and meter calls, never to the public price list.
  for (const r of requests) {
    if (r.path.startsWith('/v1/products/')) assert.equal(r.auth, null);
    else assert.match(r.auth, /^Basic /);
  }
  // Cached: a second call makes no requests.
  const before = requests.length;
  await fetchGas();
  assert.equal(requests.length, before);
});
