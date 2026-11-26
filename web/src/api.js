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

export const getHistory = (range, ids, signal, end = null) => {
  const params = new URLSearchParams({ range });
  if (ids?.length) params.set('sensors', ids.join(','));
  if (end != null) params.set('end', String(end));
  return getJson(`/api/history?${params}`, signal);
};

export const getFloorplan = (signal) => getJson('/api/floorplan', signal);

export const getLights = (signal) => getJson('/api/lights', signal);

export const getDoorEvents = (range, signal, end = null) =>
  getJson(
    `/api/doors/events?${new URLSearchParams(end == null ? { range } : { range, end: String(end) })}`,
    signal,
  );

export const getWeather = (signal) => getJson('/api/weather', signal);

export const getDaily = (signal) => getJson('/api/daily', signal);

export const getGas = (signal) => getJson('/api/gas', signal);

export const getLightHistory = (range, signal, end = null) =>
  getJson(
    `/api/lights/history?${new URLSearchParams(end == null ? { range } : { range, end: String(end) })}`,
    signal,
  );
