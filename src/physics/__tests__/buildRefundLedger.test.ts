// [pure] A cancelled build must hand back exactly what it took, to the
// purse it took it from.
//
// Regression guard for the reported exploit and the two it was hiding:
//
//   1. LAUNDERING. The queue spends LOCAL-FIRST (a raw world's banked
//      stockpile before the faction pool), and cancel refunded 100% to
//      the POOL. Queue on a raw world, cancel, repeat: stranded local
//      resources became spendable global ones, defeating the entire point
//      of a raw world.
//   2. MINTING. The queue charges ceil(price x buildCostMult) — host
//      config x senate ship_build_cost_multiplier x Construction
//      discount — and the refund used the BASE table price. With a
//      "Cheaper Ships" law at 0.5x you paid half and got back whole.
//   3. RUSH DRIFT. A rush costs base x mult x rushKnob; the refund paid
//      base x (1 + rush_count).
//
// The invariant that kills all three: refund total == charged total, and
// per-purse refund == per-purse charge. Kept in step with the charge
// ledger written in worker/actions.js (migration 0084).

interface Purse { metal: number; gold: number }
interface Ledger {
  pool: Purse;
  local: Array<{ id: string; metal: number; gold: number }>;
}

/** Mirror of the queue's local-first split. */
function chargeLedger(
  price: Purse,
  stocks: Array<{ id: string; metal: number; gold: number }>,
): Ledger {
  let needM = price.metal;
  let needG = price.gold;
  const local: Ledger['local'] = [];
  for (const s of stocks) {
    if (needM <= 0 && needG <= 0) break;
    const takeM = Math.min(needM, s.metal);
    const takeG = Math.min(needG, s.gold);
    if (takeM + takeG <= 0) continue;
    local.push({ id: s.id, metal: takeM, gold: takeG });
    needM -= takeM;
    needG -= takeG;
  }
  return { pool: { metal: needM, gold: needG }, local };
}

/** Mirror of the cancel refund. `alive` = settlements still standing and
 *  still mine; a dead one's share falls to the pool. */
function refundFromLedger(ledger: Ledger, alive: Set<string>) {
  let poolM = ledger.pool.metal;
  let poolG = ledger.pool.gold;
  const local: Array<{ id: string; metal: number; gold: number }> = [];
  for (const l of ledger.local) {
    if (l.metal <= 0 && l.gold <= 0) continue;
    if (alive.has(l.id)) local.push({ ...l });
    else { poolM += l.metal; poolG += l.gold; }
  }
  return { pool: { metal: poolM, gold: poolG }, local };
}

const total = (r: { pool: Purse; local: Array<Purse> }) => ({
  metal: r.pool.metal + r.local.reduce((a, x) => a + x.metal, 0),
  gold: r.pool.gold + r.local.reduce((a, x) => a + x.gold, 0),
});

