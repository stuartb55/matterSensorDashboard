// Floor plan: each floor drawn from a JSON layout of rooms, doors, windows and
// stairs, plus where each sensor sits on it. The browser renders it as SVG in
// the dashboard's own theme, so colours and rooms change by editing data, not
// by redrawing an image.
//
// The real layout identifies the house, so it never lives in the repository.
// It is read from FLOORPLAN_DIR (default `floorplan/` at the repo root, which is
// gitignored and mounted into the container read-only). When that folder has
// no `floorplan.json`, the generic example in `server/floorplan-example/` is
// served instead so the view still works out of the box.
//
// The file is re-read on every request, so editing it on the host shows up on
// the next page load without a restart.

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs/promises';
import { SENSORS } from './sensors.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const LOCAL_DIR = path.resolve(process.env.FLOORPLAN_DIR || path.join(ROOT, 'floorplan'));
const EXAMPLE_DIR = path.join(ROOT, 'server', 'floorplan-example');
const CONFIG = 'floorplan.json';

const KNOWN_IDS = new Set(SENSORS.map((s) => s.id));

// Colours are handed to SVG attributes, so only plain colour values pass:
// hex, a named colour, or one of the theme's own custom properties.
const COLOUR = /^(#[0-9a-f]{3,8}|[a-z]{3,20}|var\(--[a-z0-9-]{1,40}\))$/i;

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const text = (v, max = 60) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
const colour = (v) => (typeof v === 'string' && COLOUR.test(v) ? v : undefined);
const list = (v) => (Array.isArray(v) ? v : []);

function point(p) {
  const x = num(p?.[0]);
  const y = num(p?.[1]);
  return x == null || y == null ? null : [x, y];
}

/**
 * A room is a rectangle `rect: [x, y, w, h]` or a polygon `points: [[x, y], ...]`.
 * It is passed on in the form it was written, so an exported layout stays as
 * easy to edit as the one it came from.
 */
function shape(item) {
  if (Array.isArray(item?.rect)) {
    const rect = item.rect.map(num);
    const [, , w, h] = rect;
    return rect.length === 4 && rect.every((v) => v != null) && w > 0 && h > 0 ? { rect } : null;
  }
  const points = list(item?.points).map(point);
  return points.length >= 3 && points.every(Boolean) ? { points } : null;
}

/** Doors, windows and low walls are a segment: `from` and `to`. */
function segment(item) {
  const from = point(item?.from);
  const to = point(item?.to);
  return from && to ? { from, to } : null;
}

function normaliseFloor(f, i) {
  const width = num(f?.width);
  const height = num(f?.height);
  if (!(width > 0 && height > 0)) return null;

  const rooms = list(f.rooms)
    .map((r) => {
      const geometry = shape(r);
      if (!geometry) return null;
      const label = point(r.label);
      return {
        name: text(r.name) ?? '',
        ...geometry,
        ...(label && { label }),
        ...(colour(r.fill) && { fill: r.fill }),
        // Shrinks or enlarges the name, for cupboards and other small rooms.
        ...(num(r.labelSize) > 0 && { labelSize: Math.min(3, num(r.labelSize)) }),
      };
    })
    .filter(Boolean);

  const stairs = list(f.stairs)
    .map((s) => {
      const [x, y, w, h] = list(s?.rect).map(num);
      if ([x, y, w, h].some((v) => v == null) || w <= 0 || h <= 0) return null;
      const steps = Math.min(30, Math.max(2, Math.round(num(s.steps) ?? 10)));
      return { rect: [x, y, w, h], steps, along: s.along === 'y' ? 'y' : 'x' };
    })
    .filter(Boolean);

  // Markers sit in the same units as the rooms and are clamped onto the floor.
  const markers = {};
  for (const [id, pos] of Object.entries(f.markers ?? {})) {
    const x = num(pos?.x);
    const y = num(pos?.y);
    if (KNOWN_IDS.has(id) && x != null && y != null) {
      markers[id] = { x: Math.min(width, Math.max(0, x)), y: Math.min(height, Math.max(0, y)) };
    }
  }

  return {
    id: text(f.id, 40) ?? `floor${i + 1}`,
    label: text(f.label) ?? `Floor ${i + 1}`,
    width,
    height,
    rooms,
    doors: list(f.doors).map(segment).filter(Boolean),
    windows: list(f.windows).map(segment).filter(Boolean),
    // Low walls, banisters and half-height partitions: drawn thinner than a wall.
    barriers: list(f.barriers).map(segment).filter(Boolean),
    stairs,
    markers,
  };
}

async function readConfig(dir) {
  try {
    return JSON.parse(await fs.readFile(path.join(dir, CONFIG), 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw new Error(`${path.join(dir, CONFIG)}: ${err.message}`);
  }
}

/** The plan as the client gets it. No host paths leak out. */
export async function floorplan() {
  const local = await readConfig(LOCAL_DIR);
  const raw = local ?? (await readConfig(EXAMPLE_DIR));
  return {
    source: local ? 'local' : 'example',
    floors: list(raw?.floors).map(normaliseFloor).filter(Boolean),
  };
}
