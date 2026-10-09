// Golden English output of the flavor engine. These strings were produced by
// the engine BEFORE the language parameter existed (the change was proven
// byte-identical against the old engine over thousands of synthetic events),
// so any edit that makes one of them move is a regression for English
// players and for everything that consumes `chronicleFlavor`.
import { generateFlavor, type FlavorContext, type FlavorEvent } from '../flavorEngine';
import { FLAVOR_BANK } from '../flavorBank';

const ctx: FlavorContext = {
  factions: new Map([
    ['f1', { id: 'f1', name: 'Terran Union', capitalBodyId: 'b1' }],
    ['f2', { id: 'f2', name: 'Martian Free State', capitalBodyId: 'b2' }],
  ]),
  bodies: new Map([
    ['b1', { id: 'b1', name: 'Earth', type: 'terrestrial', orbitRadius: 500 }],
    ['b2', { id: 'b2', name: 'Mars', type: 'terrestrial', orbitRadius: 1000 }],
    ['b3', { id: 'b3', name: 'Ceres', type: 'dwarf', orbitRadius: 2500 }],
    ['b4', { id: 'b4', name: 'Io', type: 'moon', orbitRadius: 4000 }],
  ]),
};

const ev = (id: string, kind: string, actor: string | null, target: string | null,
  payload: Record<string, unknown>): FlavorEvent =>
  ({ id, kind, tick: 120, actorFactionId: actor, targetFactionId: target, payload });

const SHIP_MAYFLOWER = { killer_faction_id: 'f1', ship_name: 'CSS Mayflower', ship_class: 'frigate', body_name: 'Mars', captain_name: 'Ada Voss' };
const SHIP_LANTERN = { killer_faction_id: 'f1', ship_name: 'Lantern', ship_class: 'destroyer', body_name: 'Io' };
const SETTLE_LOST = { killer_faction_id: 'f1', settlement_name: 'New Eden', settlement_type: 'station', body_name: 'Mars', pop_lost: 6 };
const SETTLE_NEW = { settlement_name: 'Haven', settlement_type: 'city', body_name: 'Ceres' };
const SHIP_NEW = { ship_name: 'Aurora', ship_class: 'corvette', body_name: 'Earth' };
const BUILDING = { building_kind: 'forge', settlement_name: 'Haven', body_name: 'Earth' };
const SECRET = { kind: 'ancient_city', body_name: 'Io' };
const TRADE = { offer: { metal: 10 }, request: { gold: 7, science: 1 } };
const IMPACT = { target_owner_faction_id: 'f2', target_name: 'Mars', settlement_name: 'Doomed' };

