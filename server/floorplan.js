// Floor plan: an image per floor plus where each sensor sits on it.
//
// The real plan identifies the house, so it never lives in the repository. It
// is read from FLOORPLAN_DIR (default `floorplan/` at the repo root, which is
// gitignored and mounted into the container read-only). When that folder has
// no `floorplan.json`, the generic example in `server/floorplan-example/` is
// served instead so the view still works out of the box.
//
// The config is re-read on every request, so editing positions on the host
// shows up on the next page load without a restart.

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs/promises';
import { SENSORS } from './sensors.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const LOCAL_DIR = path.resolve(process.env.FLOORPLAN_DIR || path.join(ROOT, 'floorplan'));
const EXAMPLE_DIR = path.join(ROOT, 'server', 'floorplan-example');
const CONFIG = 'floorplan.json';

export const IMAGE_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
};

const KNOWN_IDS = new Set(SENSORS.map((s) => s.id));
const clamp01 = (v) => Math.min(1, Math.max(0, v));

async function readConfig(dir) {
  try {
    return JSON.parse(await fs.readFile(path.join(dir, CONFIG), 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw new Error(`${path.join(dir, CONFIG)}: ${err.message}`);
  }
}

/**
 * Validate the config into the shape the client gets. Image names are reduced
 * to a bare filename with an allowed extension, so the config can never point
 * the image route outside its folder. Markers for unknown sensor ids are
 * dropped and coordinates (fractions of the image width and height) clamped.
 */
function normalise(raw) {
  const floors = Array.isArray(raw?.floors) ? raw.floors : [];
  return floors
    .map((f, i) => {
      const image = typeof f?.image === 'string' ? path.basename(f.image) : '';
      if (!IMAGE_TYPES[path.extname(image).toLowerCase()]) return null;
      const markers = {};
      for (const [id, pos] of Object.entries(f.markers ?? {})) {
        const x = Number(pos?.x);
        const y = Number(pos?.y);
        if (KNOWN_IDS.has(id) && Number.isFinite(x) && Number.isFinite(y)) {
          markers[id] = { x: clamp01(x), y: clamp01(y) };
        }
      }
      return {
        id: typeof f.id === 'string' && f.id ? f.id : `floor${i + 1}`,
        label: typeof f.label === 'string' && f.label ? f.label : `Floor ${i + 1}`,
        image,
        markers,
      };
    })
    .filter(Boolean);
}

async function load() {
  const local = await readConfig(LOCAL_DIR);
  if (local) return { source: 'local', dir: LOCAL_DIR, floors: normalise(local) };
  return { source: 'example', dir: EXAMPLE_DIR, floors: normalise(await readConfig(EXAMPLE_DIR)) };
}

/** Public payload: floors with an image URL each. No host paths leak out. */
export async function floorplan() {
  const { source, floors } = await load();
  return {
    source,
    floors: floors.map((f) => ({
      ...f,
      imageUrl: `/api/floorplan/image/${encodeURIComponent(f.id)}`,
    })),
  };
}

/** Resolve a floor id to its image file, or null if there is no such floor. */
export async function floorImage(floorId) {
  const { dir, floors } = await load();
  const floor = floors.find((f) => f.id === floorId);
  if (!floor) return null;
  return {
    file: path.join(dir, floor.image),
    type: IMAGE_TYPES[path.extname(floor.image).toLowerCase()],
  };
}
