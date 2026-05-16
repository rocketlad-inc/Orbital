// ============================================================
// Color Constants and Utilities
// ============================================================

export const COLORS = {
  // Background and UI
  bg: '#0a0e14',
  bgGrid: '#14202c',
  fg: '#d8e4ee',
  fgDim: '#8a9fb3',
  fgFaint: '#3a4a5a',
  panelBg: 'rgba(10, 14, 20, 0.94)',
  panelBorder: '#2a3d50',

  // Orbital elements
  orbitTrajectory: '#2d4255',      // light blue
  orbitProjected: '#ffb84d',        // amber for projected/planned
  orbitCurrent: '#4ecdc4',          // cyan for current orbit

  // Maneuver visualization
  maneuverPlanned: '#ffb84d',       // amber dashed
  maneuverCommitted: '#ffb84d',     // amber solid
  maneuverBurn: '#4ecdc4',          // cyan for current burn
  captureLabel: '#6ee7b7',          // green
  escapeLabel: '#ff5e5e',           // red

  // Trajectory arc segments (KSP-style per-phase coloring)
  arcTransfer: '#ffb84d',           // amber for heliocentric transfer
  arcCapture: '#6ee7b7',            // green for entering target SOI
  arcEscape: '#ff5e5e',             // red for leaving SOI
  arcCoast: '#4ecdc4',              // cyan for coasting/captured orbit
  soiBoundary: '#4ecdc4',           // cyan for SOI circle

  // Velocity vectors
  prograde: '#6ee7b7',              // green (raises apoapsis)
  retrograde: '#fda4af',            // pink (lowers apoapsis)
  radialOut: '#67e8f9',             // cyan (rotates)
  radialIn: '#c4b5fd',              // violet (rotates)

  // Celestial bodies
  star: '#ffd180',                  // yellow for star
  planetDefault: '#a89878',         // tan for terrestrial
  gasGiant: '#d4a574',              // sand for gas giant

  // Faction colors
  playerFriendly: '#ff4444',        // red for player
  enemyHostile: '#888888',          // gray for enemies
  neutral: '#4ecdc4',               // cyan for neutral

  // Status
  success: '#6ee7b7',               // green
  warning: '#ffb84d',               // amber
  danger: '#ff5e5e',                // red
  info: '#4ecdc4',                  // cyan
} as const;

/**
 * Apply opacity to a hex color
 */
export function withOpacity(hexColor: string, opacity: number): string {
  // Convert hex to rgba
  const hex = hexColor.replace('#', '');
  const r = parseInt(hex.substring(0, 2), 16);
  const g = parseInt(hex.substring(2, 4), 16);
  const b = parseInt(hex.substring(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${opacity})`;
}

/**
 * Lighten a hex color by a factor
 */
export function lighten(hexColor: string, factor: number = 1.2): string {
  const hex = hexColor.replace('#', '');
  const r = Math.min(255, Math.floor(parseInt(hex.substring(0, 2), 16) * factor));
  const g = Math.min(255, Math.floor(parseInt(hex.substring(2, 4), 16) * factor));
  const b = Math.min(255, Math.floor(parseInt(hex.substring(4, 6), 16) * factor));
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

/**
 * Darken a hex color by a factor
 */
export function darken(hexColor: string, factor: number = 0.8): string {
  const hex = hexColor.replace('#', '');
  const r = Math.floor(parseInt(hex.substring(0, 2), 16) * factor);
  const g = Math.floor(parseInt(hex.substring(2, 4), 16) * factor);
  const b = Math.floor(parseInt(hex.substring(4, 6), 16) * factor);
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}
