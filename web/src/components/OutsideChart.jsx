import { useMemo, useState } from 'react';
import TimeChart from './TimeChart.jsx';
import TableView from './TableView.jsx';
import { readTheme } from '../palette.js';
import { alignHourly, bridgeGaps, meanSeries } from '../format.js';

/**
 * Inside against outside on one temperature scale. Putting the outdoor line on
 * the room comparison would stretch its axis by ten degrees or more and flatten
 * every room curve, so it gets a chart of its own against the average of the
 * rooms. Neither line is a room, so both use neutral ink rather than a
 * categorical slot, and the outdoor one is dashed.
 */
export default function OutsideChart({ t, series, bucketSec, weather, range, rangeLabel }) {
  const [showTable, setShowTable] = useState(false);

  const lines = useMemo(() => {
    if (!weather?.hourly?.t?.length || !t.length) return null;
    const theme = readTheme();
    const rooms = series.filter((s) => s.kind === 'room');
    const inside = meanSeries(rooms.map((s) => s.temp));
    const outside = alignHourly(t, weather.hourly.t, weather.hourly.temp, bucketSec);
    if (!outside.some((v) => v != null)) return null;
    return {
      inside,
      outside,
      series: [
        {
          label: 'Inside',
          color: theme.text,
          // Each room is bridged by its own normal silence before averaging,
          // so a slow Matter sensor doesn't punch holes in the house line.
          values: meanSeries(rooms.map((s) => bridgeGaps(s.temp, bucketSec, s.bridgeSec))),
        },
        {
          label: 'Outside',
          color: theme.muted,
          dash: [6, 4],
          values: bridgeGaps(outside, bucketSec, 3600 + bucketSec),
        },
      ],
    };
  }, [t, series, bucketSec, weather]);

  if (!lines) return null;

  return (
    <section className="panel">
      <h3 className="panel-title">Inside and outside</h3>
      <p className="panel-sub">
        Average of the rooms against the outdoor temperature (hourly, from Open-Meteo) over{' '}
        {rangeLabel}.
      </p>
      <TimeChart
        t={t}
        range={range}
        unit="°C"
        height={200}
        series={lines.series}
        ariaLabel={`Average indoor and outdoor temperature over ${rangeLabel}`}
      />
      <ul className="legend">
        <li className="legend-item">
          <span className="legend-key" style={{ background: lines.series[0].color }} aria-hidden="true" />
          Inside (rooms averaged)
        </li>
        <li className="legend-item">
          <span className="legend-key is-dashed" style={{ color: lines.series[1].color }} aria-hidden="true" />
          Outside (dashed)
        </li>
      </ul>
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
          t={t}
          range={range}
          caption={`Average indoor and outdoor temperature over ${rangeLabel}`}
          columns={[
            { label: 'Inside °C', values: lines.inside },
            { label: 'Outside °C', values: lines.outside },
          ]}
        />
      )}
    </section>
  );
}
