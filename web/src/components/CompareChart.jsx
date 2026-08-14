import { useMemo, useState } from 'react';
import TimeChart from './TimeChart.jsx';
import TableView from './TableView.jsx';
import { seriesColor } from '../palette.js';
import { bridgeGaps } from '../format.js';

/**
 * All rooms on one temperature scale.
 *
 * Exactly eight rooms map onto the eight fixed categorical slots, so no hue is
 * ever cycled or generated. Hot Water is excluded — a tank sitting near 47°C on
 * a shared axis flattens every room curve into a straight line.
 *
 * Eight lines converge too much for direct end-labels, so identity comes from
 * the legend and the tooltip, with the table view as the non-visual equivalent.
 */
export default function CompareChart({ t, series, bucketSec, range, rangeLabel }) {
  const [showTable, setShowTable] = useState(false);

  const rooms = useMemo(() => {
    const styles = getComputedStyle(document.documentElement);
    return series
      .filter((s) => s.kind === 'room')
      .map((s) => ({
        label: s.label,
        color: seriesColor(s.id, styles),
        values: bridgeGaps(s.temp, bucketSec, s.bridgeSec),
        raw: s.temp,
      }));
  }, [series, bucketSec]);

  if (!rooms.length) return null;

  return (
    <section className="panel">
      <h3 className="panel-title">Rooms compared</h3>
      <p className="panel-sub">Temperature across every room over {rangeLabel}.</p>

      <TimeChart
        t={t}
        range={range}
        unit="°C"
        height={230}
        series={rooms}
        ariaLabel={`Temperature for all rooms over ${rangeLabel}`}
      />

      {/* Legend is always present for two or more series — identity is never
          carried by colour alone. */}
      <ul className="legend">
        {rooms.map((r) => (
          <li className="legend-item" key={r.label}>
            <span className="legend-key" style={{ background: r.color }} aria-hidden="true" />
            {r.label}
          </li>
        ))}
      </ul>

      <button
        type="button"
        className="link-btn"
        onClick={() => setShowTable((v) => !v)}
        aria-expanded={showTable}
      >
        {showTable ? 'Hide table' : 'View as table'}
      </button>
      {/* The table lists the raw series, never the bridged copy — no
          interpolated value is ever presented as a reading. */}
      {showTable && (
        <TableView
          t={t}
          range={range}
          caption={`Room temperatures over ${rangeLabel}`}
          columns={rooms.map((r) => ({ label: r.label, values: r.raw }))}
        />
      )}
    </section>
  );
}
