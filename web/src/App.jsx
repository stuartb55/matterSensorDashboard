import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { registerSlots } from './palette.js';
import { getFloorplan, getGas, getHistory, getLatest, getLights, getDaily, getSensors, getWeather } from './api.js';
import { fmtAge, fmtDuration, fmtHum, fmtTemp } from './format.js';
import SensorCard from './components/SensorCard.jsx';
import DoorCard from './components/DoorCard.jsx';
import PowerCard from './components/PowerCard.jsx';
import LightCard from './components/LightCard.jsx';
import CompareChart from './components/CompareChart.jsx';
import OutsideChart from './components/OutsideChart.jsx';
import GasPanel from './components/GasPanel.jsx';
import DetailSheet from './components/DetailSheet.jsx';
import DoorSheet from './components/DoorSheet.jsx';
import LightSheet from './components/LightSheet.jsx';
import FloorPlan from './components/FloorPlan.jsx';

const LATEST_POLL_MS = 30_000;
const HISTORY_POLL_MS = 120_000;
// Smart meter gas readings arrive once a day; the server caches them for an hour.
const GAS_POLL_MS = 30 * 60_000;
const DAILY_TTL_MS = 10 * 60_000;

/**
 * One line per feed that has gone quiet as a whole, so an upstream outage
 * reads as one problem with one place to look, not a page of stale cards.
 */
function FeedNotice({ feeds }) {
  const down = feeds.filter((f) => f.down);
  if (!down.length) return null;
  return (
    <div className="notice error" role="status">
      <span className="dot bad" aria-hidden="true" />
      <span>
        {down.map((f) => (
          <span className="feed-line" key={f.id}>
            {f.lastSeenSec == null
              ? `No ${f.label} readings in the last 24 hours.`
              : `No ${f.label} readings for ${fmtDuration(f.lastSeenSec)}.`}{' '}
            <span className="muted">
              Every {f.label} sensor went quiet together, so check whatever collects their readings
              and writes them to the database, not the sensors.
            </span>
          </span>
        ))}
      </span>
    </div>
  );
}

const pad2 = (n) => String(n).padStart(2, '0');
const todayKey = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
};

/** Epoch seconds at the end of a local YYYY-MM-DD day (midnight after it). */
function dayEnd(day) {
  if (!day) return null;
  const [y, m, d] = day.split('-').map(Number);
  return Math.floor(new Date(y, m - 1, d + 1).getTime() / 1000);
}

function fmtDayLabel(day) {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString([], { day: 'numeric', month: 'short' });
}

/** Warmest and coolest room right now, among those reporting. */
function RoomsSummary({ rooms }) {
  const live = rooms.filter((r) => !r.stale && r.tempC != null);
  if (live.length < 2) return null;
  const sorted = [...live].sort((a, b) => b.tempC - a.tempC);
  const warm = sorted[0];
  const cool = sorted.at(-1);
  return (
    <p className="rooms-summary">
      Warmest {warm.label} {fmtTemp(warm.tempC)}°, coolest {cool.label} {fmtTemp(cool.tempC)}°, a
      spread of {(warm.tempC - cool.tempC).toFixed(1)}°.
    </p>
  );
}

function OfflineNote({ count }) {
  if (!count) return null;
  return (
    <span className="card-note">
      <span className="dot bad" aria-hidden="true" />
      {count} offline
    </span>
  );
}

/** `?wall` in the address turns the page into a wall display, so a tablet can bookmark it. */
const isWallUrl = () => new URLSearchParams(window.location.search).has('wall');

function setWallUrl(on) {
  const url = new URL(window.location.href);
  if (on) url.searchParams.set('wall', '');
  else url.searchParams.delete('wall');
  window.history.replaceState(null, '', url.toString().replace('wall=', 'wall'));
}

/**
 * Keep the screen on while the wall display is showing. The browser drops the
 * lock whenever the page is hidden, so it is asked for again on return.
 */
function useWakeLock(active) {
  useEffect(() => {
    if (!active || !('wakeLock' in navigator)) return undefined;
    let lock = null;
    let cancelled = false;
    const acquire = async () => {
      try {
        lock = await navigator.wakeLock.request('screen');
      } catch {
        /* refused (battery saver, say): the screen just sleeps as usual */
      }
    };
    const onVisibility = () => {
      if (!document.hidden && !cancelled) acquire();
    };
    acquire();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisibility);
      lock?.release().catch(() => {});
    };
  }, [active]);
}