describe('[pure] build refund honours the charge ledger', () => {
  it('returns a raw world\'s local spend to the SETTLEMENT, not the pool', () => {
    // The exploit, exactly: the settlement covers the whole price.
    const price = { metal: 40, gold: 20 };
    const stocks = [{ id: 'yavin', metal: 100, gold: 100 }];
    const charged = chargeLedger(price, stocks);
    expect(charged.local).toEqual([{ id: 'yavin', metal: 40, gold: 20 }]);
    expect(charged.pool).toEqual({ metal: 0, gold: 0 });

    const refund = refundFromLedger(charged, new Set(['yavin']));
    // Nothing whatsoever reaches the global pool.
    expect(refund.pool).toEqual({ metal: 0, gold: 0 });
    expect(refund.local).toEqual([{ id: 'yavin', metal: 40, gold: 20 }]);
  });

  it('splits a refund the same way the charge split it', () => {
    // Local covers part; the pool covers the remainder.
    const price = { metal: 100, gold: 50 };
    const stocks = [{ id: 'yavin', metal: 60, gold: 10 }];
    const charged = chargeLedger(price, stocks);
    expect(charged.local).toEqual([{ id: 'yavin', metal: 60, gold: 10 }]);
    expect(charged.pool).toEqual({ metal: 40, gold: 40 });

    const refund = refundFromLedger(charged, new Set(['yavin']));
    expect(refund.pool).toEqual({ metal: 40, gold: 40 });
    expect(refund.local).toEqual([{ id: 'yavin', metal: 60, gold: 10 }]);
  });

  it('conserves the total for any split (no minting, no theft)', () => {
    const price = { metal: 137, gold: 91 };
    for (const stocks of [
      [],
      [{ id: 'a', metal: 0, gold: 0 }],
      [{ id: 'a', metal: 50, gold: 0 }],
      [{ id: 'a', metal: 1000, gold: 1000 }],
      [{ id: 'a', metal: 20, gold: 30 }, { id: 'b', metal: 200, gold: 200 }],
    ]) {
      const charged = chargeLedger(price, stocks);
      const refund = refundFromLedger(charged, new Set(stocks.map(s => s.id)));
      expect(total(refund)).toEqual(price);
    }
  });

  it('is exploit-neutral over repeated queue/cancel cycles', () => {
    // The laundering test: run the cycle 50 times and assert the pool is
    // exactly where it started and the settlement is whole.
    let pool = { metal: 0, gold: 0 };
    let local = { metal: 500, gold: 500 };
    const price = { metal: 40, gold: 20 };
    for (let i = 0; i < 50; i++) {
      const charged = chargeLedger(price, [{ id: 's', ...local }]);
      local = {
        metal: local.metal - (charged.local[0]?.metal ?? 0),
        gold: local.gold - (charged.local[0]?.gold ?? 0),
      };
      pool = { metal: pool.metal - charged.pool.metal, gold: pool.gold - charged.pool.gold };
      const refund = refundFromLedger(charged, new Set(['s']));
      local = {
        metal: local.metal + (refund.local[0]?.metal ?? 0),
        gold: local.gold + (refund.local[0]?.gold ?? 0),
      };
      pool = { metal: pool.metal + refund.pool.metal, gold: pool.gold + refund.pool.gold };
    }
    expect(pool).toEqual({ metal: 0, gold: 0 });
    expect(local).toEqual({ metal: 500, gold: 500 });
  });

  it('refunds a price scaled by a senate law, not the base price', () => {
    // "Cheaper Ships" at 0.5x. The ledger records what was CHARGED, so
    // the refund can't pay back the un-discounted base and mint the gap.
    const base = { metal: 80, gold: 60 };
    const mult = 0.5;
    const scaled = { metal: Math.ceil(base.metal * mult), gold: Math.ceil(base.gold * mult) };
    const charged = chargeLedger(scaled, []);
    const refund = refundFromLedger(charged, new Set());
    expect(total(refund)).toEqual(scaled);
    expect(total(refund)).not.toEqual(base);
  });

  it('refunds accumulated rush fees, not base x rush_count', () => {
    // Queue at 0.5x, then two rushes at 0.5x x 1.0 rush knob. The ledger
    // accumulates real fees; the old formula used the base price.
    const base = { metal: 80, gold: 60 };
    const scaled = { metal: 40, gold: 30 };
    const ledger = chargeLedger(scaled, []);
    const rushFee = { metal: 40, gold: 30 };
    for (let i = 0; i < 2; i++) {
      ledger.pool.metal += rushFee.metal;
      ledger.pool.gold += rushFee.gold;
    }
    const refund = refundFromLedger(ledger, new Set());
    expect(total(refund)).toEqual({ metal: 120, gold: 90 });   // 40 + 40 + 40
    // The old formula: base x (1 + rush_count) = 80 x 3 = 240 metal.
    expect(total(refund).metal).not.toBe(base.metal * 3);
  });

  it('falls back to the pool only when the payer settlement is gone', () => {
    const charged = chargeLedger({ metal: 40, gold: 20 }, [{ id: 'yavin', metal: 100, gold: 100 }]);
    // Settlement destroyed or captured before the cancel.
    const refund = refundFromLedger(charged, new Set());
    expect(refund.local).toEqual([]);
    expect(refund.pool).toEqual({ metal: 40, gold: 20 });
    // Still conserved — nothing minted, nothing lost.
    expect(total(refund)).toEqual({ metal: 40, gold: 20 });
  });
});
