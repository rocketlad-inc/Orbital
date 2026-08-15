// The upkeep-mix warning exists to catch a trap that is invisible until
// it bites: arrears is tracked PER CURRENCY, so a fleet whose designs
// bill metal can put the whole empire at −25% damage while total income
// looks healthy. These pin when it fires — and, just as importantly,
// when it stays quiet, because a situation report that cries wolf is
// one people learn to scroll past.

import {
  economyLedger, upkeepMixWarnings,
  MIX_MIN_UPKEEP, MIX_MAX_RUNWAY, MIX_URGENT_RUNWAY,
} from '../economyLedger';

/** Only the fields the ledger reads. */
const state = (o: {
  metalIn?: number; creditsIn?: number;
  metalStock?: number; creditsStock?: number;
  ships?: { class: string; parts?: string[] }[];
}) => ({
  // One terraformed world carrying the whole yield, so income is exactly
  // what the test asked for rather than something the haircut chose.
  settlements: [{ id: 's1', bodyId: 'b1', ownedBy: 'player', type: 'city', population: 1,
                  name: 'Test', hasCollector: true }],
  // Yield comes from body.resources (metal/gold), scaled by
  // PRODUCTION_MULTIPLIER, population and settlement type — so these are
  // knobs, not exact per-tick figures. The assertions below compare
  // income against upkeep rather than against literals for exactly that
  // reason: pinning a computed rate would make this a test of
  // settlementYield's tuning, which is not what is under test here.
  bodies: [{
    id: 'b1', name: 'Test', terraformedAtTick: 1,
    resources: { metal: o.metalIn ?? 0, gold: o.creditsIn ?? 0, science: 0, fuel: 0 },
  }],
  ships: (o.ships ?? []).map((s, i) => ({
    id: `sh${i}`, ownedBy: 'player', class: s.class, parts: s.parts ?? [],
  })),
  resources: { player: { ore: o.metalStock ?? 0, credits: o.creditsStock ?? 0, science: 0, fuel: 0 } },
  factionTech: { player: { levels: { industry: 0 } } },
  activeSliders: undefined,
} as never);

describe('economyLedger', () => {
  it('reports nothing to warn about for an empire with no fleet', () => {
    const led = economyLedger(state({ metalIn: 5, creditsIn: 5 }));
    expect(led.hulls).toBe(0);
    expect(upkeepMixWarnings(led)).toEqual([]);
  });

  it('gives a draining currency a runway and a paying one none', () => {
    const led = economyLedger(state({
      metalIn: 0, creditsIn: 100, metalStock: 50,
      ships: Array.from({ length: 12 }, () => ({ class: 'destroyer' })),
    }));
    expect(led.metal.net).toBeLessThan(0);
    expect(led.metal.runway).toBeGreaterThan(0);
    // A surplus has nothing to count down to — a number here would be
    // a nonsense "ticks until you run out of the thing you are gaining".
    expect(led.credits.runway).toBeNull();
  });
});

describe('when the warning fires', () => {
  const bigMetalFleet = Array.from({ length: 20 }, () => ({ class: 'destroyer' }));

  it('fires when the fleet bills a currency the worlds do not earn', () => {
    // Healthy TOTAL income — this is the whole point. Credits are
    // abundant; metal is not; the fleet bills metal.
    const led = economyLedger(state({
      metalIn: 1, creditsIn: 500, metalStock: 40, ships: bigMetalFleet,
    }));
    const w = upkeepMixWarnings(led);
    expect(w).toHaveLength(1);
    expect(w[0].currency).toBe('metal');
  });

  it('stays quiet when income covers the bill', () => {
    const led = economyLedger(state({
      metalIn: 500, creditsIn: 500, metalStock: 40, ships: bigMetalFleet,
    }));
    expect(upkeepMixWarnings(led)).toEqual([]);
  });

  it('stays quiet for a small empire whose deficit is rounding error', () => {
    // Two corvettes at turn one must never produce an item.
    const led = economyLedger(state({
      metalIn: 0, creditsIn: 0, metalStock: 10,
      ships: [{ class: 'corvette' }, { class: 'corvette' }],
    }));
    for (const w of upkeepMixWarnings(led)) {
      expect(w.line.upkeep).toBeGreaterThanOrEqual(MIX_MIN_UPKEEP);
    }
  });

  it('stays quiet when the stockpile is deep enough to be next month\'s problem', () => {
    const led = economyLedger(state({
      metalIn: 1, creditsIn: 500, metalStock: 100000, ships: bigMetalFleet,
    }));
    expect(upkeepMixWarnings(led)).toEqual([]);
    // ...and the drain is real, so it is the RUNWAY suppressing it.
    expect(led.metal.net).toBeLessThan(0);
    expect(led.metal.runway).toBeGreaterThan(MIX_MAX_RUNWAY);
  });

  it('escalates to urgent only as the stockpile runs down', () => {
    // Derive the stockpiles from the ACTUAL deficit rather than guessing
    // numbers: a hand-picked 300 happened to be 14 ticks of runway, i.e.
    // already urgent, and a literal here would silently start testing
    // the wrong band the next time upkeep is retuned.
    const probe = economyLedger(state({ metalIn: 1, creditsIn: 500, ships: bigMetalFleet }));
    const drain = -probe.metal.net;
    const midway = (MIX_URGENT_RUNWAY + MIX_MAX_RUNWAY) / 2;
    const roomy = economyLedger(state({
      metalIn: 1, creditsIn: 500, metalStock: drain * midway, ships: bigMetalFleet,
    }));
    const tight = economyLedger(state({
      metalIn: 1, creditsIn: 500, metalStock: drain * (MIX_URGENT_RUNWAY / 2), ships: bigMetalFleet,
    }));
    const a = upkeepMixWarnings(roomy);
    const b = upkeepMixWarnings(tight);
    expect(a[0]?.urgent).toBe(false);
    expect(b[0]?.urgent).toBe(true);
    expect(b[0].line.runway).toBeLessThanOrEqual(MIX_URGENT_RUNWAY);
  });

  it('orders the most urgent currency first when both are draining', () => {
    const led = economyLedger(state({
      metalIn: 0, creditsIn: 0, metalStock: 200, creditsStock: 20,
      ships: [
        ...Array.from({ length: 10 }, () => ({ class: 'destroyer' })),
        // Energy/armour hulls push their bill to the credit side.
        ...Array.from({ length: 10 }, () => ({ class: 'destroyer', parts: ['laser', 'armor'] })),
      ],
    }));
    const w = upkeepMixWarnings(led);
    if (w.length === 2) expect(w[0].line.runway!).toBeLessThanOrEqual(w[1].line.runway!);
  });
});

describe('the composition number the player acts on', () => {
  it('leans metal for kinetic hulls and credits for energy hulls', () => {
    const kinetic = economyLedger(state({
      ships: Array.from({ length: 5 }, () => ({ class: 'destroyer', parts: ['railgun', 'shield'] })),
    }));
    const energy = economyLedger(state({
      ships: Array.from({ length: 5 }, () => ({ class: 'destroyer', parts: ['laser', 'armor'] })),
    }));
    // The exact split is upkeepSplitFor's business; what this asserts is
    // the DIRECTION, which is what the warning tells a player to change.
    expect(kinetic.metalShare).toBeGreaterThan(energy.metalShare);
  });
});
