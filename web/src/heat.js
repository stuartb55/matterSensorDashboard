// Room shading for the floor plan: which sensor sits in which room, and which
// bin of a fixed scale its reading falls in. Pure functions, so they can be
// tested without a browser.

/** Ray-casting point-in-polygon test; points on an edge may fall either way. */
export function insidePolygon([x, y], pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i, i += 1) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * Fixed bins rather than a scale stretched to today's readings: a room should
 * look the same shade for the same temperature on any day, and an evenly warm
 * house should look even, not striped.
 */
export const MEASURES = {
  temp: {
    label: 'Temperature',
    unit: '°C',
    field: 'tempC',
    edges: [16, 18, 20, 22, 24],
  },
  hum: {
    label: 'Humidity',
    unit: '%',
    field: 'humidity',
    edges: [40, 50, 60, 70],
  },
  co2: {
    label: 'CO₂',
    unit: ' ppm',
    field: 'co2',
    edges: [600, 800, 1000, 1400],
  },
};

/** Index of the bin a value falls in: 0 below the first edge, edges.length at or above the last. */
export function binOf(value, edges) {
  let i = 0;
  while (i < edges.length && value >= edges[i]) i += 1;
  return i;
}

/** Legend text for each bin: "< 16", "16–18", …, "≥ 24". */
export function binLabels(edges) {
  const fmt = (v) => v.toLocaleString();
  return [
    `< ${fmt(edges[0])}`,
    ...edges.slice(1).map((e, i) => `${fmt(edges[i])}–${fmt(e)}`),
    `≥ ${fmt(edges.at(-1))}`,
  ];
}

/** The ramp has six steps; a scale with fewer bins spreads across all six. */
export const RAMP_STEPS = 6;
export const rampStep = (bin, binCount) =>
  binCount <= 1 ? 0 : Math.round((bin * (RAMP_STEPS - 1)) / (binCount - 1));

/**
 * The value each room should be shaded by: the mean of the live readings of
 * climate sensors whose markers sit inside it. Rooms with none get null.
 * `rooms` are polygons (arrays of [x, y]); `markers` maps id -> { x, y }.
 */
export function roomValues(rooms, markers, readingsById, field) {
  return rooms.map((pts) => {
    let sum = 0;
    let n = 0;
    for (const [id, pos] of Object.entries(markers)) {
      const r = readingsById.get(id);
      if (!r || r.stale || r.kind !== 'room' || r[field] == null) continue;
      if (!insidePolygon([pos.x, pos.y], pts)) continue;
      sum += r[field];
      n += 1;
    }
    return n ? sum / n : null;
  });
}