const CASES: Array<[string, FlavorEvent, string]> = [
  ['ship destroyed (captain)', ev('c12_c', 'ship_destroyed', 'f2', null, SHIP_MAYFLOWER),
    "Kill confirmed at T+120: Martian Free State's Frigate CSS Mayflower, Captain Ada Voss commanding, breaks up over Mars."],
  ['ship destroyed (plain)', ev('c12_c', 'ship_destroyed', 'f2', null, SHIP_LANTERN),
    "Martian Free State's Destroyer Lantern goes silent above Io. Terran Union claims the kill."],
  ['ship destroyed (plain, other id)', ev('c10_a', 'ship_destroyed', 'f2', null, SHIP_LANTERN),
    'Lantern burned bright and brief over Io. Terran Union cracked the Martian Free State Destroyer open.'],
  ['ship destroyed (other id)', ev('c11_b', 'ship_destroyed', 'f2', null, SHIP_LANTERN),
    'Last contact with Lantern at T+120, in Io orbit. The Martian Free State Destroyer is scrap; Terran Union reports no losses.'],
  ['settlement destroyed (population)', ev('c12_c', 'settlement_destroyed', 'f2', null, SETTLE_LOST),
    "Martian Free State's New Eden burns. Population 1.2 million, status unknown. Terran Union confirms the station on Mars is gone."],
  ['settlement destroyed', ev('c10_a', 'settlement_destroyed', 'f2', null, SETTLE_LOST),
    'Terran Union razed New Eden at T+120. The station is a crater on Mars.'],
  ['settlement destroyed (other id)', ev('c11_b', 'settlement_destroyed', 'f2', null, SETTLE_LOST),
    "Martian Free State's hold on Mars ends with New Eden. Terran Union reports the station destroyed at T+120."],
  ['settlement founded', ev('c10_a', 'settlement_built', 'f1', null, SETTLE_NEW),
    'On a dwarf that had never known a name, Terran Union planted Haven. The first beacon answered the dark.'],
  ['settlement founded (other id)', ev('c11_b', 'settlement_built', 'f1', null, SETTLE_NEW),
    "Haven began as a single airlock on Ceres. By cycle's end Terran Union had a city drawing breath."],
  ['ship built', ev('c10_a', 'ship_built', 'f1', null, SHIP_NEW),
    'Terran Union commissioned the Corvette Aurora this cycle. Trials over Earth reported nominal.'],
  ['ship built (other id)', ev('c11_b', 'ship_built', 'f1', null, SHIP_NEW),
    'Terran Union launched the Corvette Aurora from Earth. Acceptance flights begin next cycle.'],
  ['building completed', ev('c10_a', 'building_completed', 'f1', null, BUILDING),
    'The new Forge at Haven came online this cycle. Terran Union reports Earth output rising.'],
  ['building completed (other id)', ev('c11_b', 'building_completed', 'f1', null, BUILDING),
    'Terran Union brought the Forge at Haven into service. Earth logistics rerouted accordingly.'],
  ['secret discovered', ev('c10_a', 'secret_discovered', 'f2', null, SECRET),
    "Something is humming beneath Io. Martian Free State's teams found a ancient databank and have not stopped staring."],
  ['secret discovered (other id)', ev('c11_b', 'secret_discovered', 'f2', null, SECRET),
    "Down in the moon cold of Io, Martian Free State's surveyors brushed dust from a ancient databank. Then they went very quiet on the comms."],
  ['trade accepted', ev('c10_a', 'trade_accepted', 'f1', 'f2', TRADE),
    'Deal closed: Terran Union and Martian Free State settled on 10 metal for 7 credits, 1 science. Both sides called it fair.'],
  ['trade accepted (other id)', ev('c11_b', 'trade_accepted', 'f1', 'f2', TRADE),
    'Terran Union moved 10 metal for 7 credits, 1 science to Martian Free State this cycle. Analysts noted the relationship warming.'],
  ['pact signed', ev('c10_a', 'treaty_signed', 'f1', 'f2', { kind: 'defense_pact' }),
    'The President of Terran Union traveled across the inner system to personally meet the Chancellor of Martian Free State. By dawn the Defense Pact bore both signatures.'],
  ['pact signed (other id)', ev('c11_b', 'treaty_signed', 'f1', 'f2', { kind: 'defense_pact' }),
    'The Defense Pact between Terran Union and Martian Free State was sealed in a closed session at Mars. Neither delegation took questions afterward.'],
  ['pact broken', ev('c10_a', 'treaty_broken', 'f2', 'f1', { kind: 'nap' }),
    'The Chancellor of Martian Free State tore up the pact with Terran Union in a televised address from Mars. Markets between the two capitals fell within the hour.'],
  ['pact broken (other id)', ev('c11_b', 'treaty_broken', 'f2', 'f1', { kind: 'nap' }),
    "The accord between Martian Free State and Terran Union is dead. Martian Free State's envoys left Earth before the ink on the dissolution had dried."],
  ['asteroid impact', ev('c10_a', 'asteroid_impact', 'f1', null, IMPACT),
    'An asteroid struck Mars at T+120. The Martian Free State settlement at Doomed went dark. Terran Union does not deny the order.'],
  ['asteroid impact (other id)', ev('c11_b', 'asteroid_impact', 'f1', null, IMPACT),
    "The rock found Mars at T+120. Martian Free State's Doomed answered no further calls. Terran Union's fingerprints are on the launch."],
  ['senate vote', ev('c10_a', 'senate_vote', 'f1', null, { title: 'Raise tariffs', outcome: 'passed' }),
    'After lengthy debate, “Raise tariffs” passed.'],
  ['law expired', ev('c10_a', 'senate_law_expired', 'f2', null, { title: 'Raise tariffs', ticks_in_force: 48 }),
    'The sunset clause on “Raise tariffs” came due. It is no longer law.'],
  ['bill reaped', ev('c10_a', 'senate_reaped', 'f2', null, { title: 'Raise tariffs' }),
    'The motion “Raise tariffs” expired in committee, unvoted.'],
  ['chairman seated', ev('c10_a', 'senate_term', 'f1', null, { term_index: 2, start_tick: 100, end_tick: 148 }),
    'Terran Union takes the chair for term 3. The floor is theirs for 48 ticks — no longer.'],
  ['tech advanced', ev('c10_a', 'tech_advanced', 'f1', null, { tech_id: 'weapons', level: 3 }),
    'Field trials confirm it: Terran Union now operates Weapons at level 3.'],
  ['victory', ev('c10_a', 'victory', 'f1', null, { detail: 'Controls 17 of 25 worlds (68%)' }),
    'T+120: Terran Union takes the system. Controls 17 of 25 worlds (68%). Every other flag comes down.'],
  ['victory (other id)', ev('c11_b', 'victory', 'f1', null, { detail: 'Dyson Sphere complete' }),
    "It's over. Terran Union has won — Dyson Sphere complete. The record closes here, T+120."],
];

describe('flavorEngine, English (golden)', () => {
  it.each(CASES)('%s', (_name, event, expected) => {
    expect(generateFlavor(event, ctx, 'en')).toBe(expected);
  });

  it('defaults to the current language (English under test)', () => {
    const [, event, expected] = CASES[0];
    expect(generateFlavor(event, ctx)).toBe(expected);
  });

  it('is deterministic per event id and varies across ids', () => {
    const seen = new Set<string | null>();
    for (let i = 0; i < 40; i++) {
      const e = ev(`c${i}_x`, 'ship_built', 'f1', null, SHIP_NEW);
      const a = generateFlavor(e, ctx, 'en');
      expect(generateFlavor(e, ctx, 'en')).toBe(a);
      seen.add(a);
    }
    expect(seen.size).toBeGreaterThan(5);
  });

  it('keeps the English bank at its published size', () => {
    const sizes = Object.fromEntries(Object.entries(FLAVOR_BANK).map(([k, v]) => [k, v.length]));
    expect(sizes).toEqual({
      pact_signed: 10, pact_broken: 10, ship_destroyed: 16, settlement_destroyed: 16,
      ship_damaged: 10, ship_built: 10, building_completed: 10, settlement_founded: 10,
      secret_discovered: 10, vote_opened: 10, vote_resolved: 10, law_expired: 10,
      bill_reaped: 6, chairman_seated: 10, tech_advanced: 10, trade_accepted: 10,
      trade_declined: 10, asteroid_impact: 10, victory: 5,
    });
  });

  it('skips a variant whose data is missing (no captain, no population)', () => {
    const noCaptain = { ...SHIP_MAYFLOWER, captain_name: undefined };
    for (let i = 0; i < 60; i++) {
      const text = generateFlavor(ev(`k${i}`, 'ship_destroyed', 'f2', null, noCaptain), ctx, 'en');
      expect(text).not.toBeNull();
      expect(text).not.toMatch(/Captain|undefined|\{/);
    }
  });
});
