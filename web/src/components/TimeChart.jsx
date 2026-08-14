import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import { readTheme, withAlpha } from '../palette.js';
import { axisValues, fmtTick, fmtTime } from '../format.js';

/**
 * Line chart over a shared time axis.
 *
 * One measure per chart — never two y-scales on one plot. Series arrive with
 * nulls padding the parts of the axis they have no data for, which uPlot draws
 * as gaps rather than dropping the line to zero.
 *
 * `band` optionally supplies the min/max envelope behind a single series, so a
 * downsampled average doesn't hide the real swing inside each bucket.
 */
export default function TimeChart({
  t,
  series,
  range,
  unit,
  height = 200,
  band = null,
  ariaLabel,
}) {
  const hostRef = useRef(null);
  const plotRef = useRef(null);
  const [width, setWidth] = useState(0);
  const [hover, setHover] = useState(null);

  // Track container width; uPlot needs explicit pixel dimensions.
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const ro = new ResizeObserver(([entry]) => {
      setWidth(Math.floor(entry.contentRect.width));
    });
    ro.observe(host);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (!hostRef.current || !width || !t.length) return;
    const theme = readTheme();

    const axisFont = '11px system-ui, -apple-system, sans-serif';
    const axisBase = {
      stroke: theme.muted,
      font: axisFont,
      grid: { stroke: theme.grid, width: 1 }, // hairline, solid — never dashed
      ticks: { stroke: theme.grid, width: 1, size: 4 },
      border: { stroke: theme.axis, width: 1 },
    };

    const plotSeries = [
      {},
      ...series.map((s) => ({
        label: s.label,
        stroke: s.color,
        width: 2, // 2px line, round join/cap
        points: { show: false },
        spanGaps: false,
      })),
    ];

    const data = [t, ...series.map((s) => s.values)];
    const bands = [];

    if (band) {
      // Envelope drawn as two invisible bounds with a wash between them.
      plotSeries.push(
        { stroke: 'transparent', width: 0, points: { show: false } },
        { stroke: 'transparent', width: 0, points: { show: false } },
      );
      data.push(band.lo, band.hi);
      const loIdx = plotSeries.length - 2;
      const hiIdx = plotSeries.length - 1;
      // ~14% wash, as an explicit rgba so canvas can parse it.
      bands.push({ series: [hiIdx, loIdx], fill: withAlpha(series[0].color, 0.14) });
    }

    const plot = new uPlot(
      {
        width,
        height,
        legend: { show: false }, // own legend below the plot
        cursor: {
          // Crosshair finds the X: readers aim at a time, not at a 2px line.
          x: true,
          y: false,
          points: { show: false },
          drag: { x: false, y: false, setScale: false },
        },
        scales: { x: { time: true } },
        axes: [
          { ...axisBase, values: (_u, splits) => splits.map((v) => fmtTick(v, range)) },
          { ...axisBase, size: 44, values: (_u, splits) => axisValues(splits) },
        ],
        series: plotSeries,
        bands,
        padding: [10, 10, 0, 2],
        hooks: {
          setCursor: [
            (u) => {
              const { idx, left } = u.cursor;
              if (idx == null || left < 0) {
                setHover(null);
                return;
              }
              setHover({
                idx,
                left: u.valToPos(u.data[0][idx], 'x'),
                rows: series
                  .map((s) => ({ label: s.label, color: s.color, value: s.values[idx] }))
                  .filter((r) => r.value != null),
                time: u.data[0][idx],
              });
            },
          ],
        },
      },
      data,
      hostRef.current,
    );

    plotRef.current = plot;

    // uPlot binds mouse events; touch needs forwarding for the crosshair to
    // track a dragged finger on a phone.
    const over = plot.over;
    const toCursor = (touch) => {
      const rect = over.getBoundingClientRect();
      plot.setCursor({ left: touch.clientX - rect.left, top: touch.clientY - rect.top });
    };
    const onTouch = (e) => {
      if (e.touches[0]) toCursor(e.touches[0]);
    };
    const onTouchEnd = () => setHover(null);
    over.addEventListener('touchstart', onTouch, { passive: true });
    over.addEventListener('touchmove', onTouch, { passive: true });
    over.addEventListener('touchend', onTouchEnd, { passive: true });

    return () => {
      over.removeEventListener('touchstart', onTouch);
      over.removeEventListener('touchmove', onTouch);
      over.removeEventListener('touchend', onTouchEnd);
      plot.destroy();
      plotRef.current = null;
      setHover(null);
    };
  }, [t, series, width, height, range, band]);

  const showTooltip = hover && hover.rows.length > 0;

  return (
    <div className="chart-host" ref={hostRef} role="img" aria-label={ariaLabel}>
      {showTooltip && (
        <div
          className="tooltip"
          style={{
            left: `${Math.min(Math.max(hover.left, 72), Math.max(width - 72, 72))}px`,
            top: `${height - 24}px`,
          }}
        >
          <div className="tooltip-time">{fmtTime(hover.time, range)}</div>
          {hover.rows.map((r) => (
            <div className="tooltip-row" key={r.label}>
              <span className="tooltip-key" style={{ background: r.color }} />
              {/* Labels come from the API — rendered as text, never as markup. */}
              <span className="tooltip-name">{r.label}</span>
              <span className="tooltip-val">
                {r.value.toFixed(1)}
                {unit}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
