import fs from 'fs';
import path from 'path';
import {
  RESEARCH_UNLOCKS, isMegastructureUnlock, megastructureHowTo, megastructureNextStep,
  requirementFor, requirementLabel, MEGASTRUCTURE_REASSURANCE,
} from '../researchUnlocks';
import { MEGASTRUCTURES, MEGASTRUCTURE_KINDS } from '../megastructures';

// Playtest feedback (Noah): megastructure research was not marked as
// such in the tree, and nothing in the game said how to start building
// one — "I thought they'd wipe out the upgrades on a planet."

describe('megastructures are marked, and explained', () => {
  it('every buildable megastructure is a marked unlock on the tree', () => {
    for (const kind of MEGASTRUCTURE_KINDS) {
      const feature = MEGASTRUCTURES[kind].feature;
      const row = RESEARCH_UNLOCKS.find(u => u.feature === feature);
      expect(row).toBeTruthy();
      expect(isMegastructureUnlock(row!.feature)).toBe(true);
    }
  });

  it('nothing else is marked: the module is a part, not a megastructure', () => {
    const marked = RESEARCH_UNLOCKS.filter(u => isMegastructureUnlock(u.feature)).map(u => u.feature);
    const buildable = MEGASTRUCTURE_KINDS.map(k => MEGASTRUCTURES[k].feature);
    expect([...marked].sort()).toEqual([...buildable].sort());
    expect(isMegastructureUnlock('part.construction')).toBe(false);
  });

  it('the how-to names the module by its real place on the tree', () => {
    const steps = megastructureHowTo();
    expect(steps).toHaveLength(3);
    // Moving the module to another level must move this copy with it.
    expect(steps[0]).toContain(requirementLabel('part.construction'));
    expect(steps[1]).toMatch(/colony|ship is spent/i);
    expect(steps[2]).toMatch(/freighter/i);
    expect(MEGASTRUCTURE_REASSURANCE).toMatch(/Nothing on your worlds is touched/);
  });

  it('the next step depends on whether you hold the module', () => {
    const req = requirementFor('part.construction')!;
    expect(megastructureNextStep({})).toContain(requirementLabel('part.construction'));
    expect(megastructureNextStep({ [req.track]: req.level - 1 })).toMatch(/^Needs /);
    expect(megastructureNextStep({ [req.track]: req.level })).toMatch(/^Fit a Construction Module/);
  });
});

describe('megastructure guidance — where it is shown', () => {
  const read = (rel: string) => fs.readFileSync(path.join(__dirname, '..', '..', rel), 'utf8');

  it('the full tree marks them and carries the how-to', () => {
    const tree = read('components/TechTree.tsx');
    expect(tree).toMatch(/techtree__unlock--mega/);
    expect(tree).toMatch(/techtree__key--mega/);
    expect(tree).toMatch(/megastructureHowTo\(\)\.map/);
    // Not by colour alone.
    expect(tree).toMatch(/◆ /);
    expect(tree).toMatch(/\(megastructure\)/);
  });

  it('the research cards and the Situation Report say what to do next', () => {
    expect(read('components/TechPanel.tsx')).toMatch(/megastructureNextStep\(tech\.levels\)/);
    const sit = read('hooks/useSituationItems.ts');
    expect(sit).toMatch(/Megastructure unlocked: \$\{megaOpened\.join\(', '\)\}/);
    expect(sit).toMatch(/megastructureNextStep\(/);
  });

  it('a colony ship WITHOUT the module says why it offers no megastructures', () => {
    const ship = read('components/ShipPanel.tsx');
    expect(ship).toMatch(/!\(ship\.parts \?\? \[\]\)\.includes\('construction'\) && <MegastructureModuleHint \/>/);
    const card = read('multiplayer/MegastructureCard.tsx');
    expect(card).toMatch(/export const MegastructureModuleHint/);
    // And the moment of committing answers the fear the playtest named.
    expect(card).toMatch(/\{MEGASTRUCTURE_REASSURANCE\}/);
    expect(card).toMatch(/nothing on your worlds is touched/);
  });
});
