import { useState } from 'react';

/**
 * Each day's low-to-high span as a whisker with its midpoint marked, on one
 * shared scale. `days`: [{ key, label, min, max }] with numbers or null.
 */
export default function DailyRange({ days, unit, color, ariaLabel, height = 160 }) {
  const [active, setActive] = useState(null);
  const vals = days.flatMap((d) => [d.min, d.max]).filter((v) => v != null);
  if (!vals.length) return <p className="empty">No data yet.</p>;
  let lo = Math.min(...vals);
  let hi = Math.max(...vals);
  const pad = Math.max((hi - lo) * 0.08, 0.5);
  lo -= pad;
  hi += pad;

  const w = 1000;
  const h = 100;
  const slot = w / days.length;
  const y = (v) => h - ((v - lo) / (hi - lo)) * h;
  const shown = active == null ? null : days[active];
  // At the edges and middle of the plot, so the labels beside it line up.
  const ticks = [lo, (lo + hi) / 2, hi];

  return (
    <div className="daily-bars daily-range" role="img" aria-label={ariaLabel}>
      <div className="daily-range-plot">
        <div className="daily-range-ticks" aria-hidden="true">
          {[...ticks].reverse().map((v) => (
            <span key={v}>{v.toFixed(0)}</span>
          ))}
        </div>
        <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style={{ height }}>
          {ticks.map((v) => (
            <line key={v} x1="0" x2={w} y1={y(v)} y2={y(v)} className="daily-grid" />
          ))}
          {days.map((d, i) => {
            if (d.min == null || d.max == null) return null;
            const x = i * slot + slot / 2;
            return (
              <g
                key={d.key}
                onPointerEnter={() => setActive(i)}
                onPointerLeave={() => setActive(null)}
              >
                <rect x={i * slot} y="0" width={slot} height={h} fill="transparent" />
                <line
                  x1={x}
                  x2={x}
                  y1={y(d.max)}
                  y2={y(d.min)}
                  stroke={color}
                  strokeWidth={Math.max(Math.min(slot * 0.45, 10), 3)}
                  strokeLinecap="round"
                  vectorEffect="non-scaling-stroke"
                  opacity={active == null || active === i ? 1 : 0.45}
                />
              </g>
            );
          })}
        </svg>
      </div>
      <div className="daily-bars-foot">
        <span>{days[0].label}</span>
        <span className="daily-bars-readout" aria-live="polite">
          {shown && shown.min != null
            ? `${shown.label}: ${shown.min.toFixed(1)}–${shown.max.toFixed(1)}${unit}`
            : 'Low to high each day'}
        </span>
        <span>{days.at(-1).label}</span>
      </div>
    </div>
  );
}
