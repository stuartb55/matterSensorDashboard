async function getJson(path, signal) {
  const res = await fetch(path, { signal, headers: { Accept: 'application/json' } });
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    let code;
    try {
      const body = await res.json();
      if (body?.message) detail = body.message;
      code = body?.error;
    } catch {
      /* non-JSON error body */
    }
    // The server's error code travels with the message, so a caller can tell
    // "this upstream is down" from "the dashboard itself is unreachable".
    throw Object.assign(new Error(detail), { code });
  }
  return res.json();
}

export const getSensors = (signal) => getJson('/api/sensors', signal);

export const getLatest = (signal) => getJson('/api/readings/latest', signal);

export const getHistory = (range, ids, signal) => {
  const params = new URLSearchParams({ range });
  if (ids?.length) params.set('sensors', ids.join(','));
  return getJson(`/api/history?${params}`, signal);
};

export const RANGES = [
  { key: '1h', label: '1H' },
  { key: '6h', label: '6H' },
  { key: '24h', label: '24H' },
  { key: '7d', label: '7D' },
  { key: '30d', label: '30D' },
];

export const getFloorplan = (signal) => getJson('/api/floorplan', signal);

export const getLights = (signal) => getJson('/api/lights', signal);
