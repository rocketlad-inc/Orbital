// THE TREE MUST SHOW THE WHOLE TABLE.
//
// A full-tree view is only worth having if it is complete. The failure
// that matters is silent: an unlock declared at a level the grid does
// not draw is a feature the player can never find, and nothing about
// the rendered page looks wrong — there is simply no cell for it.
//
// That is not hypothetical here. RESEARCH_UNLOCKS is edited by hand,
// levels run to TECH_MAX_LEVEL exactly, and this codebase has already
// shipped one unlock (building.telescope) that was declared in the
// table and honoured nowhere. So the invariant is asserted from the
// table's side: every row must land in a cell.

import { buildTechTree } from '../TechTree';
import { RESEARCH_UNLOCKS } from '../../game/researchUnlocks';
import { ALL_TECH_IDS, TECH_DEFS, TECH_MAX_LEVEL, nextLevelCost } from '../../game/techs';

describe('the grid covers the table', () => {
  const rows = buildTechTree({});
  const drawn = new Set(
    rows.flatMap(r => r.cells.flatMap(c => c.unlocks.map(u => u.feature))),
  );

  it('draws one row per level, one cell per track', () => {
    expect(rows).toHaveLength(TECH_MAX_LEVEL);
    for (const r of rows) expect(r.cells).toHaveLength(ALL_TECH_IDS.length);
  });

  it('every unlock in the table appears in some cell', () => {
    const missing = RESEARCH_UNLOCKS
      .filter(u => !drawn.has(u.feature))
      .map(u => `${u.feature} (${u.track} ${u.level})`);
    expect(missing).toEqual([]);
  });

  it('no unlock sits above the level cap, where no cell exists', () => {
    const stranded = RESEARCH_UNLOCKS
      .filter(u => u.level < 1 || u.level > TECH_MAX_LEVEL)
      .map(u => `${u.feature} at level ${u.level}`);
    expect(stranded).toEqual([]);
  });

  it('no unlock names a track with no column', () => {
    const orphans = RESEARCH_UNLOCKS
      .filter(u => !ALL_TECH_IDS.includes(u.track))
      .map(u => `${u.feature} on '${u.track}'`);
    expect(orphans).toEqual([]);
  });

  it('shows nothing the table does not declare', () => {
    expect(drawn.size).toBe(new Set(RESEARCH_UNLOCKS.map(u => u.feature)).size);
  });
});

describe('cell state tracks what the player owns', () => {
  // Weapons 3, everything else untouched.
  const rows = buildTechTree({ weapons: 3 });
  const cell = (level: number, track = 'weapons' as const) =>
    rows[level - 1].cells.find(c => c.track === track)!;

  it('levels already researched read as owned', () => {
    expect([1, 2, 3].map(l => cell(l).state)).toEqual(['owned', 'owned', 'owned']);
  });

  it('exactly one level per track is the next one', () => {
    for (const track of ALL_TECH_IDS) {
      const next = rows.filter(r => r.cells.find(c => c.track === track)!.state === 'next');
      expect(next).toHaveLength(1);
    }
    expect(cell(4).state).toBe('next');
  });

  it('everything past that is locked', () => {
    for (let l = 5; l <= TECH_MAX_LEVEL; l++) expect(cell(l).state).toBe('locked');
  });

  it('a maxed track has no next level', () => {
    const maxed = buildTechTree({ armor: TECH_MAX_LEVEL });
    const states = maxed.map(r => r.cells.find(c => c.track === 'armor')!.state);
    expect(states.every(s => s === 'owned')).toBe(true);
  });

  it('an untouched track starts at level 1', () => {
    expect(buildTechTree({})[0].cells.every(c => c.state === 'next')).toBe(true);
  });
});

describe('the level gutter prints one price for the whole row', () => {
  // The gutter shows a single number per level, which is only honest
  // while every track shares the cost curve. If a track is ever given
  // its own baseCost the gutter silently misprices five columns — so
  // uniformCost is what the component checks, and this is what keeps
  // that check meaningful.
  const rows = buildTechTree({});

  it('all six tracks charge the same for a given level, today', () => {
    for (const r of rows) expect(r.uniformCost).toBe(true);
  });

  it('the printed price is the real cost of that level', () => {
    for (const r of rows) {
      expect(r.cost).toBe(nextLevelCost(r.level - 1, TECH_DEFS[ALL_TECH_IDS[0]]));
    }
  });

  it('prices rise with level', () => {
    const costs = rows.map(r => r.cost);
    expect([...costs].sort((a, b) => a - b)).toEqual(costs);
  });
});
