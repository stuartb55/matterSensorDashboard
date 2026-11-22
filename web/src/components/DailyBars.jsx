import { useState } from 'react';

/**
 * One bar per day, values from zero. Partial days (the first day of the
 * window, and today) are drawn as an outline so they don't read as a low day.
 * `bars`: [{ key, label, value, partial }]. Hover or focus shows the value;
 * the table view in the parent carries every value as text.
 */
export default function DailyBars({ bars, unit, digits = 1, color, ariaLabel, height = 150 }) {
  const [active, setActive] = useState(null);
  const max = Math.max(0, ...bars.map((b) => b.value ?? 0));
  if (!bars.length || max <= 0) return <p className="empty">No data yet.</p>;

  const w = 1000;
  const top = 8;
  const plotH = 100;
  const slot = w / bars.length;
  const barW = Math.max(slot * 0.7, 2);
  const shown = active == null ? null : bars[active];

  return (
    <div className="daily-bars" role="img" aria-label={ariaLabel}>
      <svg viewBox={`0 0 ${w} ${top + plotH}`} preserveAspectRatio="none" style={{ height }}>
        <line x1="0" x2={w} y1={top + plotH - 0.5} y2={top + plotH - 0.5} className="daily-axis" />
        {bars.map((b, i) => {
          if (b.value == null) return null;
          const h = (b.value / max) * plotH;
          return (
            <rect
              key={b.key}
              x={i * slot + (slot - barW) / 2}
              y={top + plotH - h}
              width={barW}
              height={Math.max(h, 0.5)}
              rx="2"
              className={b.partial ? 'is-partial' : undefined}
              style={b.partial ? { stroke: color } : { fill: color }}
              onPointerEnter={() => setActive(i)}
              onPointerLeave={() => setActive(null)}
            />
          );
        })}
      </svg>
      <div className="daily-bars-foot">
        <span>{bars[0].label}</span>
        <span className="daily-bars-readout" aria-live="polite">
          {shown
            ? `${shown.label}: ${shown.value == null ? '—' : shown.value.toFixed(digits)}${unit}${shown.partial ? ' (part day)' : ''}`
            : `Peak ${max.toFixed(digits)}${unit}`}
        </span>
        <span>{bars.at(-1).label}</span>
      </div>
    </div>
  );
}
