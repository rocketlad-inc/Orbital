// ============================================================
// Which side of its target a rammed asteroid hit (room.js
// resolveAsteroidImpacts writes it on the impact's chronicle rows; the
// client lands the flash and the fire there: src/render/asteroidRam.ts).
// Its own module so the client's tests can hold it to its contract
// without loading the whole Room.
// ============================================================

/** The side of its target a rammed rock came in on, for its chronicle
 *  rows: the unit vector (world axes) from the meeting point back toward
 *  where it was launched, `{ from_dx, from_dy }`, or `{}` when the plan's
 *  columns are missing. The client prefers the side it watched the rock
 *  come in on (src/render/asteroidRam.ts); this is for one that did not. */
export function ramImpactFrom(row) {
  const sx = Number(row?.ram_start_pos_x), sy = Number(row?.ram_start_pos_y);
  const ix = Number(row?.ram_intercept_pos_x), iy = Number(row?.ram_intercept_pos_y);
  if (![sx, sy, ix, iy].every(Number.isFinite)) return {};
  const dx = sx - ix, dy = sy - iy;
  const d = Math.hypot(dx, dy);
  if (!(d > 1e-9)) return {};
  return { from_dx: Math.round((dx / d) * 1e4) / 1e4, from_dy: Math.round((dy / d) * 1e4) / 1e4 };
}
