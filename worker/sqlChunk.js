// ============================================================================
// sqlChunk.js — one place that knows D1 will not take an unbounded IN list.
//
// THE BUG THIS EXISTS FOR. `WHERE id IN (${ids.map(() => '?').join(',')})`
// reads as obviously correct and is, right up until a player selects more
// ships than D1 will bind. Noah formed a fleet from 147 hulls and got
//
//     D1_ERROR: too many SQL variables at offset 318: SQLITE_ERROR
//
// straight back in the UI. **D1 caps a query at 100 bound parameters.** Not
// SQLite's 999 — the platform's own, lower ceiling, and nothing in the query
// hints at it. Every bulk endpoint in the game had the same shape, so the
// whole "select a lot of ships and do something" surface failed together
// once a fleet grew past about a hundred: form a fleet, set a stance, set
// targeting priority, add members, remove members, detach, rejoin.
//
// It is worse in the TICK than in an endpoint. A failed button is a visible
// error a player can retry; a failed statement inside resolveTick throws
// where nobody is looking, and takes the turn down for every faction in the
// game, not just the one with the big fleet.
//
// USE: pass how many NON-id parameters the statement binds, so the chunk
// leaves room for them. Getting that number wrong is the one way to
// reintroduce the bug, which is why it is a required argument rather than
// something with a default that is usually right.
// ============================================================================

/** D1's ceiling on bound parameters per query. Documented by Cloudflare,
 *  and lower than SQLite's own 999 — assuming the bigger number is what
 *  put 147 ship ids into one statement. */
export const D1_MAX_BOUND_PARAMS = 100;

/** `?,?,?` for n values. */
export function marks(n) {
  return new Array(n).fill('?').join(',');
}

/**
 * Split ids into runs that fit under the ceiling alongside `fixedParams`
 * other bindings. Never returns an empty chunk, and returns [] for no ids
 * so callers can `if (!chunks.length) return` without a special case.
 */
export function chunkIds(ids, fixedParams) {
  const per = Math.max(1, D1_MAX_BOUND_PARAMS - fixedParams);
  const out = [];
  for (let i = 0; i < ids.length; i += per) out.push(ids.slice(i, i + per));
  return out;
}

/**
 * Run a SELECT ... IN (...) across as many statements as it takes and
 * concatenate the rows. `run(chunk, marks)` builds and executes one.
 *
 * Sequential on purpose: these run inside request handlers and the tick,
 * and firing forty statements at D1 at once to save a few milliseconds is
 * how a big fleet turns into a rate-limit instead of an error.
 */
export async function selectInChunks(ids, fixedParams, run) {
  const rows = [];
  for (const chunk of chunkIds(ids, fixedParams)) {
    const res = await run(chunk, marks(chunk.length));
    rows.push(...(res?.results ?? []));
  }
  return rows;
}

/**
 * Build one statement per chunk, for db.batch(). The cap is per STATEMENT,
 * so a batch of several bounded statements is fine — it is a single
 * statement carrying 148 bindings that D1 refuses.
 */
export function statementsInChunks(ids, fixedParams, build) {
  return chunkIds(ids, fixedParams).map(chunk => build(chunk, marks(chunk.length)));
}

/** Build the statements and run them as one batch. No-ops on no ids. */
export async function runInChunks(db, ids, fixedParams, build) {
  const stmts = statementsInChunks(ids, fixedParams, build);
  if (stmts.length) await db.batch(stmts);
}
