/** What a Hue room's lights add up to, in a few words. Shared with the floor plan. */
export function lightsSummary(room) {
  const { total, onCount, unreachable, brightness } = room;
  if (total === 0) return { value: 'No lights', spoken: 'no lights', state: 'off' };
  if (unreachable === total) return { value: 'Unreachable', spoken: 'unreachable', state: 'unknown' };
  if (onCount === 0) return { value: 'Off', spoken: 'all off', state: 'off' };
  const level = brightness != null ? ` · ${brightness}%` : '';
  const spokenLevel = brightness != null ? ` at ${brightness} percent` : '';
  if (onCount === total) {
    return { value: `On${level}`, spoken: `all on${spokenLevel}`, state: 'on' };
  }
  return {
    value: `${onCount}/${total} on${level}`,
    spoken: `${onCount} of ${total} on${spokenLevel}`,
    state: 'on',
  };
}

function lightState(l) {
  if (!l.reachable) return { text: 'Unreachable', cls: 'is-unknown' };
  if (!l.on) return { text: 'Off', cls: 'is-off' };
  return { text: l.brightness != null ? `${l.brightness}%` : 'On', cls: 'is-on' };
}

/** Current state of the Hue lights in one room. View-only. */
export default function LightCard({ room }) {
  const { label, lights, onCount, total, unreachable } = room;
  const summary = lightsSummary(room);
  const headline = summary.state === 'unknown' ? 'Unreachable' : onCount === 0 ? 'Off' : onCount === total ? 'On' : `${onCount} of ${total} on`;

  return (
    <article className="door-card light-card" aria-label={`${label} lights: ${summary.spoken}.`}>
      <div className="card-top">
        <p className="card-label">{label}</p>
        {unreachable > 0 && unreachable < total && (
          <span className="card-note">{unreachable} unreachable</span>
        )}
      </div>
      <div className={`door-state is-${summary.state}`}>
        <span className="light-indicator" aria-hidden="true" />
        {headline}
      </div>
      <ul className="light-list">
        {lights.map((l, i) => {
          const s = lightState(l);
          return (
            <li key={`${l.name}-${i}`} className={s.cls}>
              <span className="light-indicator" aria-hidden="true" />
              <span className="light-name">{l.name}</span>
              <span className="light-level">{s.text}</span>
            </li>
          );
        })}
      </ul>
    </article>
  );
}
