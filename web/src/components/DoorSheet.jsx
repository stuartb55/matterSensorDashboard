import { useEffect, useMemo, useState } from 'react';
import Sheet, { CloseButton } from './Sheet.jsx';
import { getDoorEvents } from '../api.js';
import { doorSummary, openSpells } from '../doors.js';
import { fmtAge, fmtDuration, fmtTick, fmtTime } from '../format.js';

const LIST_LIMIT = 30;

/**
 * Open spells as blocks along the window. Status colour marks the open state
 * (it is state, not a series), and the summary and list below carry the same
 * facts as text.
 */
function Timeline({ spells, startMs, endMs, unknownUntil, range }) {
  const span = endMs - startMs;
  const x = (ms) => ((ms - startMs) / span) * 1000;
  const ticks = [0, 0.5, 1].map((f) => startMs + f * span);
  return (
    <div className="door-timeline">
      <svg viewBox="0 0 1000 28" preserveAspectRatio="none" aria-hidden="true">
        <rect x="0" y="0" width="1000" height="28" rx="4" className="door-timeline-closed" />
        {unknownUntil != null && (
          <rect x="0" y="0" width={x(unknownUntil)} height="28" className="door-timeline-unknown" />
        )}
        {spells.map((s) => (
          <rect
            key={s.from}
            x={x(s.from)}
            y="0"
            // A spell of a few seconds still gets a visible sliver.
            width={Math.max(x(s.to) - x(s.from), 2)}
            height="28"
            className="door-timeline-open"
          />
        ))}
      </svg>
      <div className="door-timeline-axis">
        {ticks.map((ms) => (
          <span key={ms}>{fmtTick(ms / 1000, range)}</span>
        ))}
      </div>
    </div>
  );
}

/** When each door opened and closed over the selected range. */
export default function DoorSheet({ reading, range, rangeLabel, onClose }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    const ac = new AbortController();
    setError(null);
    getDoorEvents(range, ac.signal)
      .then((d) => setData(d))
      .catch((err) => {
        if (err.name !== 'AbortError') setError(err.message);
      });
    return () => ac.abort();
  }, [range]);

  const door = data?.doors.find((d) => d.id === reading.id);
  const startMs = (data?.start ?? 0) * 1000;
  const endMs = (data?.end ?? 0) * 1000;

  const spells = useMemo(
    () => (door ? openSpells(door.initial, door.events, startMs, endMs) : []),
    [door, startMs, endMs],
  );
  const summary = doorSummary(spells);
  const state = reading.closed == null ? 'Unknown' : reading.closed ? 'Closed' : 'Open';
  const changedSec =
    reading.stateTs == null ? null : Math.max(0, Math.round((Date.now() - reading.stateTs) / 1000));

  // Newest first, each opening paired with how long it lasted.
  const items = useMemo(() => {
    const spellByOpen = new Map(spells.map((s) => [s.from, s]));
    return (door?.events ?? [])
      .map((e) => ({ ...e, spell: e.closed ? null : spellByOpen.get(e.ts) }))
      .reverse();
  }, [door, spells]);
  const shown = showAll ? items : items.slice(0, LIST_LIMIT);

  return (
    <Sheet label={`${reading.label} history`} onClose={onClose}>
      <div className="sheet-head">
        <div>
          <h2>{reading.label}</h2>
          <div className="sheet-now">
            <span className="hero">{state}</span>
            <span>{changedSec == null ? 'no recorded change' : `changed ${fmtAge(changedSec)}`}</span>
          </div>
        </div>
        <CloseButton onClose={onClose} />
      </div>

      {error ? (
        <div className="notice error" role="status">
          <span>Can’t load the door history. <span className="muted">{error}</span></span>
        </div>
      ) : !door ? (
        <p className="empty">Loading…</p>
      ) : (
        <div className="stack">
          <section className="panel">
            <h3 className="panel-title">Open over {rangeLabel}</h3>
            <p className="panel-sub">
              Each block is a time the door stood open.
              {door.initial == null && door.events.length > 0 && ' The state before the first change is unknown.'}
            </p>
            <Timeline
              spells={spells}
              startMs={startMs}
              endMs={endMs}
              range={range}
              unknownUntil={door.initial == null ? (door.events[0]?.ts ?? endMs) : null}
            />
            <dl className="stats">
              <div className="stat">
                <dt>Opened</dt>
                <dd>{summary.opens}×</dd>
              </div>
              <div className="stat">
                <dt>Open for</dt>
                <dd>{fmtDuration(summary.openSec)}</dd>
              </div>
              <div className="stat">
                <dt>Longest</dt>
                <dd>{spells.length ? fmtDuration(summary.longestSec) : '—'}</dd>
              </div>
            </dl>
          </section>

          <section className="panel">
            <h3 className="panel-title">Changes</h3>
            {items.length === 0 ? (
              <p className="empty">No changes over {rangeLabel}.</p>
            ) : (
              <ol className="event-list">
                {shown.map((e) => (
                  <li key={`${e.ts}-${e.closed}`}>
                    <span className={`door-indicator ${e.closed ? 'is-closed' : 'is-open'}`} aria-hidden="true" />
                    <span className="event-what">{e.closed ? 'Closed' : 'Opened'}</span>
                    <time className="event-when" dateTime={new Date(e.ts).toISOString()}>
                      {/* Times alone on short ranges; a day as well once it could be ambiguous. */}
                      {fmtTime(e.ts / 1000, range === '1h' || range === '6h' ? range : '7d')}
                    </time>
                    <span className="event-note">
                      {e.spell
                        ? e.spell.ongoing
                          ? 'still open'
                          : `open ${fmtDuration((e.spell.to - e.spell.from) / 1000)}`
                        : ''}
                    </span>
                  </li>
                ))}
              </ol>
            )}
            {items.length > LIST_LIMIT && (
              <button type="button" className="link-btn" onClick={() => setShowAll((v) => !v)}>
                {showAll ? 'Show fewer' : `Show all ${items.length}`}
              </button>
            )}
          </section>
        </div>
      )}
    </Sheet>
  );
}
