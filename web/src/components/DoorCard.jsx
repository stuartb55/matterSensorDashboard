import { fmtAge } from '../format.js';

/** Current contact state for an event-driven door sensor. */
export default function DoorCard({ reading }) {
  const { label, closed, stateTs } = reading;
  const state = closed == null ? 'Unknown' : closed ? 'Closed' : 'Open';
  const changedAge = stateTs == null ? 'no recorded change' : fmtAge(Math.max(0, Math.round((Date.now() - stateTs) / 1000)));

  return (
    <article
      className="door-card"
      aria-label={`${label}: ${state}. Last changed ${changedAge}.`}
    >
      <div className="card-top">
        <p className="card-label">{label}</p>
      </div>
      <div className={`door-state${closed == null ? ' is-unknown' : closed ? ' is-closed' : ' is-open'}`}>
        <span className="door-indicator" aria-hidden="true" />
        {state}
      </div>
      <p className="door-sub">Last changed {changedAge}</p>
    </article>
  );
}
