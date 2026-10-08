// Single source of truth for the sensor inventory.
//
// Two upstream systems store temperature/humidity with different schemas and
// cadences. Everything downstream reads from here, so adding a sensor is a
// one-line change and the rest of the app never sees the schema difference.

export const SOURCES = {
  ruuvi: {
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
    db: 'matter',
    table: 'matter',
    tag: 'node',
    temp: 'temperature_c',
    hum: 'humidity_pct',
    batt: 'battery_pct',
    contact: 'contact_closed',
    battKind: 'pct',
    // IKEA sensors average a reading every ~6 min, but measured gaps reach 29
    // min in normal operation. Threshold sits well above that so ordinary
    // jitter never reads as offline.
    staleAfterSec: 2700,
  },
};

export const SENSORS = [
  { id: 'living_room', label: 'Living Room', kind: 'room', source: 'ruuvi', key: 'LivingRoom' },
  { id: 'bedroom', label: 'Bedroom', kind: 'room', source: 'ruuvi', key: 'Bedroom' },
  { id: 'office', label: 'Office', kind: 'room', source: 'ruuvi', key: 'Office' },
  // Mains-powered, so it never reports a battery voltage.
  { id: 'ruuvi_air', label: 'Ruuvi Air', kind: 'room', source: 'ruuvi', key: 'RuuviAir', noBattery: true, hasCo2: true },
  // Hot water tank: sits near 47C while rooms sit near 25C. Kept out of the
  // shared room scale so it doesn't flatten every room curve.
  { id: 'hot_water', label: 'Hot Water', kind: 'equipment', source: 'ruuvi', key: 'HotWater' },
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
];

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
  return SENSORS.map(({ id, label, kind, noBattery, source }) => ({
    id,
    label,
    kind,
    hasBattery: !noBattery,
    batteryKind: SOURCES[source].battKind,
  }));
}
