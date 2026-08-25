// ============================================================
// CUSTOM NAME POOLS
//
// A player's own names for their ships, captains, stations and cities.
// Supplied in the lobby; drawn from before the shipped lists.
//
// ONE MODULE, because four generators live in four places — ship names
// on the client, captain names in the worker, settlement names split
// across both — and "what counts as a valid name, and how do we pick
// one that is not taken" must mean the same thing in all of them. The
// worker imports the parse/validate half; only the client needs the
// picker.
// ============================================================

export const NAME_KINDS = ['ship', 'captain', 'station', 'city'];

/** Matches the server's per-name cap, and the rename endpoints'. */
export const NAME_MAX_LEN = 32;
/** Per kind. Generous — a player pasting a novel's worth of names is
 *  not a threat, but an unbounded column written from a text box is. */
export const POOL_MAX = 500;

export const EMPTY_POOLS = { ship: [], captain: [], station: [], city: [] };

/**
 * Clean one user-supplied list.
 *
 * Trims, collapses inner whitespace, drops blanks, caps length, and
 * de-duplicates CASE-INSENSITIVELY while keeping the first spelling —
 * a pasted list is usually somebody's notes, and "Endeavour" twice is
 * a typo rather than a request for two ships with one name.
 */
export function sanitizeNames(input) {
  const raw = Array.isArray(input) ? input : [];
  const seen = new Set();
  const out = [];
  for (const v of raw) {
    if (typeof v !== 'string') continue;
    const name = v.trim().replace(/\s+/g, ' ').slice(0, NAME_MAX_LEN);
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
    if (out.length >= POOL_MAX) break;
  }
  return out;
}

/** Split a pasted blob or uploaded file into candidate names. Newlines
 *  AND commas, because people paste both and neither is wrong. */
export function parseNameList(text) {
  return sanitizeNames(text.split(/[\r\n,]+/));
}

/** Parse whatever is in the DB column into a complete, valid shape. */
export function parseNamePools(json) {
  if (!json) return { ...EMPTY_POOLS };
  try {
    const o = JSON.parse(json);
    const out = { ...EMPTY_POOLS };
    for (const k of NAME_KINDS) out[k] = sanitizeNames(o?.[k]);
    return out;
  } catch {
    return { ...EMPTY_POOLS };
  }
}

export function serializeNamePools(pools) {
  const out = {};
  for (const k of NAME_KINDS) out[k] = sanitizeNames(pools[k]);
  return JSON.stringify(out);
}

/**
 * Take the first pool name not already in use, or null.
 *
 * IN ORDER, not at random. A player who typed a list typed it in an
 * order, and handing out "Endeavour" then "Resolute" respects that;
 * shuffling would make a deliberate list feel like a slot machine.
 *
 * Null means "nothing left" — the caller falls back to the shipped
 * generator rather than reusing a name or refusing to build. Running
 * out is normal, not an error.
 */
export function pickFromPool(pool, taken) {
  if (!pool || pool.length === 0) return null;
  const used = new Set();
  for (const t of taken) used.add(String(t).trim().toLowerCase());
  for (const name of pool) {
    if (!used.has(name.trim().toLowerCase())) return name;
  }
  return null;
}

/** Two pools hold the same names in the same order. */
export function poolsEqual(a, b) {
  for (const k of NAME_KINDS) {
    const x = (a && a[k]) || [];
    const y = (b && b[k]) || [];
    if (x.length !== y.length) return false;
    for (let i = 0; i < x.length; i += 1) if (x[i] !== y[i]) return false;
  }
  return true;
}

/**
 * What an open editor should show when a fresh server snapshot lands.
 *
 * THE RULE: the draft is the player's if it has drifted from the
 * snapshot we last synced to; otherwise it is just a stale copy of the
 * server and the new one replaces it.
 *
 * The obvious version -- "adopt unless the editor is dirty" -- is what
 * shipped, and it was wrong in the one case that matters. Dirty is
 * measured against the CURRENT server value, so the very snapshot that
 * carries the names makes the editor dirty in the same breath, and the
 * adopt never fires. A player who saved 249 names reloaded to four
 * empty tabs, each flagged unsaved. Comparing against the PREVIOUS
 * snapshot separates "the player typed something" from "the server
 * told us something new", which is the distinction the rule needs.
 */
export function adoptServerPools(draft, prevServer, nextServer) {
  return poolsEqual(draft, prevServer) ? nextServer : draft;
}
