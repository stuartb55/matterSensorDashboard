/**
 * Trend shape for a stat tile. Deliberately plain SVG rather than a full chart:
 * it carries no axes, no hover, and no identity — the tile's own label says
 * which sensor this is, so the sparkline only has to show the shape.
 */
export default function Sparkline({ values, color, width = 300, height = 34 }) {
  const points = [];
  let min = Infinity;
  let max = -Infinity;
  for (const v of values) {
    if (v == null) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (min === Infinity) return <svg className="card-spark" aria-hidden="true" />;

  // Flat series would divide by zero; give them a centred line instead.
  const span = max - min || 1;
  const pad = 3;
  const usable = height - pad * 2;
  const step = values.length > 1 ? width / (values.length - 1) : 0;

  let run = [];
  for (let i = 0; i < values.length; i += 1) {
    const v = values[i];
    if (v == null) {
      // Break the path so a gap in the data reads as a gap, not a straight line.
      if (run.length) points.push(run);
      run = [];
      continue;
    }
    const x = i * step;
    const y = pad + usable - ((v - min) / span) * usable;
    run.push(`${x.toFixed(1)},${y.toFixed(1)}`);
  }
  if (run.length) points.push(run);

  const last = values.reduce(
    (acc, v, i) => (v == null ? acc : { v, i }),
    null,
  );

  return (
    <svg
      className="card-spark"
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      width="100%"
      height={height}
      aria-hidden="true"
      focusable="false"
    >
      {points.map((run_, i) => (
        <polyline
          key={i}
          points={run_.join(' ')}
          fill="none"
          stroke={color}
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
      ))}
      {last && (
        <circle
          cx={last.i * step}
          cy={pad + usable - ((last.v - min) / span) * usable}
          r="2.5"
          fill={color}
          vectorEffect="non-scaling-stroke"
        />
      )}
    </svg>
  );
}
