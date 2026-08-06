// One canonical color per resource. These match the top-bar pills
// (TopBar.css .resource-pill--*) and the Overview panel's prod-rate
// classes — the two places the palette already agreed — so every other
// surface that prints an F/M/C/S now pulls from here instead of
// inventing its own tint (or none).
//
//   fuel     amber   — the old fuel pill / fuel bars
//   metal    grey    — raw ore
//   credits  gold    — money looks like money
//   science  mint    — the research green
export const RESOURCE_COLORS = {
  fuel: '#ffb84d',
  metal: '#a0a0a0',
  credits: '#ffd700',
  science: '#6ee7b7',
} as const;

export type ResourceKey = keyof typeof RESOURCE_COLORS;

/** The compact-chip shorthand (F0 · M15 · C16 · S4) keyed by letter. */
export const RESOURCE_LETTER_COLORS: Record<'F' | 'M' | 'C' | 'S', string> = {
  F: RESOURCE_COLORS.fuel,
  M: RESOURCE_COLORS.metal,
  C: RESOURCE_COLORS.credits,
  S: RESOURCE_COLORS.science,
};
