import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getHistory, getLatest, RANGES } from './api.js';
import { fmtAge } from './format.js';
import SensorCard from './components/SensorCard.jsx';
import DoorCard from './components/DoorCard.jsx';
import CompareChart from './components/CompareChart.jsx';
import DetailSheet from './components/DetailSheet.jsx';

const LATEST_POLL_MS = 30_000;
const HISTORY_POLL_MS = 120_000;

function OfflineNote({ count }) {
  if (!count) return null;
  return (
    <span className="card-note">
      <span className="dot bad" aria-hidden="true" />
      {count} offline
    </span>
  );
}

export default function App() {
  const [range, setRange] = useState('24h');
  const [readings, setReadings] = useState(null);
  const [history, setHistory] = useState(null);
  const [error, setError] = useState(null);
  const [refetching, setRefetching] = useState(false);
  const [selected, setSelected] = useState(null);

  // Keyed by range so a stale in-flight response can't overwrite a newer one.
  const historyRange = useRef(range);
  historyRange.current = range;

  const loadLatest = useCallback(async (signal) => {
    try {
      const data = await getLatest(signal);
      setReadings(data.readings);
      setError(null);
    } catch (err) {
      if (err.name !== 'AbortError') setError(err.message);
    }
  }, []);

  const loadHistory = useCallback(async (forRange, signal) => {
    try {
      const data = await getHistory(forRange, null, signal);
      // Discard if the user switched range while this was in flight.
      if (historyRange.current !== forRange) return;
      setHistory(data);
      setError(null);
    } catch (err) {
      if (err.name !== 'AbortError') setError(err.message);
    }
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
  }, [range, loadLatest, loadHistory]);

  // Polling, paused while the tab is hidden so a backgrounded phone stops
  // waking its radio every 30 seconds.
  useEffect(() => {
    let latestTimer;
    let historyTimer;
    const ac = new AbortController();

    const start = () => {
      stop();
      latestTimer = setInterval(() => loadLatest(ac.signal), LATEST_POLL_MS);
      historyTimer = setInterval(
        () => loadHistory(historyRange.current, ac.signal),
        HISTORY_POLL_MS,
      );
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
        loadHistory(historyRange.current, ac.signal);
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

  const seriesById = useMemo(() => {
    const map = new Map();
    for (const s of history?.series ?? []) map.set(s.id, s);
    return map;
  }, [history]);

  const rangeLabel = RANGES.find((r) => r.key === range)?.label.toLowerCase() ?? range;
  const rooms = readings?.filter((r) => r.kind === 'room') ?? [];
  const equipment = readings?.filter((r) => r.kind === 'equipment') ?? [];
  const doors = readings?.filter((r) => r.kind === 'door') ?? [];
  const selectedReading = readings?.find((r) => r.id === selected) ?? null;

  const freshest = readings?.reduce(
    (acc, r) => (r.ageSec != null && (acc == null || r.ageSec < acc) ? r.ageSec : acc),
    null,
  );
  const offline = readings?.filter((r) => r.stale).length ?? 0;
  const roomsOffline = rooms.filter((r) => r.stale).length;
  const equipmentOffline = equipment.filter((r) => r.stale).length;

  return (
    <div className="app">
      <header className="masthead">
        <h1>Home Climate</h1>
        <p className="status">
          <span
            className={`dot${error ? ' bad' : offline ? ' warn' : ''}`}
            aria-hidden="true"
          />
          {error ? 'Connection lost' : readings ? `Updated ${fmtAge(freshest)}` : 'Loading…'}
        </p>
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

      {/* One filter row, above everything it scopes. */}
      <div className="filters" role="group" aria-label="Time range">
        {RANGES.map((r) => (
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
      </div>

      {!readings ? (
        <p className="empty">{error ? 'No readings available.' : 'Loading sensors…'}</p>
      ) : (
        <div className={refetching ? 'is-refetching' : undefined}>
          {doors.length > 0 && (
            <>
              <div className="section-head">
                <h2>Doors</h2>
              </div>
              <div className="grid door-grid">
                {doors.map((r) => (
                  <DoorCard key={r.id} reading={r} />
                ))}
              </div>
            </>
          )}

          <div className="section-head">
            <h2>Rooms</h2>
            <OfflineNote count={roomsOffline} />
          </div>
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

          {history && (
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
            </>
          )}
        </div>
      )}

      {selectedReading && (
        <DetailSheet
          reading={selectedReading}
          series={seriesById.get(selectedReading.id)}
          t={history?.t ?? []}
          bucketSec={history?.bucketSec}
          range={range}
          rangeLabel={rangeLabel}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}
