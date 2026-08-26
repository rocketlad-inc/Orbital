// EVERY TEMPLATE IN THE FRONTIER BANKS HAS TO RENDER.
//
// A phrase bank is a few hundred one-line functions, and the cost of a
// typo in one of them is that some edition, months from now, prints the
// word "undefined" in a headline and nobody can reproduce it — the
// template that did it is one draw in a hundred, chosen off a seeded
// cursor.
//
// So: render all of them, against a context carrying every field the
// digest passes, and refuse anything that comes back empty, undefined,
// or holding a stray placeholder.

import * as banks from '../../../worker/heraldBanks.js';

/** Every field buildFrontierStories puts on a context, in one object.
 *  Each bank reads its own subset; passing the union means one fixture
 *  covers all of them and a template reaching for a field nobody
 *  supplies shows up as `undefined` in the output. */
const CTX = {
  actor: 'The Solar Expanse',
  actorPlain: 'The Solar Expanse',
  other: 'Stonekin of Mars',
  otherPlain: 'Stonekin of Mars',
  rock: 'Iron Anna',
  rockPlain: 'Iron Anna',
  target: 'Mars',
  targetPlain: 'Mars',
  eta: 7,
  structure: 'a Warp Gate',
  structurePlain: 'Warp Gate',
  where: '**Callisto**, in the Jupiter system',
  wherePlain: 'Callisto',
  seller: 'The Wu Tang Clan',
  sellerPlain: 'The Wu Tang Clan',
  buyer: 'Everbranching Tree',
  buyerPlain: 'Everbranching Tree',
  asset: 'the Vanguard of Earth',
  assetPlain: 'Vanguard of Earth',
  price: '40 metal and 12 credits',
  pricePlain: '40 METAL AND 12 CREDITS',
  from: 'Pluto',
  fromPlain: 'Pluto',
  to: 'Mercury',
  toPlain: 'Mercury',
  ship: 'Chetzemoka',
  title: '**Tariff Reform**',
  sender: 'Tritalowda',
  senderPlain: 'Tritalowda',
  recipient: 'Moose Metals Conglomerate',
  recipientPlain: 'Moose Metals Conglomerate',
  cargo: '40 metal and 12 credits',
  killerClause: ', by **No Sleep the 3rd**',
  mineral: 'iron',
};

type Template = (c: typeof CTX) => string;

const bankEntries = Object.entries(banks as Record<string, unknown>)
  .filter((e): e is [string, Template[]] => Array.isArray(e[1]));

describe('frontier phrase banks', () => {
  it('exports the banks the digest imports', () => {
    const names = bankEntries.map(([n]) => n);
    for (const n of [
      'ASTEROID_LAUNCHED', 'MEGA_COMPLETE', 'MEGA_CLAIMED', 'MEGA_ABANDONED',
      'ASSET_SOLD', 'GATE_TRANSIT', 'GATE_LINK_SEVERED', 'SENATE_REAPED',
      'TRADE_SHIPMENT_LOST', 'MINE_EXHAUSTED',
    ]) {
      expect(names).toContain(n);
      expect(names).toContain(`${n}_HEADLINE`);
    }
  });

  // "Dozens" was the brief. A bank of four would technically wire the
  // kind up and would read as canned by the third edition.
  it('gives every narrative bank enough variety to not repeat', () => {
    for (const [name, bank] of bankEntries) {
      if (name.endsWith('_HEADLINE')) continue;
      expect({ name, n: bank.length }).toEqual({ name, n: expect.any(Number) });
      expect(bank.length).toBeGreaterThanOrEqual(18);
    }
  });

  it('gives every headline bank room to rotate', () => {
    for (const [name, bank] of bankEntries) {
      if (!name.endsWith('_HEADLINE')) continue;
      expect(bank.length).toBeGreaterThanOrEqual(10);
    }
  });

  it('renders every template without a hole in it', () => {
    for (const [name, bank] of bankEntries) {
      bank.forEach((tpl, i) => {
        const out = tpl(CTX);
        const where = `${name}[${i}]`;
        expect({ where, ok: typeof out === 'string' && out.length > 0 })
          .toEqual({ where, ok: true });
        expect({ where, out }).toEqual({ where, out: expect.not.stringContaining('undefined') });
        expect({ where, out }).toEqual({ where, out: expect.not.stringContaining('NaN') });
        expect({ where, out }).toEqual({ where, out: expect.not.stringContaining('[object') });
      });
    }
  });

  it('keeps headlines free of markdown — embed titles do not render it', () => {
    for (const [name, bank] of bankEntries) {
      if (!name.endsWith('_HEADLINE')) continue;
      bank.forEach((tpl, i) => {
        const out = tpl(CTX);
        expect({ where: `${name}[${i}]`, out })
          .toEqual({ where: `${name}[${i}]`, out: expect.not.stringContaining('**') });
      });
    }
  });

  it('writes no duplicate sentence inside a bank', () => {
    for (const [name, bank] of bankEntries) {
      const rendered = bank.map(t => t(CTX));
      expect({ name, unique: new Set(rendered).size }).toEqual({ name, unique: bank.length });
    }
  });
});
