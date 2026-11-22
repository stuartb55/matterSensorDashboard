// Single source of truth for the sensor inventory.
//
// Two upstream systems store temperature/humidity with different schemas and
// cadences. Everything downstream reads from here, so adding a sensor is a
// one-line change and the rest of the app never sees the schema difference.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SOURCES = {
  ruuvi: {
    // Shown in the feed-down banner; the only part of a source that reaches
    // the browser.
    label: 'Ruuvi',
    db: 'ruuvi',
    table: 'ruuvi_measurements',
    tag: 'name',
    temp: 'temperature',
    hum: 'humidity',
    // camelCase columns must stay double-quoted or DataFusion lowercases them
    // and fails with "No field named batteryvoltage".
    batt: '"batteryVoltage"',
    battKind: 'volts',
    // Only the Ruuvi Air carries a CO2 sensor; other tags leave this null.
    co2: 'co2',
    // Ruuvi tags broadcast roughly once a second.
    staleAfterSec: 120,
  },
  matter: {
    label: 'Matter',
    db: 'matter',
    table: 'matter',
    tag: 'node',
    temp: 'temperature_c',
    hum: 'humidity_pct',
    batt: 'battery_pct',
    contact: 'contact_closed',
    // Electrical measurements from a power meter (Shelly 1PM Gen4). Every
    // value arrives on its own row (power and current only when they change,
    // energy once a minute), so each one is ranked independently. `scale` converts the stored value to the
    // unit shown: W, V, A and kWh. Columns missing from the table are skipped
    // rather than failing the query, so a wrong name here costs one reading,
    // not the whole dashboard.
    power: {
      watts: { col: 'power_w', scale: 1 },
      // The column exists, but the Shelly 1PM Gen4 leaves it empty.
      volts: { col: 'voltage_v', scale: 1 },
      amps: { col: 'current_a', scale: 1 },
      // Lifetime counter in Wh. Consumption over a range is the rise in this
      // value; when it is absent the frontend integrates power instead.
      kwh: { col: 'energy_wh', scale: 0.001 },
    },
    battKind: 'pct',
    // IKEA sensors average a reading every ~6 min, but measured gaps reach 29
    // min in normal operation. Threshold sits well above that so ordinary
    // jitter never reads as offline.
    staleAfterSec: 2700,
  },
};

// The built-in inventory. A `config/sensors.json` on the host replaces it
// (see loadSensors below), so a new sensor needs no rebuild.
export const DEFAULT_SENSORS = [
  { id: 'living_room', label: 'Living Room', kind: 'room', source: 'ruuvi', key: 'LivingRoom' },
  { id: 'bedroom', label: 'Bedroom', kind: 'room', source: 'ruuvi', key: 'Bedroom' },
  { id: 'office', label: 'Office', kind: 'room', source: 'ruuvi', key: 'Office' },
  // Mains-powered, so it never reports a battery voltage.
  { id: 'ruuvi_air', label: 'Ruuvi Air', kind: 'room', source: 'ruuvi', key: 'RuuviAir', noBattery: true, hasCo2: true },
  // Hot water tank: sits near 47C while rooms sit near 25C. Kept out of the
  // shared room scale so it doesn't flatten every room curve.
  // `heating` turns on reheat detection in its detail sheet: a climb of at
  // least `minRiseC` counts as the tank being heated, and `hotC` is the
  // temperature it should be above to be ready for use.
  {
    id: 'hot_water',
    label: 'Hot Water',
    kind: 'equipment',
    source: 'ruuvi',
    key: 'HotWater',
    heating: { minRiseC: 2, hotC: 45 },
  },
  { id: 'bathroom', label: 'Bathroom', kind: 'room', source: 'matter', key: 'Bathroom' },
  { id: 'kitchen', label: 'Kitchen', kind: 'room', source: 'matter', key: 'Kitchen' },
  { id: 'hallway', label: 'Hallway', kind: 'room', source: 'matter', key: 'Hallway' },
  { id: 'closet', label: 'Closet', kind: 'room', source: 'matter', key: 'Closet' },
  // Contact state is event-driven, so its latest known state is retained
  // without treating the time since it changed as an outage.
  {
    id: 'garage',
    label: 'Garage',
    kind: 'door',
    source: 'matter',
    // IKEA MYGGBETT contact sensor: node_id 6, endpoint 1.
    key: 'Garage',
    noBattery: true,
  },
  {
    id: 'back_door',
    label: 'Back Door',
    kind: 'door',
    source: 'matter',
    key: 'BackDoor',
    noBattery: true,
  },
  // Shelly 1PM Gen4 power meter over Matter (node_id 7), on the network kit.
  // Mains-powered and on its own scale (watts), so it gets its own section and
  // never joins a climate plot.
  {
    id: 'network_power',
    label: 'Network',
    kind: 'power',
    source: 'matter',
    key: 'Network',
    noBattery: true,
  },
];

