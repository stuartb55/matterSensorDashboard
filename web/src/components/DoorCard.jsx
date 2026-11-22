import { fmtAge } from '../format.js';

/** Current contact state for an event-driven door sensor; opens its history. */
export default function DoorCard({ reading, onOpen }) {
  const { id, label, closed, stateTs } = reading;
  const state = closed == null ? 'Unknown' : closed ? 'Closed' : 'Open';
  const changedAge = stateTs == null ? 'no recorded change' : fmtAge(Math.max(0, Math.round((Date.now() - stateTs) / 1000)));

  return (
    <button
      type="button"
      className="door-card"
      onClick={() => onOpen(id)}
      aria-label={`${label}: ${state}. Last changed ${changedAge}. Open history.`}
    >
      <div className="card-top">
        <p className="card-label">{label}</p>
      </div>
      <div className={`door-state${closed == null ? ' is-unknown' : closed ? ' is-closed' : ' is-open'}`}>
        <span className="door-indicator" aria-hidden="true" />
        {state}
      </div>
      <p className="door-sub">Last changed {changedAge}</p>
    </button>
  );
}
