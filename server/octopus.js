// Half-hourly gas use from the smart meter, read through the Octopus Energy
// API. Gas here is only used for heating, so this is the heating's fuel bill.
//
// Configured from the environment (`.env`), never from the repository:
//   OCTOPUS_API_KEY      the account's API key (octopus.energy, Personal details
//                        -> API access). Sent only to api.octopus.energy.
//   OCTOPUS_ACCOUNT      the account number, A-XXXXXXXX.
//   GAS_UNITS            what the meter reports: m3 (default; SMETS2 meters)
//                        or kwh (SMETS1 meters).
//   GAS_CALORIFIC_VALUE  MJ per m3, from the bill (default 39.5). Only used
//                        when the meter reports m3.
//   GAS_PRICE            optional, currency per kWh including VAT, e.g. 0.0711.
//   GAS_STANDING         optional, currency per day including VAT, e.g. 0.2903.
//                        Without these the current tariff is looked up from
//                        the account's gas agreement.
// With the key or the account missing the feature is off and /api/gas says so.
// The meter point, meter serial and account number never leave this module:
// the browser gets kWh per half hour and a price, nothing that identifies the
// supply.

const API_KEY = process.env.OCTOPUS_API_KEY?.trim() || '';
const ACCOUNT = process.env.OCTOPUS_ACCOUNT?.trim() || '';
const BASE = (process.env.OCTOPUS_URL || 'https://api.octopus.energy').replace(/\/$/, '');
const TIMEOUT_MS = 15_000;
// Smart meter readings reach Octopus once a day, usually overnight, so there
// is nothing to gain from asking more often than this.
const TTL_MS = 60 * 60_000;
// Enough for a month of complete days plus the comparisons either side.
export const HISTORY_DAYS = 62;

// Standard UK conversion: volume correction factor 1.02264, calorific value in
// MJ/m3, 3.6 MJ per kWh.
const VOLUME_CORRECTION = 1.02264;

export const gasEnabled = Boolean(API_KEY && ACCOUNT);

export class GasError extends Error {
  constructor(message, status = 503) {
    super(message);
    this.status = status;
  }
}

const positive = (raw) => {
  const n = Number.parseFloat(raw ?? '');
  return Number.isFinite(n) && n > 0 ? n : null;
};

/** kWh per unit the meter reports: 1 for kWh meters, about 11.2 for m3. */
export function kwhPerUnit(env = process.env) {
  const units = String(env.GAS_UNITS || 'm3').toLowerCase();
  if (units === 'kwh') return { units: 'kWh', factor: 1 };
  const cv = positive(env.GAS_CALORIFIC_VALUE) ?? 39.5;
  return { units: 'm3', factor: (cv * VOLUME_CORRECTION) / 3.6, calorificValue: cv };
}

/**
 * The gas meter points of the property currently lived in, newest move-in
 * first. Octopus keeps old properties on the account with a move-out date.
 */
export function currentGasPoints(account, now = Date.now()) {
  const props = Array.isArray(account?.properties) ? account.properties : [];
  return props
    .filter((p) => !p.moved_out_at || Date.parse(p.moved_out_at) > now)
    .sort((a, b) => Date.parse(b.moved_in_at ?? 0) - Date.parse(a.moved_in_at ?? 0))
    .flatMap((p) => (Array.isArray(p.gas_meter_points) ? p.gas_meter_points : []))
    .filter((mp) => mp?.mprn);
}

/** The agreement in force now, or null. */
export function currentAgreement(point, now = Date.now()) {
  const list = Array.isArray(point?.agreements) ? point.agreements : [];
  return (
    list.find(
      (a) =>
        a?.tariff_code &&
        (!a.valid_from || Date.parse(a.valid_from) <= now) &&
        (!a.valid_to || Date.parse(a.valid_to) > now),
    ) ?? null
  );
}

/**
 * Product code inside a tariff code: G-1R-OE-FIX-18M-26-09-01-A carries the
 * product OE-FIX-18M-26-09-01 (gas, single register, region A).
 */
export function productOf(tariffCode) {
  const m = /^G-1R-(.+)-[A-P]$/.exec(String(tariffCode ?? ''));
  return m ? m[1] : null;
}

/**
 * Octopus consumption rows to the shape the browser uses: interval starts in
 * epoch seconds, oldest first, and kWh. Rows with unreadable times or values
 * are dropped rather than shown as zero.
 */
export function shapeConsumption(rows, factor) {
  const pairs = [];
  for (const r of Array.isArray(rows) ? rows : []) {
    const ms = Date.parse(r?.interval_start ?? '');
    const v = r?.consumption;
    if (!Number.isFinite(ms) || typeof v !== 'number' || !Number.isFinite(v) || v < 0) continue;
    pairs.push([Math.round(ms / 1000), v * factor]);
  }
  pairs.sort((a, b) => a[0] - b[0]);
  const t = [];
  const kwh = [];
  for (const [sec, value] of pairs) {
    if (t.length && t.at(-1) === sec) continue; // a repeated interval
    t.push(sec);
    kwh.push(Math.round(value * 10_000) / 10_000);
  }
  return { t, kwh };
}

