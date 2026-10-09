// Brazilian Portuguese flavor prose: structure, token filling, agreement.
import { generateFlavor, type FlavorContext, type FlavorEvent } from '../flavorEngine';
import { FLAVOR_BANK } from '../flavorBank';
import { FLAVOR_BANK_PT } from '../flavorBank.pt-BR';
import { agreeArticles, lexFor } from '../flavorLocale';

// Names that are not words of either language, so a leaked English word
// cannot hide inside a fixture.
const ctx: FlavorContext = {
  factions: new Map([
    ['f1', { id: 'f1', name: 'Vesperia', capitalBodyId: 'b1' }],
    ['f2', { id: 'f2', name: 'Korvath', capitalBodyId: 'b2' }],
    ['f3', { id: 'f3', name: 'Lumen', capitalBodyId: 'b3' }],
  ]),
  bodies: new Map([
    ['b1', { id: 'b1', name: 'Terra', type: 'terrestrial', orbitRadius: 500 }],
    ['b2', { id: 'b2', name: 'Marte', type: 'terrestrial', orbitRadius: 1000 }],
    ['b3', { id: 'b3', name: 'Ceres', type: 'dwarf', orbitRadius: 2500 }],
    ['b4', { id: 'b4', name: 'Io', type: 'moon', orbitRadius: 4000 }],
    ['b5', { id: 'b5', name: 'Vesta', type: 'asteroid', orbitRadius: 2000 }],
    ['b6', { id: 'b6', name: 'Jove', type: 'gas_giant', orbitRadius: 4200 }],
  ]),
};
const BODIES = ['Terra', 'Marte', 'Ceres', 'Io', 'Vesta', 'Jove'];
const FACS = ['f1', 'f2', 'f3'];

const CLASSES = ['frigate', 'corvette', 'destroyer', 'freighter', 'colony', 'mega_destroyer', 'mobile_foundry', 'kaiju'];
const BUILDINGS = ['forge', 'mint', 'lab', 'weapons', 'shipyard', 'telescope', 'trajectory_thrusters', 'shields'];
const SECRETS = ['portal_to_sun', 'warp_gate', 'ancient_city', 'free_collector', 'pre_terraformed', 'derelict_warship',
  'resource_cache', 'ancient_databank', 'ancient_capital', 'ancient_relay', 'ancient_station', 'far_gate', 'deep_cache',
  'precursor_orrery', 'horizon_archive'];
const TECHS = ['weapons', 'armor', 'propulsion', 'construction', 'industry', 'sensors'];
const DETAILS = ['Dyson Sphere complete', 'Controls 17 of 25 worlds (68%)', 'Bob elected Supreme Chancellor by senate vote'];

/** An event with EVERY optional field present, cycling the enumerations by index. */
function fullEvent(kind: string, i: number): FlavorEvent {
  const a = FACS[i % 3];
  const b = FACS[(i + 1) % 3];
  const body = BODIES[i % BODIES.length];
  const payloads: Record<string, Record<string, unknown>> = {
    ship_destroyed: { killer_faction_id: b, ship_name: 'Hesperus', ship_class: CLASSES[i % CLASSES.length], body_name: body, captain_name: 'Ada Voss', hp_lost: 40 },
    settlement_destroyed: { killer_faction_id: b, settlement_name: 'Alvorada', settlement_type: i % 2 ? 'city' : 'station', body_name: body, pop_lost: 1 + (i % 10) },
    settlement_built: { settlement_name: 'Alvorada', settlement_type: i % 2 ? 'city' : 'station', body_name: body },
    ship_built: { ship_name: 'Aurora', ship_class: CLASSES[i % CLASSES.length], body_name: body },
    building_completed: { building_kind: BUILDINGS[i % BUILDINGS.length], settlement_name: 'Alvorada', body_name: body },
    secret_discovered: { kind: SECRETS[i % SECRETS.length], body_name: body },
    trade_accepted: { offer: { metal: 10, fuel: 2 }, request: { gold: 7.5, science: 1 } },
    treaty_signed: { kind: ['nap', 'defense_pact', 'intel_share'][i % 3] },
    treaty_broken: { kind: ['nap', 'defense_pact', 'intel_share'][i % 3] },
    asteroid_impact: { target_owner_faction_id: b, target_name: body, settlement_name: 'Alvorada' },
    senate_vote: { title: 'Tarifa Alfa', outcome: i % 2 ? 'passed' : 'failed' },
    senate_law_expired: { title: 'Tarifa Alfa', ticks_in_force: 24 + i },
    senate_reaped: { title: 'Tarifa Alfa' },
    senate_term: { term_index: i % 5, start_tick: 100, end_tick: 148 },
    tech_advanced: { tech_id: TECHS[i % TECHS.length], level: 1 + (i % 9) },
    victory: { detail: DETAILS[i % DETAILS.length] },
    // Banks that exist but are not wired to a server kind yet.
    vote_opened: { title: 'Tarifa Alfa' },
    trade_declined: { offer: { metal: 10 }, request: { gold: 7 } },
  };
  return { id: `c${i * 13}_${kind}_${i}`, kind, tick: 100 + i, actorFactionId: a, targetFactionId: b, payload: payloads[kind] ?? {} };
}

