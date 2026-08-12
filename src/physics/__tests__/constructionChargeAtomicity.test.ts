// [pure] A construction charge either lands in full, or takes nothing.
//
// Regression guard for Sean's report (2026-08-12): "the game rejected my
// construction for not having enough resources, but took my resources
// anyway."
//
// Cause: every construction path checked affordability against a SNAPSHOT of
// the faction row read at the top of the request, then debited with an
// unguarded `SET metal = metal - ?`. Two submits — a double tap, a retry, or
// a ship queue racing a building — both passed the same stale check and both
// debited, driving the pool NEGATIVE. The next legitimate build then failed
// its check for real, so the player saw a rejection with the credits already
// gone.
//
// The fix charges local stockpiles then the pool with GUARDED updates and
// unwinds anything that landed if a later one misses, and callers create the
// order only on success. This mirrors chargeConstruction() in
// worker/actions.js — the compensation branch is the part most likely to rot,
// so it is pinned here against a fake DB.

interface Purse { metal: number; gold: number }

/** Minimal stand-in for the D1 surface chargeConstruction uses: guarded
 *  UPDATEs that report how many rows they changed. */
function makeDb(pool: Purse, settlements: Record<string, Purse>) {
  const log: string[] = [];
  return {
    log,
    pool,
    settlements,
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            run() {
              const isSettlement = sql.includes('game_settlements');
              const isCredit = sql.includes('+ ?');
              if (isSettlement) {
                const [m, g, id] = args as [number, number, string];
                const s = settlements[id];
                if (isCredit) {
                  s.metal += m; s.gold += g;
                  log.push(`refund settlement ${id} ${m}/${g}`);
                  return { meta: { changes: 1 } };
                }
                if (!s || s.metal < m || s.gold < g) {
                  log.push(`MISS settlement ${id}`);
                  return { meta: { changes: 0 } };
                }
                s.metal -= m; s.gold -= g;
                log.push(`debit settlement ${id} ${m}/${g}`);
                return { meta: { changes: 1 } };
              }
              const [m, g] = args as [number, number];
              if (isCredit) {
                pool.metal += m; pool.gold += g;
                log.push(`refund pool ${m}/${g}`);
                return { meta: { changes: 1 } };
              }
              if (pool.metal < m || pool.gold < g) {
                log.push('MISS pool');
                return { meta: { changes: 0 } };
              }
              pool.metal -= m; pool.gold -= g;
              log.push(`debit pool ${m}/${g}`);
              return { meta: { changes: 1 } };
            },
          };
        },
      };
    },
  };
}

/** Mirror of worker/actions.js chargeConstruction. */
async function chargeConstruction(
  env: { DB: ReturnType<typeof makeDb> },
  { factionId, drains = [] as Array<{ id: string; metal: number; gold: number }>,
    poolMetal = 0, poolGold = 0 },
): Promise<{ ok: boolean; reason?: string }> {
  const applied: Array<{ kind: 'settlement' | 'pool'; id?: string; metal: number; gold: number }> = [];
  const unwind = async () => {
    for (const d of applied) {
      if (d.kind === 'settlement') {
        await env.DB.prepare(
          'UPDATE game_settlements SET stockpile_metal = stockpile_metal + ?, stockpile_gold = stockpile_gold + ? WHERE id = ?',
        ).bind(d.metal, d.gold, d.id).run();
      } else {
        await env.DB.prepare(
          'UPDATE game_factions SET metal = metal + ?, gold = gold + ? WHERE id = ?',
        ).bind(d.metal, d.gold, factionId).run();
      }
    }
  };
  for (const d of drains) {
    if (d.metal <= 0 && d.gold <= 0) continue;
    const res = await env.DB.prepare(
      'UPDATE game_settlements SET stockpile_metal = stockpile_metal - ?, stockpile_gold = stockpile_gold - ? WHERE id = ? AND stockpile_metal >= ? AND stockpile_gold >= ?',
    ).bind(d.metal, d.gold, d.id, d.metal, d.gold).run();
    if (!res.meta.changes) { await unwind(); return { ok: false, reason: 'insufficient_resources' }; }
    applied.push({ kind: 'settlement', id: d.id, metal: d.metal, gold: d.gold });
  }
  if (poolMetal > 0 || poolGold > 0) {
    const res = await env.DB.prepare(
      'UPDATE game_factions SET metal = metal - ?, gold = gold - ? WHERE id = ? AND metal >= ? AND gold >= ?',
    ).bind(poolMetal, poolGold, factionId, poolMetal, poolGold).run();
    if (!res.meta.changes) { await unwind(); return { ok: false, reason: 'insufficient_resources' }; }
    applied.push({ kind: 'pool', metal: poolMetal, gold: poolGold });
  }
  return { ok: true };
}