function authHeader() {
  return `Basic ${Buffer.from(`${API_KEY}:`).toString('base64')}`;
}

// Error messages reach the browser, so they name what failed, never the URL
// (which carries the account number, meter point and serial).
async function getJson(path, what, { auth = true } = {}) {
  let res;
  try {
    res = await fetch(`${BASE}${path}`, {
      headers: { Accept: 'application/json', ...(auth ? { Authorization: authHeader() } : {}) },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new GasError(`cannot reach Octopus Energy for the ${what}: ${err.name}`);
  }
  if (res.status === 401 || res.status === 403) {
    throw new GasError(`Octopus Energy refused the API key (${res.status})`, 502);
  }
  if (!res.ok) throw new GasError(`Octopus Energy answered ${res.status} for the ${what}`, 502);
  return res.json();
}

async function consumption(mprn, serial, fromIso) {
  const params = new URLSearchParams({ period_from: fromIso, page_size: '25000', order_by: 'period' });
  const body = await getJson(
    `/v1/gas-meter-points/${encodeURIComponent(mprn)}/meters/${encodeURIComponent(serial)}/consumption/?${params}`,
    'gas readings',
  );
  return Array.isArray(body?.results) ? body.results : [];
}

/** Current unit rate and standing charge for a gas tariff, in currency units. */
async function lookupTariff(tariffCode) {
  const product = productOf(tariffCode);
  if (!product) return null;
  const now = Date.now();
  // period_from alone: Octopus refuses a period_to equal to period_from (400).
  const at = new Date(now).toISOString();
  const path = (kind) =>
    `/v1/products/${encodeURIComponent(product)}/gas-tariffs/${encodeURIComponent(tariffCode)}/${kind}/?period_from=${at}`;
  // Product prices are public, so no key goes with these.
  const [rates, standing] = await Promise.all([
    getJson(path('standard-unit-rates'), 'gas unit rate', { auth: false }),
    getJson(path('standing-charges'), 'gas standing charge', { auth: false }),
  ]);
  // The price in force now; results can include a later price change too.
  const pence = (body) => {
    const list = Array.isArray(body?.results) ? body.results : [];
    const live =
      list.find(
        (r) =>
          (!r.valid_from || Date.parse(r.valid_from) <= now) &&
          (!r.valid_to || Date.parse(r.valid_to) > now),
      ) ?? list[0];
    const v = live?.value_inc_vat;
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  };
  const rate = pence(rates);
  if (rate == null) return null;
  const day = pence(standing);
  return { perKwh: rate / 100, standingPerDay: day == null ? null : day / 100, source: 'octopus' };
}

function tariffFromEnv(env = process.env) {
  const perKwh = positive(env.GAS_PRICE);
  if (perKwh == null) return null;
  return { perKwh, standingPerDay: positive(env.GAS_STANDING), source: 'env' };
}

// Which meter has the data is worked out once: a supply point often lists an
// old meter alongside the current one, and only one of them returns readings.
let meter = null;

async function findMeter(fromIso) {
  const account = await getJson(`/v1/accounts/${encodeURIComponent(ACCOUNT)}/`, 'account');
  for (const point of currentGasPoints(account)) {
    const serials = (point.meters ?? []).map((m) => m?.serial_number).filter(Boolean);
    for (const serial of serials) {
      const rows = await consumption(point.mprn, serial, fromIso);
      if (rows.length) {
        return { mprn: point.mprn, serial, tariffCode: currentAgreement(point)?.tariff_code ?? null, rows };
      }
    }
  }
  throw new GasError('no gas meter on the account has returned any readings', 502);
}

async function load(log) {
  const fromIso = new Date(Date.now() - HISTORY_DAYS * 86_400_000).toISOString();
  let rows;
  if (meter) {
    try {
      rows = await consumption(meter.mprn, meter.serial, fromIso);
    } catch (err) {
      meter = null; // look the meter up again next time, in case it changed
      throw err;
    }
  } else {
    const found = await findMeter(fromIso);
    meter = { mprn: found.mprn, serial: found.serial, tariffCode: found.tariffCode };
    rows = found.rows;
  }

  const conv = kwhPerUnit();
  let tariff = tariffFromEnv();
  if (!tariff && meter.tariffCode) {
    try {
      tariff = await lookupTariff(meter.tariffCode);
    } catch (err) {
      log?.warn({ err: err.message }, 'gas tariff lookup failed');
      tariff = null; // costs are an extra; the readings still show
    }
  }
  const currency = (process.env.ENERGY_CURRENCY || '£').slice(0, 3);
  return {
    enabled: true,
    units: conv.units,
    kwhPerUnit: Math.round(conv.factor * 1000) / 1000,
    intervalSec: 1800,
    tariff: tariff ? { ...tariff, currency } : null,
    ...shapeConsumption(rows, conv.factor),
  };
}

let cache = { at: 0, data: null, inflight: null };

export async function fetchGas(log) {
  if (!gasEnabled) return { enabled: false };
  if (cache.data && Date.now() - cache.at < TTL_MS) return cache.data;
  if (!cache.inflight) {
    cache.inflight = load(log)
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
