// Philips Hue lights, read live from the Hue Bridge's local API (CLIP v2).
//
// Lights are state, not measurements, so they skip InfluxDB: the server asks
// the bridge directly and the dashboard shows what is on right now. Nothing is
// ever written to the bridge — the dashboard has no login of its own, so it
// stays view-only.
//
// Configured from the environment (`.env`), never from the repository:
//   HUE_BRIDGE   the bridge's address on the LAN (host or IP)
//   HUE_APP_KEY  an application key from pressing the bridge's link button
// With either missing the feature is off and /api/lights reports that.
//
// Lights are grouped by the rooms set up in the Hue app, and each room becomes
// one dashboard entry with the id `lights:<room_slug>`. That id is what a
// floor plan marker uses, so the plan places a room's lights, not every bulb.

import https from 'node:https';

const BRIDGE = (process.env.HUE_BRIDGE || '').trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
const APP_KEY = (process.env.HUE_APP_KEY || '').trim();
const TIMEOUT_MS = 4000;

export const hueEnabled = Boolean(BRIDGE && APP_KEY);

// The bridge serves HTTPS with a certificate from Signify's own CA, issued to
// the bridge id rather than its address, so ordinary verification can't pass.
// The connection only ever goes to the configured LAN address.
const agent = new https.Agent({ rejectUnauthorized: false, keepAlive: true, maxSockets: 2 });

export class HueError extends Error {
  constructor(message, status = 503) {
    super(message);
    this.status = status;
  }
}

function get(resource) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host: BRIDGE.split(':')[0],
        port: Number(BRIDGE.split(':')[1]) || 443,
        path: `/clip/v2/resource/${resource}`,
        method: 'GET',
        agent,
        headers: { 'hue-application-key': APP_KEY, Accept: 'application/json' },
        timeout: TIMEOUT_MS,
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => {
          if (res.statusCode === 401 || res.statusCode === 403) {
            return reject(new HueError('Hue Bridge rejected the app key (HUE_APP_KEY)'));
          }
          if (res.statusCode !== 200) {
            return reject(new HueError(`Hue Bridge answered HTTP ${res.statusCode}`));
          }
          try {
            resolve(JSON.parse(body).data ?? []);
          } catch {
            reject(new HueError('Hue Bridge sent a response that is not JSON'));
          }
        });
      },
    );
    req.on('timeout', () => req.destroy(new HueError('Hue Bridge did not answer in time')));
    req.on('error', (err) =>
      reject(err instanceof HueError ? err : new HueError(`Can't reach the Hue Bridge: ${err.code ?? err.message}`)),
    );
    req.end();
  });
}

const slug = (name) =>
  name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40) || 'room';

const round = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : null);

/** Shape the bridge's resources into one entry per Hue room. Exported for testing. */
export function shapeLights(lights, rooms, connectivity) {
  // Zigbee status hangs off the device, as does room membership.
  const reachableByDevice = new Map(
    connectivity.map((z) => [z.owner?.rid, z.status === 'connected']),
  );
  const roomByDevice = new Map();
  for (const room of rooms) {
    for (const child of room.children ?? []) {
      if (child.rtype === 'device') roomByDevice.set(child.rid, room);
    }
  }

  const groups = new Map();
  const taken = new Set();
  const groupFor = (room) => {
    const key = room?.id ?? 'other';
    if (!groups.has(key)) {
      const label = room?.metadata?.name?.trim() || 'Other lights';
      let id = `lights:${slug(label)}`;
      // Two Hue rooms can share a name; the id must not.
      for (let n = 2; taken.has(id); n += 1) id = `lights:${slug(label)}_${n}`;
      taken.add(id);
      groups.set(key, { id, label, kind: 'lights', lights: [] });
    }
    return groups.get(key);
  };

  for (const light of lights) {
    const device = light.owner?.rid;
    // A bulb switched off at the wall drops off Zigbee; it is neither on nor off.
    const reachable = reachableByDevice.get(device) ?? true;
    groupFor(roomByDevice.get(device)).lights.push({
      name: light.metadata?.name?.trim() || 'Light',
      on: reachable ? Boolean(light.on?.on) : null,
      brightness: reachable && light.on?.on ? round(light.dimming?.brightness) : null,
      reachable,
    });
  }

  return [...groups.values()]
    .map((g) => {
      g.lights.sort((a, b) => a.name.localeCompare(b.name));
      const lit = g.lights.filter((l) => l.on);
      const levels = lit.map((l) => l.brightness).filter((b) => b != null);
      return {
        ...g,
        total: g.lights.length,
        onCount: lit.length,
        unreachable: g.lights.filter((l) => !l.reachable).length,
        // Average brightness of the lights that are on, as the Hue app shows it.
        brightness: levels.length ? Math.round(levels.reduce((a, b) => a + b, 0) / levels.length) : null,
      };
    })
    .sort((a, b) => (a.id === 'lights:other_lights') - (b.id === 'lights:other_lights') || a.label.localeCompare(b.label));
}

export async function fetchLights() {
  if (!hueEnabled) return { enabled: false, rooms: [] };
  const [lights, rooms, connectivity] = await Promise.all([
    get('light'),
    get('room'),
    get('zigbee_connectivity'),
  ]);
  return { enabled: true, rooms: shapeLights(lights, rooms, connectivity) };
}