const F = 'f0';

describe('[pure] construction charge is all-or-nothing', () => {
  it('charges local first, then the pool remainder', async () => {
    const db = makeDb({ metal: 100, gold: 100 }, { s1: { metal: 40, gold: 20 } });
    const r = await chargeConstruction({ DB: db }, {
      factionId: F, drains: [{ id: 's1', metal: 40, gold: 20 }], poolMetal: 10, poolGold: 5,
    });
    expect(r.ok).toBe(true);
    expect(db.settlements.s1).toEqual({ metal: 0, gold: 0 });
    expect(db.pool).toEqual({ metal: 90, gold: 95 });
  });

  it('THE BUG: a pool shortfall puts the local debit back and takes nothing', async () => {
    // Pool is short (another submit or the tick spent it since the snapshot).
    const db = makeDb({ metal: 3, gold: 3 }, { s1: { metal: 40, gold: 20 } });
    const r = await chargeConstruction({ DB: db }, {
      factionId: F, drains: [{ id: 's1', metal: 40, gold: 20 }], poolMetal: 10, poolGold: 5,
    });
    expect(r.ok).toBe(false);
    // Net zero on BOTH purses — the whole point.
    expect(db.settlements.s1).toEqual({ metal: 40, gold: 20 });
    expect(db.pool).toEqual({ metal: 3, gold: 3 });
    expect(db.log).toContain('refund settlement s1 40/20');
  });

  it('never drives the pool negative', async () => {
    const db = makeDb({ metal: 5, gold: 5 }, {});
    const r = await chargeConstruction({ DB: db }, { factionId: F, poolMetal: 50, poolGold: 50 });
    expect(r.ok).toBe(false);
    expect(db.pool.metal).toBeGreaterThanOrEqual(0);
    expect(db.pool.gold).toBeGreaterThanOrEqual(0);
    expect(db.pool).toEqual({ metal: 5, gold: 5 });
  });

  it('unwinds EVERY settlement already debited, not just the last one', async () => {
    const db = makeDb(
      { metal: 0, gold: 0 },
      { s1: { metal: 10, gold: 10 }, s2: { metal: 10, gold: 10 }, s3: { metal: 0, gold: 0 } },
    );
    const r = await chargeConstruction({ DB: db }, {
      factionId: F,
      drains: [
        { id: 's1', metal: 10, gold: 10 },
        { id: 's2', metal: 10, gold: 10 },
        { id: 's3', metal: 10, gold: 10 },   // misses
      ],
    });
    expect(r.ok).toBe(false);
    expect(db.settlements.s1).toEqual({ metal: 10, gold: 10 });
    expect(db.settlements.s2).toEqual({ metal: 10, gold: 10 });
  });

  it('the second of two identical submits is rejected, not double-charged', async () => {
    // Exactly enough for ONE order. This is the double-tap that started it.
    const db = makeDb({ metal: 50, gold: 50 }, {});
    const a = await chargeConstruction({ DB: db }, { factionId: F, poolMetal: 50, poolGold: 50 });
    const b = await chargeConstruction({ DB: db }, { factionId: F, poolMetal: 50, poolGold: 50 });
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(false);
    expect(db.pool).toEqual({ metal: 0, gold: 0 });   // charged once, never negative
  });

  it('a free order (no cost) succeeds and touches nothing', async () => {
    const db = makeDb({ metal: 7, gold: 7 }, {});
    const r = await chargeConstruction({ DB: db }, { factionId: F, poolMetal: 0, poolGold: 0 });
    expect(r.ok).toBe(true);
    expect(db.log).toEqual([]);
    expect(db.pool).toEqual({ metal: 7, gold: 7 });
  });
});