const KINDS = new Set(['room', 'equipment', 'door', 'power']);
const ID_RE = /^[a-z0-9_]+$/;

/**
 * Check a sensor list from the config file and return it normalised, or throw
 * naming every problem found. Only fields the app understands are kept, so a
 * stray key can't reach SQL or the browser.
 */
export function validateSensors(list) {
  if (!Array.isArray(list)) throw new Error('sensors.json must hold an array of sensors');
  const problems = [];
  const seen = new Set();
  const out = list.map((raw, i) => {
    const where = `sensor ${i + 1}${raw?.id ? ` (${raw.id})` : ''}`;
    const fail = (msg) => problems.push(`${where}: ${msg}`);
    if (!raw || typeof raw !== 'object') {
      fail('is not an object');
      return null;
    }
    const { id, label, kind, source, key } = raw;
    if (typeof id !== 'string' || !ID_RE.test(id)) fail('id must be lowercase letters, digits and _');
    else if (seen.has(id)) fail('id is used twice');
    else seen.add(id);
    if (typeof label !== 'string' || !label.trim()) fail('label is required');
    if (!KINDS.has(kind)) fail(`kind must be one of ${[...KINDS].join(', ')}`);
    if (!SOURCES[source]) fail(`source must be one of ${Object.keys(SOURCES).join(', ')}`);
    if (typeof key !== 'string' || !key) fail('key (the tag value upstream) is required');
    if (raw.hasCo2 && source !== 'ruuvi') fail('hasCo2 only applies to ruuvi sensors');
    if (raw.slot != null && !(Number.isInteger(raw.slot) && raw.slot >= 1 && raw.slot <= 8)) {
      fail('slot must be a whole number from 1 to 8');
    }
    if (raw.staleAfterSec != null && !(Number.isFinite(raw.staleAfterSec) && raw.staleAfterSec > 0)) {
      fail('staleAfterSec must be a positive number');
    }
    if (raw.heating != null) {
      const { minRiseC, hotC } = raw.heating;
      if (!Number.isFinite(minRiseC) || !Number.isFinite(hotC)) fail('heating needs minRiseC and hotC numbers');
    }
    const sensor = { id, label, kind, source, key };
    if (raw.noBattery) sensor.noBattery = true;
    if (raw.hasCo2) sensor.hasCo2 = true;
    if (raw.slot != null) sensor.slot = raw.slot;
    if (raw.staleAfterSec != null) sensor.staleAfterSec = raw.staleAfterSec;
    if (raw.heating != null) sensor.heating = { minRiseC: raw.heating.minRiseC, hotC: raw.heating.hotC };
    return sensor;
  });
  if (problems.length) throw new Error(`invalid sensors.json:\n  ${problems.join('\n  ')}`);
  return out;
}

const CONFIG_DIR = path.resolve(
  process.env.CONFIG_DIR || path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'config'),
);

/**
 * The sensor list in force: `sensors.json` in CONFIG_DIR when present
 * (mounted read-only from the host, like the floor plan), else the built-in
 * list. A file that is present but wrong stops the server with the reasons,
 * rather than quietly showing the wrong house.
 */
function loadSensors() {
  const file = path.join(CONFIG_DIR, 'sensors.json');
  if (!fs.existsSync(file)) return { list: DEFAULT_SENSORS, from: 'builtin' };
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`cannot read ${file}: ${err.message}`);
  }
  return { list: validateSensors(parsed.sensors ?? parsed), from: 'file' };
}

const loaded = loadSensors();
export const SENSORS = loaded.list;
export const SENSORS_FROM = loaded.from;

const BY_SOURCE_KEY = new Map(SENSORS.map((s) => [`${s.source}:${s.key}`, s]));

/**
 * Resolve an upstream tag value back to a sensor. Returns undefined for
 * devices not in the registry, which is how the stray unnamed Matter node
 * ("TIMMERFLOTTE temp/hmd sensor") gets filtered out.
 */
export function lookup(source, key) {
  return BY_SOURCE_KEY.get(`${source}:${key}`);
}

export function sensorsForSource(source) {
  return SENSORS.filter((s) => s.source === source);
}

/** Public shape of the registry — no database details leak to the client. */
export function publicRegistry() {
  return SENSORS.map(({ id, label, kind, noBattery, source, slot }) => ({
    id,
    label,
    kind,
    hasBattery: !noBattery,
    batteryKind: SOURCES[source].battKind,
    ...(slot ? { slot } : {}),
  }));
}
