// Colour follows the entity, never its rank: a room keeps the same hue
// everywhere it appears, and filtering the chart never repaints the survivors.
//
// The eight categorical slots are assigned in the fixed validated order. There
// are exactly eight rooms, so no slot is ever cycled or generated. Hot Water is
// equipment on its own scale and never shares a plot with the rooms, so it
// takes slot 1 without any risk of collision.
const SLOT_BY_ID = {
  living_room: 1,
  bedroom: 2,
  office: 3,
  ruuvi_air: 4,
  bathroom: 5,
  kitchen: 6,
  hallway: 7,
  closet: 8,
  hot_water: 1,
};

/** Resolve a sensor's series colour to a concrete hex for canvas drawing. */
export function seriesColor(id, styles) {
  const slot = SLOT_BY_ID[id] ?? 1;
  return styles.getPropertyValue(`--series-${slot}`).trim() || '#2a78d6';
}

export const seriesVar = (id) => `var(--series-${SLOT_BY_ID[id] ?? 1})`;

/**
 * Canvas `fillStyle` parsing is narrower than CSS — `color-mix()` and friends
 * are not dependable there — so band fills are built as explicit rgba.
 */
export function withAlpha(color, alpha) {
  const hex = color.trim();
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const h = m[1].length === 3 ? m[1].replace(/./g, (c) => c + c) : m[1];
  const n = parseInt(h, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

export function readTheme() {
  const s = getComputedStyle(document.documentElement);
  const v = (name, fallback) => s.getPropertyValue(name).trim() || fallback;
  return {
    styles: s,
    surface: v('--surface-1', '#fcfcfb'),
    grid: v('--gridline', '#e1e0d9'),
    axis: v('--axis', '#c3c2b7'),
    muted: v('--text-muted', '#898781'),
    text: v('--text-primary', '#0b0b0b'),
  };
}
