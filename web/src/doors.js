/**
 * Open spells for one door across a window, from the state in force when the
 * window opened (`initial`, null if unknown) and the changes inside it.
 * Times are epoch milliseconds. An open spell still running at `endMs` is
 * marked `ongoing`; one already open at `startMs` is clipped to it and
 * marked `fromStart`, since its real start is outside the window.
 */
export function openSpells(initial, events, startMs, endMs) {
  const spells = [];
  let openedAt = initial === false ? startMs : null;
  let fromStart = initial === false;
  for (const e of events) {
    if (!e.closed && openedAt == null) {
      openedAt = e.ts;
      fromStart = false;
    } else if (e.closed && openedAt != null) {
      spells.push({ from: openedAt, to: e.ts, fromStart, ongoing: false });
      openedAt = null;
    }
  }
  if (openedAt != null) spells.push({ from: openedAt, to: endMs, fromStart, ongoing: true });
  return spells;
}

/** Times opened, total time open and the longest spell, in seconds. */
export function doorSummary(spells) {
  let totalMs = 0;
  let longestMs = 0;
  let opens = 0;
  for (const s of spells) {
    const ms = s.to - s.from;
    totalMs += ms;
    if (ms > longestMs) longestMs = ms;
    if (!s.fromStart) opens += 1;
  }
  return { opens, openSec: totalMs / 1000, longestSec: longestMs / 1000 };
}
