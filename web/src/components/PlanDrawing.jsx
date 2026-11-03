// Draws one floor from its layout: rooms, then stairs and low walls, then the openings cut
// into the walls. Every colour is a theme token (overridable per room), so the
// plan follows light and dark mode like the rest of the dashboard.

const rectPoints = ([x, y, w, h]) => [
  [x, y],
  [x + w, y],
  [x + w, y + h],
  [x, y + h],
];

export const roomPoints = (room) => room.points ?? rectPoints(room.rect);

/** Label goes where the layout says, else the centre of the room's bounds. */
function labelAt(room, pts) {
  if (room.label) return room.label;
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2];
}

function Stairs({ rect: [x, y, w, h], steps, along }) {
  const treads = [];
  for (let i = 1; i < steps; i += 1) {
    treads.push(
      along === 'x' ? (
        <line key={i} x1={x + (w * i) / steps} y1={y} x2={x + (w * i) / steps} y2={y + h} />
      ) : (
        <line key={i} x1={x} y1={y + (h * i) / steps} x2={x + w} y2={y + (h * i) / steps} />
      ),
    );
  }
  return (
    <g className="plan-stairs">
      <rect x={x} y={y} width={w} height={h} />
      {treads}
    </g>
  );
}

export default function PlanDrawing({ floor, unit: sharedUnit }) {
  // Wall thickness and type size scale with the drawing, so a layout in
  // centimetres and one in pixels both read the same. The parent passes one
  // unit for every floor so walls and labels match between them. The view box is exactly
  // the floor, so marker positions map straight onto it; leave a margin round
  // the outside walls in the layout itself.
  const unit = sharedUnit ?? floor.width / 100;
  const wall = unit * 0.9;

  return (
    <svg
      className="plan-svg"
      viewBox={`0 0 ${floor.width} ${floor.height}`}
      role="img"
      aria-label={`${floor.label}: ${floor.rooms.map((r) => r.name).filter(Boolean).join(', ')}`}
    >
      <g className="plan-rooms" strokeWidth={wall} strokeLinejoin="miter">
        {floor.rooms.map((room, i) => (
          <polygon
            key={i}
            points={roomPoints(room).join(' ')}
            style={room.fill ? { fill: room.fill } : undefined}
          />
        ))}
      </g>

      <g strokeWidth={unit * 0.15}>
        {floor.stairs.map((s, i) => (
          <Stairs key={i} {...s} />
        ))}
      </g>

      <g className="plan-barriers" strokeWidth={wall * 0.45} strokeLinecap="square">
        {(floor.barriers ?? []).map(({ from, to }, i) => (
          <line key={i} x1={from[0]} y1={from[1]} x2={to[0]} y2={to[1]} />
        ))}
      </g>

      {/* Openings are drawn over the wall: a door is a gap, a window a pane. */}
      <g className="plan-doors" strokeWidth={wall * 1.15} strokeLinecap="butt">
        {floor.doors.map(({ from, to }, i) => (
          <line key={i} x1={from[0]} y1={from[1]} x2={to[0]} y2={to[1]} />
        ))}
      </g>
      <g className="plan-windows" strokeLinecap="butt">
        {floor.windows.map(({ from, to }, i) => (
          <g key={i}>
            <line className="pane" x1={from[0]} y1={from[1]} x2={to[0]} y2={to[1]} strokeWidth={wall * 0.75} />
            <line className="glass" x1={from[0]} y1={from[1]} x2={to[0]} y2={to[1]} strokeWidth={wall * 0.2} />
          </g>
        ))}
      </g>

      <g className="plan-labels" fontSize={unit * 2.4}>
        {floor.rooms.map((room, i) => {
          if (!room.name) return null;
          const [x, y] = labelAt(room, roomPoints(room));
          return (
            <text
              key={i}
              x={x}
              y={y}
              textAnchor="middle"
              dominantBaseline="central"
              fontSize={room.labelSize ? unit * 2.4 * room.labelSize : undefined}
            >
              {room.name}
            </text>
          );
        })}
      </g>
    </svg>
  );
}