// Server kind -> bank key, exactly as KIND_MAP in the engine.
const WIRED: Record<string, string> = {
  ship_destroyed: 'ship_destroyed', settlement_destroyed: 'settlement_destroyed', settlement_built: 'settlement_founded',
  ship_built: 'ship_built', building_completed: 'building_completed', secret_discovered: 'secret_discovered',
  trade_accepted: 'trade_accepted', treaty_signed: 'pact_signed', treaty_broken: 'pact_broken',
  asteroid_impact: 'asteroid_impact', senate_vote: 'vote_resolved', senate_term: 'chairman_seated',
  senate_law_expired: 'law_expired', senate_reaped: 'bill_reaped', tech_advanced: 'tech_advanced', victory: 'victory',
};

const tokensOf = (s: string): string[] => [...s.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort();

describe('flavor bank, pt-BR mirrors English', () => {
  it('has the same kinds and the same number of entries per kind', () => {
    expect(Object.keys(FLAVOR_BANK_PT).sort()).toEqual(Object.keys(FLAVOR_BANK).sort());
    for (const k of Object.keys(FLAVOR_BANK)) {
      expect({ kind: k, n: FLAVOR_BANK_PT[k].length }).toEqual({ kind: k, n: FLAVOR_BANK[k].length });
    }
  });

  it('uses exactly the same {tokens} in entry N as English entry N', () => {
    for (const k of Object.keys(FLAVOR_BANK)) {
      FLAVOR_BANK[k].forEach((en, i) => {
        expect({ kind: k, i, tokens: tokensOf(FLAVOR_BANK_PT[k][i]) })
          .toEqual({ kind: k, i, tokens: tokensOf(en) });
      });
    }
  });

  it('never opens a sentence with a noun token (its case would be wrong)', () => {
    const nounTokens = '(shipClass|settlementType|bodyType|secretName|building|detail)';
    const re = new RegExp(`(^|[.!?]\\s+)\\{${nounTokens}\\}`);
    for (const [k, list] of Object.entries(FLAVOR_BANK_PT)) {
      list.forEach((tpl, i) => expect({ k, i, bad: re.test(tpl) }).toEqual({ k, i, bad: false }));
    }
  });

  it('writes feminine-capable article slots only in the masculine form', () => {
    // The engine turns "o" into "a" for a feminine noun; a template that
    // already says "a {shipClass}" would turn masculine nouns wrong.
    const re = /(^|[^\p{L}])(a|uma|da|na|numa|à|pela)\s+\{(shipClass|settlementType|bodyType|secretName)\}/iu;
    for (const [k, list] of Object.entries(FLAVOR_BANK_PT)) {
      list.forEach((tpl, i) => expect({ k, i, bad: re.test(tpl) }).toEqual({ k, i, bad: false }));
    }
  });
});

describe('flavorEngine, pt-BR output', () => {
  // Distinctive English words: every word of 3+ letters in the English bank,
  // except those that also occur in the Portuguese bank (shared vocabulary).
  const words = (s: string): string[] => (s.toLowerCase().match(/[\p{L}]{3,}/gu) ?? []);
  const ptWords = new Set(Object.values(FLAVOR_BANK_PT).flat().flatMap(t => words(t.replace(/\{\w+\}/g, ' '))));
  const stop = new Set(
    Object.values(FLAVOR_BANK).flat().flatMap(t => words(t.replace(/\{\w+\}/g, ' '))).filter(w => !ptWords.has(w)),
  );

  it('builds a stop-list that actually contains English function and content words', () => {
    for (const w of ['the', 'and', 'with', 'this', 'cycle', 'ordnance', 'gavel', 'senate']) {
      expect(stop.has(w)).toBe(true);
    }
    expect(stop.size).toBeGreaterThan(300);
  });

  // vote_opened and trade_declined have banks but no server kind feeds
  // them yet; the bank tests above cover their shape.
  it.each(Object.keys(WIRED))('%s: filled, clean, Portuguese over 50 ids', kind => {
    for (let i = 0; i < 50; i++) {
      const event = fullEvent(kind, i);
      const text = generateFlavor(event, ctx, 'pt-BR');
      expect(text).toBeTruthy();
      const t = text as string;
      expect(t).not.toMatch(/[{}]/);
      expect(t).not.toMatch(/undefined|null|NaN|\[object/);
      expect(t.trim()).toBe(t);
      const leaked = words(t).filter(w => stop.has(w));
      expect({ kind, i, t, leaked }).toEqual({ kind, i, t, leaked: [] });
    }
  });

  it('puts the faction, world and ship names into the text', () => {
    const t = generateFlavor(fullEvent('ship_built', 3), ctx, 'pt-BR') as string;
    expect(t).toMatch(/Aurora/);
    expect(t).toMatch(/Vesperia|Korvath|Lumen/);
    expect(t).toMatch(/Io|Terra|Marte|Ceres|Vesta|Jove/);
  });

  it('picks the matching variant: captain / population lines appear in both languages together', () => {
    for (let i = 0; i < 200; i++) {
      for (const withCaptain of [true, false]) {
        const e = fullEvent('ship_destroyed', i);
        e.id = `parity_${i}`;
        if (!withCaptain) delete e.payload.captain_name;
        const en = generateFlavor(e, ctx, 'en') as string;
        const pt = generateFlavor(e, ctx, 'pt-BR') as string;
        expect({ i, withCaptain, en: en.includes('Ada Voss') }).toEqual({ i, withCaptain, en: pt.includes('Ada Voss') });
        if (!withCaptain) expect(pt).not.toContain('Ada Voss');
      }
      const s = fullEvent('settlement_destroyed', i);
      s.id = `parity_${i}`;
      const en = generateFlavor(s, ctx, 'en') as string;
      const pt = generateFlavor(s, ctx, 'pt-BR') as string;
      expect({ i, en: /opulation/.test(en) }).toEqual({ i, en: /opulação/.test(pt) });
      const sNoPop = { ...s, payload: { ...s.payload, pop_lost: undefined } };
      expect(generateFlavor(sNoPop, ctx, 'pt-BR')).not.toMatch(/opulação/);
    }
  });

  it('skips variants whose data is missing, like English does', () => {
    const e = fullEvent('treaty_signed', 1);
    e.payload = {};                              // no pact kind => every {pactType} line is skipped
    for (let i = 0; i < 30; i++) {
      e.id = `x${i}`;
      const en = generateFlavor(e, ctx, 'en');
      const pt = generateFlavor(e, ctx, 'pt-BR');
      expect(pt === null).toBe(en === null);
      if (pt) expect(pt).not.toMatch(/Pacto|pacto de/);
    }
    expect(generateFlavor({ ...e, kind: 'unheard_of' }, ctx, 'pt-BR')).toBeNull();
  });

  it('agrees the article with the gender of ship classes, settlement types and body types', () => {
    const bad = [
      /\b(o|um|do|no|num|ao) (fragata|corveta|estação|cidade|lua|nave colonizadora|fundição móvel|nave de guerra)\b/i,
      /\b(a|uma|da|na|numa|à) (destróier|cargueiro|assentamento|asteroide|mundo|planeta-anão|gigante|leviatã|mega destróier)\b/i,
    ];
    for (const kind of ['ship_destroyed', 'ship_built', 'settlement_destroyed', 'settlement_built', 'secret_discovered']) {
      for (let i = 0; i < 160; i++) {
        const t = generateFlavor(fullEvent(kind, i), ctx, 'pt-BR') as string;
        for (const re of bad) expect({ kind, i, t, hit: re.test(t) }).toEqual({ kind, i, t, hit: false });
      }
    }
  });

  it('names: ship classes, buildings, secrets and techs come from the Portuguese game vocabulary', () => {
    const seen = (kind: string, n: number): string =>
      Array.from({ length: n }, (_, i) => generateFlavor(fullEvent(kind, i), ctx, 'pt-BR')).join('\n');
    expect(seen('ship_built', 80)).toMatch(/fragata/);
    expect(seen('ship_built', 80)).toMatch(/destróier/);
    expect(seen('ship_built', 80)).toMatch(/cargueiro/);
    expect(seen('building_completed', 80)).toMatch(/edifício Estaleiro/);
    expect(seen('tech_advanced', 80)).toMatch(/Propulsão/);
    expect(seen('tech_advanced', 80)).toMatch(/nível \d/);
    expect(seen('treaty_signed', 40)).toMatch(/Pacto de Não Agressão/);
    expect(seen('victory', 40)).toMatch(/Esfera de Dyson concluída/);
    expect(seen('victory', 40)).toMatch(/controla 17 de 25 mundos \(68%\)/);
    expect(seen('victory', 40)).toMatch(/Chanceler Supremo eleito por voto do Senado: Bob/);
  });
});

describe('flavorLocale, pt-BR helpers', () => {
  const pt = lexFor('pt-BR');
  const en = lexFor('en');

  it('rewrites a masculine article before a feminine noun token, nothing else', () => {
    const g = { shipClass: 'f' as const, bodyType: 'm' as const };
    expect(agreeArticles('O {shipClass} {shipName} de {partner}', g)).toBe('A {shipClass} {shipName} de {partner}');
    expect(agreeArticles('perde um {shipClass}. Mais um {shipClass}', g)).toBe('perde uma {shipClass}. Mais uma {shipClass}');
    expect(agreeArticles('no {shipClass}, ao {shipClass}, do {shipClass}, num {shipClass}', g))
      .toBe('na {shipClass}, à {shipClass}, da {shipClass}, numa {shipClass}');
    expect(agreeArticles('Um {shipClass} e um {bodyType}', g)).toBe('Uma {shipClass} e um {bodyType}');
    expect(agreeArticles('Sobre um {bodyType} sem nome', g)).toBe('Sobre um {bodyType} sem nome');
    // The word must stand alone: "nao"/"outro {shipClass}" are untouched.
    expect(agreeArticles('outro {shipClass}, mão {shipClass}', g)).toBe('outro {shipClass}, mão {shipClass}');
    // Names (no gender known) are never touched.
    expect(agreeArticles('o {actor} e um {body}', g)).toBe('o {actor} e um {body}');
  });

  it('gives each known noun its gender', () => {
    expect(pt.shipClass('frigate')).toEqual({ text: 'fragata', g: 'f' });
    expect(pt.shipClass('destroyer')).toEqual({ text: 'destróier', g: 'm' });
    expect(pt.shipClass('mega_destroyer')?.text).toBe('mega destróier');
    expect(pt.shipClass('colony')?.g).toBe('f');
    expect(pt.shipClass(undefined)).toBeUndefined();
    expect(pt.settlementType('station')).toEqual({ text: 'estação', g: 'f' });
    expect(pt.settlementType(undefined)).toEqual({ text: 'assentamento', g: 'm' });
    expect(pt.bodyType('moon')).toEqual({ text: 'lua', g: 'f' });
    expect(pt.bodyType('terrestrial')?.text).toBe('mundo rochoso');
    expect(pt.secretName('derelict_warship')?.g).toBe('f');
    expect(pt.secretName('mystery_thing')).toEqual({ text: 'mystery thing', g: 'm' });
    expect(pt.building('forge')).toEqual({ text: 'Forja' });
  });

  it('writes population the Portuguese way', () => {
    expect(pt.population(1)).toBe('200 mil');
    expect(pt.population(3)).toBe('600 mil');
    expect(pt.population(5)).toBe('1 milhão');
    expect(pt.population(6)).toBe('1,2 milhão');
    expect(pt.population(9)).toBe('1,8 milhão');
    expect(pt.population(10)).toBe('2 milhões');
    expect(en.population(6)).toBe('1.2 million');
    expect(en.population(3)).toBe('600,000');
  });

  it('writes trades, outcomes, levels and distances', () => {
    const offer = pt.bundle({ metal: 10, fuel: 2, gold: 0, science: 0 });
    const request = pt.bundle({ gold: 7.5, science: 1 });
    expect(offer).toBe('10 de metal e 2 de combustível');
    expect(request).toBe('7,5 de créditos e 1 de ciência');
    expect(pt.trade(offer, request)).toBe('10 de metal e 2 de combustível por 7,5 de créditos e 1 de ciência');
    expect(pt.trade(offer, undefined)).toBe(offer);
    expect(pt.trade(undefined, undefined)).toBeUndefined();
    expect(pt.bundle({})).toBeUndefined();
    expect(pt.voteOutcome('passed')).toBe('passou');
    expect(pt.voteOutcome('failed')).toBe('não passou');
    expect(pt.voteOutcome(undefined)).toBeUndefined();
    expect(pt.techLevel('4')).toBe('nível 4');
    expect(pt.techLevel(undefined)).toBeUndefined();
    expect([100, 1000, 2000, 5000, undefined].map(r => pt.distance(r)))
      .toEqual(['num salto curto', 'pelo sistema interno', 'na longa travessia até o Cinturão', 'para além dos gigantes gasosos', 'pelo sistema']);
    expect(pt.leaderTitles).toHaveLength(en.leaderTitles.length);
    expect(pt.techName('armor', 'Defense')).toBe('Defesa');
    expect(pt.techName('nonesuch', undefined)).toBe('Nonesuch');
    expect(pt.pactType('defense_pact')).toBe('Pacto de Defesa');
    expect(pt.pactType('wat')).toBeUndefined();
  });
});