/** A large clock for the wall display, ticking on the minute. */
function Clock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    let timer;
    const tick = () => {
      setNow(new Date());
      timer = setTimeout(tick, 60_000 - (Date.now() % 60_000) + 50);
    };
    timer = setTimeout(tick, 60_000 - (Date.now() % 60_000) + 50);
    return () => clearTimeout(timer);
  }, []);
  return (
    <p className="wall-clock">
      <time dateTime={now.toISOString()}>
        {now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
      </time>
      <span>{now.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' })}</span>
    </p>
  );
}

// A wall display runs for weeks; reloading twice a day picks up new builds.
const WALL_RELOAD_MS = 12 * 3600_000;

export default function App() {
  const [wall, setWall] = useState(isWallUrl);
  useWakeLock(wall);
  useEffect(() => {
    setWallUrl(wall);
    document.documentElement.classList.toggle('is-wall', wall);
    if (!wall) return undefined;
    const timer = setTimeout(() => window.location.reload(), WALL_RELOAD_MS);
    return () => clearTimeout(timer);
  }, [wall]);

  const [range, setRange] = useState('24h');
  // Range presets come from the server, the only place they are defined.
  const [ranges, setRanges] = useState([]);
  const [readings, setReadings] = useState(null);
  // Per-source health: which upstream feeds have gone quiet as a whole.
  const [feeds, setFeeds] = useState([]);
  // Thirty-one days of hourly buckets for calendar-day views, fetched when a
  // detail sheet opens and reused for ten minutes.
  const [daily, setDaily] = useState(null);
  const dailyAt = useRef(0);
  // Outdoor reference, or null when no location is configured.
  const [weather, setWeather] = useState(null);
  // Heating gas from the smart meter, or null when Octopus isn't set up.
  const [gas, setGas] = useState(null);
  const [history, setHistory] = useState(null);
  const [error, setError] = useState(null);
  const [refetching, setRefetching] = useState(false);
  const [selected, setSelected] = useState(null);
  const [plan, setPlan] = useState(null);
  // Hue rooms, or null until the bridge first answers (or when it isn't set up).
  const [lights, setLights] = useState(null);
  const [lightsError, setLightsError] = useState(null);
  // True once the server has said the bridge is configured but not answering.
  // Lets the section appear with a notice even before any lights have loaded.
  const [lightsDown, setLightsDown] = useState(false);
  // Whether the server records light history, so light cards can open it.
  const [lightsHistory, setLightsHistory] = useState(false);

  // Keyed by range so a stale in-flight response can't overwrite a newer one.
  // A past day to look at instead of "now": the window then ends at the close
  // of that local day. Null means live.
  const [day, setDay] = useState(null);
  const end = useMemo(() => dayEnd(day), [day]);

  const historyRange = useRef(range);
  historyRange.current = range;
  const historyEnd = useRef(end);
  historyEnd.current = end;

  // Lights ride along with the latest readings but fail on their own: a bridge
  // that is down must not make the sensor database look unreachable.
  const loadLights = useCallback(async (signal) => {
    try {
      const data = await getLights(signal);
      setLights(data.enabled ? data.rooms : null);
      setLightsHistory(Boolean(data.enabled && data.history));
      setLightsError(null);
      setLightsDown(false);
    } catch (err) {
      if (err.name === 'AbortError') return;
      setLightsError(err.message);
      // Only the server's own "bridge unavailable" answer means Hue is set up.
      // A network failure says nothing about Hue, and the sensor banner
      // already covers it.
      if (err.code === 'hue_unavailable') setLightsDown(true);
    }
  }, []);

  const loadLatest = useCallback(async (signal) => {
    loadLights(signal);
    try {
      const data = await getLatest(signal);
      setReadings(data.readings);
      setFeeds(data.feeds ?? []);
      setError(null);
    } catch (err) {
      if (err.name !== 'AbortError') setError(err.message);
    }
  }, [loadLights]);

  // Weather rides along with history; the server caches it for 15 minutes,
  // and a failure just leaves the outdoor reference out.
  const loadWeather = useCallback(async (signal) => {
    try {
      const data = await getWeather(signal);
      setWeather(data.enabled ? data : null);
    } catch {
      /* outdoor reference is optional */
    }
  }, []);

  const loadHistory = useCallback(async (forRange, signal) => {
    loadWeather(signal);
    try {
      const forEnd = historyEnd.current;
      const data = await getHistory(forRange, null, signal, forEnd);
      // Discard if the user switched range or day while this was in flight.
      if (historyRange.current !== forRange || historyEnd.current !== forEnd) return;
      setHistory(data);
      setError(null);
    } catch (err) {
      if (err.name !== 'AbortError') setError(err.message);
    }
  }, [loadWeather]);

  useEffect(() => {
    const ac = new AbortController();
    getSensors(ac.signal)
      .then((data) => {
        registerSlots(data.sensors);
        setRanges(data.ranges ?? []);
      })
      .catch(() => {});
    return () => ac.abort();
  }, []);

  // The plan only changes when the host's file does, so it is fetched once.
  // Without one the section is simply left out.
  useEffect(() => {
    const ac = new AbortController();
    getFloorplan(ac.signal)
      .then((data) => setPlan(data.floors?.length ? data : null))
      .catch(() => {});
    return () => ac.abort();
  }, []);

  // Initial load and range changes. The previous render is held at reduced
  // opacity while refetching rather than replaced by a skeleton.
  useEffect(() => {
    const ac = new AbortController();
    setRefetching(true);
    Promise.all([loadLatest(ac.signal), loadHistory(range, ac.signal)]).finally(() => {
      if (!ac.signal.aborted) setRefetching(false);
    });
    return () => ac.abort();
  }, [range, end, loadLatest, loadHistory]);

  // Polling, paused while the tab is hidden so a backgrounded phone stops
  // waking its radio every 30 seconds.
  useEffect(() => {
    let latestTimer;
    let historyTimer;
    const ac = new AbortController();

    const start = () => {
      stop();
      latestTimer = setInterval(() => loadLatest(ac.signal), LATEST_POLL_MS);
      // A past window never changes, so only a live one is polled.
      historyTimer = setInterval(() => {
        if (historyEnd.current == null) loadHistory(historyRange.current, ac.signal);
      }, HISTORY_POLL_MS);
    };
    const stop = () => {
      clearInterval(latestTimer);
      clearInterval(historyTimer);
    };

    const onVisibility = () => {
      if (document.hidden) {
        stop();
      } else {
        // Catch up immediately on return, then resume the schedule.
        loadLatest(ac.signal);
        if (historyEnd.current == null) loadHistory(historyRange.current, ac.signal);
        start();
      }
    };

    if (!document.hidden) start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stop();
      ac.abort();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [loadLatest, loadHistory]);

  const loadDaily = useCallback((signal) => {
    if (Date.now() - dailyAt.current < DAILY_TTL_MS) return;
    getDaily(signal)
      .then((data) => {
        dailyAt.current = Date.now();
        setDaily(data);
      })
      .catch(() => {
        /* calendar-day panels are extras; everything works without them */
      });
  }, []);

  useEffect(() => {
    if (!selected) return undefined;
    const ac = new AbortController();
    loadDaily(ac.signal);
    return () => ac.abort();
  }, [selected, loadDaily]);

  // Gas is fetched on its own slow schedule. Its per-degree figure needs the
  // rooms' daily means, so the calendar-day data comes with it.
  useEffect(() => {
    const ac = new AbortController();
    const load = () => {
      if (document.hidden) return;
      getGas(ac.signal)
        .then((data) => {
          setGas(data.enabled ? data : null);
          if (data.enabled) loadDaily(ac.signal);
        })
        .catch(() => {
          /* the gas panel is optional; it just stays out */
        });
    };
    load();
    const timer = setInterval(load, GAS_POLL_MS);
    return () => {
      clearInterval(timer);
      ac.abort();
    };
  }, [loadDaily]);

  const seriesById = useMemo(() => {
    const map = new Map();
    for (const s of history?.series ?? []) map.set(s.id, s);
    return map;
  }, [history]);

  const baseLabel = ranges.find((r) => r.key === range)?.label.toLowerCase() ?? range;
  const rangeLabel = end == null ? baseLabel : `the ${baseLabel} to the end of ${fmtDayLabel(day)}`;
  const rooms = readings?.filter((r) => r.kind === 'room') ?? [];
  const equipment = readings?.filter((r) => r.kind === 'equipment') ?? [];
  const doors = readings?.filter((r) => r.kind === 'door') ?? [];
  const meters = readings?.filter((r) => r.kind === 'power') ?? [];
  const selectedReading = readings?.find((r) => r.id === selected) ?? null;
  // The floor plan places Hue rooms alongside sensors. If the bridge stops
  // answering, its last known state is shown dimmed rather than as current.
  // "lights" is added to the name so a Hue room never reads like the
  // temperature sensor of the same name next to it.
  const lightRooms = (lights ?? []).map((l) => ({
    ...l,
    label: `${l.label} lights`,
    stale: Boolean(lightsError),
    history: lightsHistory,
  }));
  const selectedLight = lightRooms.find((l) => l.id === selected) ?? null;
  const planItems = readings ? [...readings, ...lightRooms] : readings;

  const freshest = readings?.reduce(
    (acc, r) => (r.ageSec != null && (acc == null || r.ageSec < acc) ? r.ageSec : acc),
    null,
  );
  const offline = readings?.filter((r) => r.stale).length ?? 0;
  const roomsOffline = rooms.filter((r) => r.stale).length;
  const equipmentOffline = equipment.filter((r) => r.stale).length;
  const metersOffline = meters.filter((r) => r.stale).length;

  return (
    <div className="app">
      <header className="masthead">
        {wall ? <Clock /> : <h1>Home Climate</h1>}
        <div className="masthead-meta">
          <p className="status">
            <span
              className={`dot${error ? ' bad' : offline ? ' warn' : ''}`}
              aria-hidden="true"
            />
            {error ? 'Connection lost' : readings ? `Updated ${fmtAge(freshest)}` : 'Loading…'}
          </p>
          {weather?.current?.tempC != null && (
            <p className="status outside">
              Outside {fmtTemp(weather.current.tempC)}°
              {weather.current.humidity != null && ` · ${fmtHum(weather.current.humidity)}%`}
            </p>
          )}
        </div>
      </header>

      {error && (
        <div className="notice error" role="status">
          <span>
            {readings
              ? 'Can’t reach the sensor database — showing the last readings received.'
              : 'Can’t reach the sensor database.'}{' '}
            <span style={{ color: 'var(--text-muted)' }}>{error}</span>
          </span>
        </div>
      )}

      {!error && <FeedNotice feeds={feeds} />}

      {/* One filter row, above everything it scopes. The wall display always
          shows the default range, so it has none. */}
      {!wall && (
        <div className="filters" role="group" aria-label="Time range">
          {ranges.map((r) => (
            <button
              key={r.key}
              type="button"
              className="range-btn"
              aria-pressed={range === r.key}
              onClick={() => setRange(r.key)}
            >
              {r.label}
            </button>
          ))}
          <label className={`range-btn date-pick${day ? ' is-set' : ''}`}>
            <span>{day ? `To ${fmtDayLabel(day)}` : 'Pick a day'}</span>
            <input
              type="date"
              aria-label="Show the range ending on this day"
              value={day ?? ''}
              max={todayKey()}
              onChange={(e) => setDay(e.target.value && e.target.value < todayKey() ? e.target.value : null)}
            />
          </label>
          {day && (
            <button type="button" className="range-btn" onClick={() => setDay(null)}>
              Back to now
            </button>
          )}
        </div>
      )}

      {!readings ? (
        <p className="empty">{error ? 'No readings available.' : 'Loading sensors…'}</p>
      ) : (
        <div className={refetching ? 'is-refetching' : undefined}>
          {plan && (
            <>
              <div className="section-head">
                <h2>Floor plan</h2>
                <OfflineNote count={offline} />
              </div>
              <FloorPlan plan={plan} readings={planItems} onOpen={setSelected} readOnly={wall} />
            </>
          )}

          {doors.length > 0 && (
            <>
              <div className="section-head">
                <h2>Doors</h2>
              </div>
              <div className="grid door-grid">
                {doors.map((r) => (
                  <DoorCard key={r.id} reading={r} onOpen={setSelected} />
                ))}
              </div>
            </>
          )}

          {((lights && lights.length > 0) || (lightsError && lightsDown)) && (
            <>
              <div className="section-head">
                <h2>Lights</h2>
                {lightsError && (
                  <span className="card-note">
                    <span className="dot bad" aria-hidden="true" />
                    Hue Bridge unreachable
                  </span>
                )}
              </div>
              {lights?.length > 0 ? (
                <div className={`grid${lightsError ? ' is-stale-group' : ''}`}>
                  {lights.map((room) => (
                    <LightCard
                      key={room.id}
                      room={room}
                      onOpen={lightsHistory && !wall ? setSelected : null}
                    />
                  ))}
                </div>
              ) : (
                <div className="notice error" role="status">
                  <span>
                    No light states yet.{' '}
                    <span style={{ color: 'var(--text-muted)' }}>{lightsError}</span>
                  </span>
                </div>
              )}
            </>
          )}

          <div className="section-head">
            <h2>Rooms</h2>
            <OfflineNote count={roomsOffline} />
          </div>
          <RoomsSummary rooms={rooms} />
          <div className="grid">
            {rooms.map((r) => (
              <SensorCard
                key={r.id}
                reading={r}
                history={seriesById.get(r.id)}
                bucketSec={history?.bucketSec}
                rangeLabel={rangeLabel}
                onOpen={setSelected}
              />
            ))}
          </div>

          {equipment.length > 0 && (
            <>
              <div className="section-head">
                <h2>Equipment</h2>
                <OfflineNote count={equipmentOffline} />
              </div>
              <div className="grid">
                {equipment.map((r) => (
                  <SensorCard
                    key={r.id}
                    reading={r}
                    history={seriesById.get(r.id)}
                    bucketSec={history?.bucketSec}
                    rangeLabel={rangeLabel}
                    onOpen={setSelected}
                  />
                ))}
              </div>
            </>
          )}

          {(meters.length > 0 || (gas && !wall)) && (
            <>
              <div className="section-head">
                <h2>Energy</h2>
                <OfflineNote count={metersOffline} />
              </div>
              {meters.length > 0 && <div className="grid">
                {meters.map((r) => (
                  <PowerCard
                    key={r.id}
                    reading={r}
                    history={seriesById.get(r.id)}
                    bucketSec={history?.bucketSec}
                    rangeLabel={rangeLabel}
                    onOpen={setSelected}
                  />
                ))}
              </div>}
              {gas && !wall && <GasPanel gas={gas} daily={daily} weather={weather} />}
            </>
          )}

          {history && !wall && (
            <>
              <div className="section-head">
                <h2>Trends</h2>
              </div>
              <CompareChart
                t={history.t}
                series={history.series}
                bucketSec={history.bucketSec}
                range={range}
                rangeLabel={rangeLabel}
              />
              <OutsideChart
                t={history.t}
                series={history.series}
                bucketSec={history.bucketSec}
                weather={weather}
                range={range}
                rangeLabel={rangeLabel}
              />
            </>
          )}
        </div>
      )}

      <footer className="app-foot">
        <button
          type="button"
          className="link-btn"
          onClick={() => {
            // The wall display shows the live default range.
            if (!wall) {
              setRange('24h');
              setDay(null);
            }
            setWall(!wall);
          }}
        >
          {wall ? 'Leave wall display' : 'Wall display'}
        </button>
      </footer>

      {selectedReading?.kind === 'door' && (
        <DoorSheet
          reading={selectedReading}
          range={range}
          end={end}
          rangeLabel={rangeLabel}
          onClose={() => setSelected(null)}
        />
      )}

      {selectedLight && lightsHistory && (
        <LightSheet
          room={selectedLight}
          range={range}
          end={end}
          rangeLabel={rangeLabel}
          onClose={() => setSelected(null)}
        />
      )}

      {selectedReading && selectedReading.kind !== 'door' && (
        <DetailSheet
          reading={selectedReading}
          series={seriesById.get(selectedReading.id)}
          t={history?.t ?? []}
          bucketSec={history?.bucketSec}
          range={range}
          rangeLabel={rangeLabel}
          daily={daily}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}
