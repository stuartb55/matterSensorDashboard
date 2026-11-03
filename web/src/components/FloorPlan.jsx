import { useEffect, useMemo, useRef, useState } from 'react';
import { seriesVar } from '../palette.js';
import { fmtAge, fmtHum, fmtPower, fmtTemp } from '../format.js';
import PlanDrawing from './PlanDrawing.jsx';

const DRAFT_KEY = 'floorplan-draft';

// The widest floor never draws narrower than this, so sensor cards have room
// on a phone; the plan scrolls sideways instead of squashing them together.
const PLAN_MIN_PX = 640;
const PLAN_MAX_PX = 900;

// Unsaved edits survive a reload. Browser storage can be missing or throw
// (private windows, blocked site data), so every access is guarded.
function readDraft() {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
function writeDraft(value) {
  try {
    if (value) localStorage.setItem(DRAFT_KEY, JSON.stringify(value));
    else localStorage.removeItem(DRAFT_KEY);
  } catch {
    /* storage unavailable: the draft just won't outlive the tab */
  }
}

const markersOf = (floors) => Object.fromEntries(floors.map((f) => [f.id, { ...f.markers }]));

/** What a marker shows: a short value line plus a full sentence for screen readers. */
function describe(r) {
  if (!r) return { value: '—', spoken: 'no data' };
  if (r.kind === 'door') {
    const state = r.closed == null ? 'Unknown' : r.closed ? 'Closed' : 'Open';
    return { value: state, spoken: state };
  }
  if (r.kind === 'power') {
    const p = fmtPower(r.watts);
    return { value: `${p.value} ${p.unit}`, spoken: `${p.value} ${p.unit}` };
  }
  const temp = `${fmtTemp(r.tempC)}°`;
  const hum = r.kind === 'room' && r.humidity != null ? ` · ${fmtHum(r.humidity)}%` : '';
  return {
    value: temp + hum,
    spoken: `${fmtTemp(r.tempC)} degrees${hum ? `, ${fmtHum(r.humidity)} percent humidity` : ''}`,
  };
}

/**
 * Sensors placed on a picture of each floor. Tapping a marker opens the same
 * detail sheet as its card. Edit mode lets markers be dragged into place and
 * exports the result as `floorplan.json` for the host's floorplan folder; the
 * server only ever reads that file, so nothing is saved from the browser.
 */
export default function FloorPlan({ plan, readings, onOpen }) {
  const [floorId, setFloorId] = useState(plan.floors[0]?.id);
  const [editing, setEditing] = useState(false);
  const [placing, setPlacing] = useState(null);
  const [copied, setCopied] = useState(false);
  const [positions, setPositions] = useState(() => readDraft() ?? markersOf(plan.floors));
  const surface = useRef(null);
  const drag = useRef(null);

  const saved = useMemo(() => markersOf(plan.floors), [plan]);
  const dirty = JSON.stringify(positions) !== JSON.stringify(saved);
  useEffect(() => writeDraft(dirty ? positions : null), [positions, dirty]);

  const floor = plan.floors.find((f) => f.id === floorId) ?? plan.floors[0];
  // Every floor is drawn at the same scale: the widest floor fills the panel
  // and the others take their share of it, so a room is the same size on any
  // floor and walls and labels match.
  const widest = Math.max(...plan.floors.map((f) => f.width));
  const share = floor.width / widest;
  const sizing = {
    width: `${share * 100}%`,
    minWidth: `${Math.round(PLAN_MIN_PX * share)}px`,
    maxWidth: `${Math.round(PLAN_MAX_PX * share)}px`,
  };
  const byId = useMemo(() => new Map((readings ?? []).map((r) => [r.id, r])), [readings]);
  const here = positions[floor.id] ?? {};
  const placedAnywhere = new Set(Object.values(positions).flatMap((m) => Object.keys(m)));
  const unplaced = (readings ?? []).filter((r) => !placedAnywhere.has(r.id));

  // Pointer position in the floor's own layout units, clamped onto the floor.
  const pointToPlan = (e) => {
    const rect = surface.current.getBoundingClientRect();
    const fx = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    const fy = Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height));
    return { x: Math.round(fx * floor.width), y: Math.round(fy * floor.height) };
  };

  const move = (id, pos) =>
    setPositions((prev) => {
      const next = {};
      // A sensor sits on one floor only: placing it here lifts it off the others.
      for (const [fid, m] of Object.entries(prev)) {
        const { [id]: _, ...rest } = m;
        next[fid] = rest;
      }
      next[floor.id] = { ...(next[floor.id] ?? {}), [id]: pos };
      return next;
    });

  const remove = (id) =>
    setPositions((prev) => {
      const { [id]: _, ...rest } = prev[floor.id] ?? {};
      return { ...prev, [floor.id]: rest };
    });

  const onSurfaceClick = (e) => {
    if (!editing || !placing) return;
    move(placing, pointToPlan(e));
    setPlacing(null);
  };

  const onMarkerDown = (id) => (e) => {
    if (!editing) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = id;
  };
  const onMarkerMove = (id) => (e) => {
    if (drag.current === id) move(id, pointToPlan(e));
  };
  const onMarkerUp = () => {
    drag.current = null;
  };

  const exportJson = () =>
    JSON.stringify(
      {
        floors: plan.floors.map((f) => ({ ...f, markers: positions[f.id] ?? {} })),
      },
      null,
      2,
    ) + '\n';

  const download = () => {
    const url = URL.createObjectURL(new Blob([exportJson()], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'floorplan.json';
    a.click();
    URL.revokeObjectURL(url);
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(exportJson());
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      download();
    }
  };

  const finishEditing = () => {
    setEditing(false);
    setPlacing(null);
  };

  return (
    <section className="panel floorplan">
      <div className="floorplan-bar">
        {plan.floors.length > 1 ? (
          <div className="filters floor-tabs" role="group" aria-label="Floor">
            {plan.floors.map((f) => (
              <button
                key={f.id}
                type="button"
                className="range-btn"
                aria-pressed={f.id === floor.id}
                onClick={() => setFloorId(f.id)}
              >
                {f.label}
              </button>
            ))}
          </div>
        ) : (
          <p className="panel-title">{floor.label}</p>
        )}
        <button
          type="button"
          className="link-btn"
          aria-pressed={editing}
          onClick={() => (editing ? finishEditing() : setEditing(true))}
        >
          {editing ? 'Done' : 'Edit positions'}
        </button>
      </div>

      {plan.source === 'example' && (
        <p className="panel-sub">
          This is the example plan. Put your own <code>floorplan.json</code> in the server’s{' '}
          <code>floorplan/</code> folder to replace it.
        </p>
      )}

      {editing && (
        <div className="floorplan-edit">
          <p className="panel-sub">
            {placing
              ? `Tap the plan where ${byId.get(placing)?.label ?? placing} is.`
              : 'Drag a sensor to move it. Tap one below, then tap the plan, to add it.'}
          </p>
          {unplaced.length > 0 && (
            <div className="chip-row">
              {unplaced.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  className="chip"
                  aria-pressed={placing === r.id}
                  onClick={() => setPlacing(placing === r.id ? null : r.id)}
                >
                  {r.label}
                </button>
              ))}
            </div>
          )}
          <div className="chip-row">
            <button type="button" className="chip" onClick={copy}>
              {copied ? 'Copied' : 'Copy floorplan.json'}
            </button>
            <button type="button" className="chip" onClick={download}>
              Download
            </button>
            {dirty && (
              <button type="button" className="chip" onClick={() => setPositions(saved)}>
                Discard changes
              </button>
            )}
          </div>
          {dirty && (
            <p className="panel-sub">
              Unsaved: replace <code>floorplan/floorplan.json</code> on the server with the export
              to keep these positions.
            </p>
          )}
        </div>
      )}

      <div className="floorplan-scroll">
        <div
          ref={surface}
          className={`floorplan-surface${editing ? ' is-editing' : ''}${placing ? ' is-placing' : ''}`}
          style={sizing}
          onClick={onSurfaceClick}
        >
          <PlanDrawing floor={floor} unit={widest / 100} />
          {Object.entries(here).map(([id, pos]) => {
            const r = byId.get(id);
            if (!r) return null;
            const { value, spoken } = describe(r);
            const doorClass =
              r.kind === 'door'
                ? r.closed == null
                  ? ' is-unknown'
                  : r.closed
                    ? ' is-closed'
                    : ' is-open'
                : '';
            // The anchor slides across the marker with its position, so a sensor
            // placed against an outside wall stays fully on the plan.
            const fx = pos.x / floor.width;
            const fy = pos.y / floor.height;
            const style = {
              left: `${fx * 100}%`,
              top: `${fy * 100}%`,
              transform: `translate(${-fx * 100}%, ${-fy * 100}%)`,
            };
            const status = r.stale ? `, offline, last seen ${fmtAge(r.ageSec)}` : '';
            const body = (
              <>
                <span className="marker-label">
                  <span
                    className={`marker-key${r.kind === 'door' ? ` door-indicator${doorClass}` : ''}`}
                    style={r.kind === 'door' ? undefined : { background: seriesVar(id) }}
                    aria-hidden="true"
                  />
                  {r.label}
                </span>
                <span className="marker-value">{r.stale ? fmtAge(r.ageSec) : value}</span>
              </>
            );
            const className = `marker${r.stale ? ' is-stale' : ''}${doorClass}`;

            if (editing) {
              return (
                <div
                  key={id}
                  className={`${className} is-draggable`}
                  style={style}
                  onPointerDown={onMarkerDown(id)}
                  onPointerMove={onMarkerMove(id)}
                  onPointerUp={onMarkerUp}
                  onPointerCancel={onMarkerUp}
                  onClick={(e) => e.stopPropagation()}
                >
                  {body}
                  <button
                    type="button"
                    className="marker-remove"
                    aria-label={`Remove ${r.label} from the plan`}
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={() => remove(id)}
                  >
                    ×
                  </button>
                </div>
              );
            }
            // Doors have no history chart, so they have nothing to open.
            if (r.kind === 'door') {
              return (
                <div key={id} className={className} style={style} aria-label={`${r.label}: ${spoken}${status}`}>
                  {body}
                </div>
              );
            }
            return (
              <button
                key={id}
                type="button"
                className={className}
                style={style}
                onClick={() => onOpen(id)}
                aria-label={`${r.label}, ${spoken}${status}. Open detail.`}
              >
                {body}
              </button>
            );
          })}
        </div>
      </div>
    </section>
  );
}
