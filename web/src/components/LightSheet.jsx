import { useEffect, useMemo, useState } from 'react';
import Sheet, { CloseButton } from './Sheet.jsx';
import TimeChart from './TimeChart.jsx';
import TableView from './TableView.jsx';
import { getLightHistory } from '../api.js';
import { readTheme } from '../palette.js';
import { bridgeGaps, fmtDuration, fmtTime } from '../format.js';
import { firstRecorded, lightTotals } from '../lights.js';
import { lightsSummary } from './LightCard.jsx';

const pct = (v) => (v == null ? null : Math.round(v * 1000) / 10);

/**
 * When a Hue room's lights were on over the selected range, from the states
 * the server records each minute. A room is "on" while any of its lights is.
 * The line is not a room series, so it uses neutral ink rather than a
 * categorical slot; the stats and the table carry the same facts as text.
 */
export default function LightSheet({ room, range, end = null, rangeLabel, onClose }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [showTable, setShowTable] = useState(false);

  useEffect(() => {
    const ac = new AbortController();
    setError(null);
    getLightHistory(range, ac.signal, end)
      .then((d) => setData(d))
      .catch((err) => {
        if (err.name !== 'AbortError') setError(err.message);
      });
    return () => ac.abort();
  }, [range, end]);

  const recorded = data?.rooms?.find((r) => r.id === room.id) ?? null;
  const totals = lightTotals(recorded, data?.bucketSec ?? 0);
  const shareValues = useMemo(() => recorded?.share.map(pct) ?? [], [recorded]);
  const chartSeries = useMemo(() => {
    if (!recorded) return [];
    return [
      {
        label: 'On',
        color: readTheme().text,
        values: bridgeGaps(shareValues, data.bucketSec, data.bridgeSec),
      },
    ];
  }, [recorded, shareValues, data]);

  const start = recorded ? firstRecorded(recorded.share) : -1;
  const startedLate = start > 0;
  const now = lightsSummary(room);

  return (
    <Sheet label={`${room.label} history`} onClose={onClose}>
      <div className="sheet-head">
        <div>
          <h2>{room.label}</h2>
          <div className="sheet-now">
            <span className="hero">{now.value}</span>
            <span>now</span>
          </div>
        </div>
        <CloseButton onClose={onClose} />
      </div>

      {error ? (
        <div className="notice error" role="status">
          <span>Can’t load the light history. <span className="muted">{error}</span></span>
        </div>
      ) : !data ? (
        <p className="empty">Loading…</p>
      ) : !data.enabled ? (
        <p className="empty">Light history isn’t recorded on this server.</p>
      ) : !recorded || start === -1 ? (
        <p className="empty">Nothing recorded for these lights over {rangeLabel} yet.</p>
      ) : (
        <div className="stack">
          <section className="panel">
            <h3 className="panel-title">On over {rangeLabel}</h3>
            <p className="panel-sub">
              Share of each interval with any light in the room on.
              {startedLate && ` Recording starts ${fmtTime(data.t[start], range)}.`}
            </p>
            <TimeChart
              t={data.t}
              range={range}
              unit="%"
              height={160}
              series={chartSeries}
              ariaLabel={`Share of time ${room.label} were on over ${rangeLabel}`}
            />
            <dl className="stats">
              <div className="stat">
                <dt>On for</dt>
                <dd>{fmtDuration(totals.onSec)}</dd>
              </div>
              <div className="stat">
                <dt>Of the time</dt>
                <dd>{totals.share == null ? '—' : `${Math.round(totals.share * 100)}%`}</dd>
              </div>
              <div className="stat">
                <dt>Most on at once</dt>
                <dd>{totals.mostLit == null ? '—' : `${totals.mostLit} of ${room.total}`}</dd>
              </div>
            </dl>
            <button
              type="button"
              className="link-btn"
              onClick={() => setShowTable((v) => !v)}
              aria-expanded={showTable}
            >
              {showTable ? 'Hide table' : 'View as table'}
            </button>
            {showTable && (
              <TableView
                t={data.t}
                range={range}
                caption={`${room.label} on over ${rangeLabel}`}
                columns={[
                  { label: 'On %', values: shareValues },
                  { label: 'Lights on (avg)', values: recorded.lit.map((v) => (v == null ? null : Math.round(v * 10) / 10)) },
                  { label: 'Most on', values: recorded.litMax },
                ]}
              />
            )}
          </section>
        </div>
      )}
    </Sheet>
  );
}
