// ============================================================
// gatePairing — one partner, both ways, no orphans.
//
//   npm run sim:gatepairing
//
// The cardinality IS the design. A gate network is a topology you plan,
// not a teleport-anywhere button, and the whole strategic weight of that
// comes from the constraint holding under re-wiring.
//
// Three ways a naive implementation breaks it, all of which produce a
// board that looks fine and plays wrong:
//
//   A ONE-SIDED LINK. Set A.partner = B and forget B.partner = A, and A
//   is a gate that swallows ships and cannot send them back.
//
//   AN ORPHAN. Re-wire A (previously paired to C) to B, and C is left
//   pointing at a gate that now points somewhere else. C's owner sees a
//   link on their card and finds ships arriving from it that they cannot
//   answer.
//
//   A HUB. Allow A→B and A→C and the one-partner rule is gone, along
//   with the reason anyone has to think about where gates go.
//
// This models the same batch of updates handlePairGate issues, so the
// rules are asserted rather than the SQL transcribed.
// ============================================================

let bad = 0;
const check = (label, cond, detail = '') => {
  if (cond) { console.log(`PASS  ${label}`); return; }
  bad += 1;
  console.log(`FAIL  ${label}`);
  if (detail) console.log(`        ${detail}`);
};

/** The gate table, as rows. */
function board(ids) {
  const m = new Map();
  for (const id of ids) m.set(id, { id, partner: null });
  return m;
}

/** Mirrors handlePairGate: drop both ends' old links, then wire the new
 *  pair in both directions. */
function pair(gates, aId, bId) {
  const a = gates.get(aId);
  const b = gates.get(bId);
  const orphans = [a.partner, b.partner].filter(id => id && id !== aId && id !== bId);
  for (const id of orphans) gates.get(id).partner = null;
  a.partner = bId;
  b.partner = aId;
  return orphans;
}

/** Mirrors the unlink branch: clear both ends. */
function unpair(gates, aId) {
  const a = gates.get(aId);
  if (a.partner) gates.get(a.partner).partner = null;
  a.partner = null;
}

/** Every invariant the design depends on, checked at once. */
function violations(gates) {
  const out = [];
  for (const g of gates.values()) {
    if (!g.partner) continue;
    const p = gates.get(g.partner);
    if (!p) { out.push(`${g.id} points at a gate that does not exist`); continue; }
    if (p.partner !== g.id) {
      out.push(`${g.id} -> ${p.id}, but ${p.id} -> ${p.partner ?? 'nothing'}`);
    }
  }
  // A hub would show up as two gates naming the same partner.
  const counts = new Map();
  for (const g of gates.values()) {
    if (!g.partner) continue;
    counts.set(g.partner, (counts.get(g.partner) ?? 0) + 1);
  }
  for (const [id, n] of counts) {
    if (n > 1) out.push(`${id} is named as partner by ${n} gates`);
  }
  return out;
}

// ---- a fresh pair is symmetric ---------------------------------------
{
  const g = board(['a', 'b']);
  pair(g, 'a', 'b');
  check('pairing wires BOTH ends',
    g.get('a').partner === 'b' && g.get('b').partner === 'a',
    `a->${g.get('a').partner}, b->${g.get('b').partner}`);
  check('...and leaves no violations', violations(g).length === 0, violations(g).join(' | '));
}

// ---- re-wiring cleans up after itself --------------------------------
{
  const g = board(['a', 'b', 'c']);
  pair(g, 'a', 'c');
  const orphans = pair(g, 'a', 'b');
  check('re-wiring reports what it unlinked',
    orphans.length === 1 && orphans[0] === 'c', JSON.stringify(orphans));
  check('the orphan is actually cleared, not just reported',
    g.get('c').partner === null, `c->${g.get('c').partner}`);
  check('the new pair is symmetric',
    g.get('a').partner === 'b' && g.get('b').partner === 'a');
  check('no gate is left pointing at a gate that points elsewhere',
    violations(g).length === 0, violations(g).join(' | '));
}

// ---- re-wiring TWO already-paired gates to each other -----------------
{
  // The nastiest case: a-c and b-d both exist, then a is wired to b.
  // Both c and d must be freed, and neither may keep a stale link.
  const g = board(['a', 'b', 'c', 'd']);
  pair(g, 'a', 'c');
  pair(g, 'b', 'd');
  const orphans = pair(g, 'a', 'b');
  check('wiring two paired gates together frees BOTH far ends',
    orphans.length === 2 && orphans.includes('c') && orphans.includes('d'),
    JSON.stringify(orphans));
  check('...and both are genuinely unlinked',
    g.get('c').partner === null && g.get('d').partner === null,
    `c->${g.get('c').partner}, d->${g.get('d').partner}`);
  check('...leaving exactly one pair standing',
    violations(g).length === 0, violations(g).join(' | '));
}

// ---- unlinking clears both ends --------------------------------------
{
  const g = board(['a', 'b']);
  pair(g, 'a', 'b');
  unpair(g, 'a');
  check('cutting a link clears the FAR end too',
    g.get('a').partner === null && g.get('b').partner === null,
    `a->${g.get('a').partner}, b->${g.get('b').partner}`);
  check('...so no gate swallows ships with nowhere to send them',
    violations(g).length === 0);
}

// ---- re-pairing the same two is a no-op, not a self-orphan ------------
{
  const g = board(['a', 'b']);
  pair(g, 'a', 'b');
  const orphans = pair(g, 'a', 'b');
  check('re-pairing the same two gates orphans nothing',
    orphans.length === 0, JSON.stringify(orphans));
  check('...and they stay paired',
    g.get('a').partner === 'b' && g.get('b').partner === 'a',
    `a->${g.get('a').partner}, b->${g.get('b').partner}`);
}

// ---- a long sequence of re-wires never accumulates damage -------------
{
  const ids = ['a', 'b', 'c', 'd', 'e', 'f'];
  const g = board(ids);
  // Deterministic churn — no RNG, so a failure is reproducible.
  const seq = [
    ['a', 'b'], ['c', 'd'], ['a', 'c'], ['b', 'e'], ['d', 'f'],
    ['a', 'f'], ['b', 'c'], ['e', 'd'], ['a', 'b'], ['c', 'f'],
  ];
  let worst = [];
  for (const [x, y] of seq) {
    pair(g, x, y);
    const v = violations(g);
    if (v.length > worst.length) worst = v;
  }
  check('ten re-wires leave the table consistent', worst.length === 0, worst.join(' | '));
  const paired = [...g.values()].filter(x => x.partner).length;
  check('...with an even number of gates paired',
    paired % 2 === 0, `${paired} gates hold a link`);
}

console.log(bad === 0 ? '\nALL PASS' : `\n${bad} FAILURE(S)`);
process.exit(bad === 0 ? 0 : 1);
