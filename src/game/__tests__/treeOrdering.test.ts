// DESIGN RULES ABOUT WHERE THINGS SIT IN THE TREE.
//
// researchWiring.test.ts asks whether an unlock is ENFORCED. This file
// asks whether it is in the RIGHT PLACE — a different question, and one
// nothing else was answering.
//
// Every rule below is a deliberate call about pacing, not an accident of
// the table's ordering. They are the kind of thing that survives exactly
// until the next person inserts a row and shifts the levels underneath,
// at which point the tree still compiles, still gates correctly, still
// renders — and quietly teaches a different game. That is the whole
// reason they are assertions instead of a comment.
//
// Each rule records WHY, so a future change can overrule it deliberately
// rather than break it by accident. Changing one of these means changing
// its test, on purpose, with the reasoning updated.

import { RESEARCH_UNLOCKS, FeatureId } from '../researchUnlocks';
import { TechId } from '../techs';

/** The level a feature unlocks at. Throws rather than returning a
 *  default — a missing row means the rule is meaningless, not passing. */
function levelOf(feature: FeatureId): number {
  const row = RESEARCH_UNLOCKS.find(u => u.feature === feature);
  if (!row) throw new Error(`${feature} is not in RESEARCH_UNLOCKS`);
  return row.level;
}

function trackOf(feature: FeatureId): TechId {
  const row = RESEARCH_UNLOCKS.find(u => u.feature === feature);
  if (!row) throw new Error(`${feature} is not in RESEARCH_UNLOCKS`);
  return row.track;
}

/** Highest level any unlock occupies on a track. */
function lastLevelOn(track: TechId): number {
  const levels = RESEARCH_UNLOCKS.filter(u => u.track === track).map(u => u.level);
  if (levels.length === 0) throw new Error(`no unlocks on ${track}`);
  return Math.max(...levels);
}

describe('Construction', () => {
  it('the Telescope comes before the Destroyer', () => {
    // Mining is gated on finding rocks. Behind the Destroyer, the
    // economy only opened once you could already take rocks off someone
    // by force, which is backwards: the peaceful use of a mechanic
    // should not be the late one.
    expect(levelOf('building.telescope')).toBeLessThan(levelOf('hull.destroyer'));
  });

  it('the Dyson Foundation is the LAST thing on the track', () => {
    // It opens a victory path. A victory condition sitting mid-ladder,
    // with ordinary unlocks stacked above it, reads as a milestone you
    // pass rather than one you build toward — and megastructure rows are
    // queued for Construction 8+, which is exactly the change that would
    // bury it.
    //
    // If this fails because something was added above it, the fix is to
    // move the DYSON up, not to accept it in the middle.
    expect(levelOf('dyson')).toBe(lastLevelOn('construction'));
  });

  it('the hull ladder stays in order: frigate, then destroyer', () => {
    expect(levelOf('hull.frigate')).toBeLessThan(levelOf('hull.destroyer'));
  });

  it('the Construction Module is a Construction tech, before the Telescope', () => {
    // Lorne, 2026-08-25. It sat on Society 8 because putting it at the
    // BOTTOM of Construction would shove the Dyson down three rungs.
    // Placing it EARLY costs the Dyson one rung instead, and the module
    // reads as what it is: the tech that lets you build a big thing.
    //
    // Early is defensible because the module is only the shovel. WHICH
    // megastructure you may lay is gated separately and far deeper
    // (Weapons 6/7, Defense 7/8, Propulsion 6/7/8), so a cheap module
    // opens no structure on its own.
    expect(trackOf('part.construction')).toBe('construction');
    expect(levelOf('part.construction')).toBeLessThan(levelOf('building.telescope'));
  });
});

describe('Weapons', () => {
  it('the Fusion Detonator comes after Veteran Yards', () => {
    // A warhead is priced off the carrier's hull HP rather than its
    // guns, so it is the sharpest thing a cheap corvette can carry.
    // Handing it out as the second weapons unlock made ramming the
    // opening move of the game instead of a late trick.
    expect(levelOf('part.detonator')).toBeGreaterThan(levelOf('veteranYards'));
  });

  it('kinetic is still the first gun anyone fits', () => {
    // The counter-matrix teaches itself from here: kinetic, so shields
    // answer it, so energy and armor close the triangle.
    const weapons = RESEARCH_UNLOCKS.filter(u => u.track === 'weapons');
    const first = Math.min(...weapons.map(u => u.level));
    expect(levelOf('part.kinetic')).toBe(first);
  });
});

describe('Society', () => {
  it('the Mining Rig sits directly behind Defense & Intel Pacts', () => {
    // At Society 7 the rig cost 4,921 science cumulative just to enter a
    // mining economy that also wants a Telescope on a second track.
    // "Directly behind" is the rule, not merely "after" — a gap here
    // means something was inserted between them.
    expect(levelOf('part.mining')).toBe(levelOf('pacts') + 1);
  });
});

describe('Propulsion', () => {
  it('the convoy ladder runs two hulls before four', () => {
    expect(levelOf('trade.convoy2')).toBeLessThan(levelOf('trade.convoy4'));
  });

  it('convoys are a PROPULSION concern, not a Society one', () => {
    // What these raise is how many hulls a route carries, which is a
    // movement problem. They sat on Society for flavour while Propulsion
    // 4 onward was seven dead rungs of engine bonus.
    expect(trackOf('trade.convoy2')).toBe('propulsion');
    expect(trackOf('trade.convoy4')).toBe('propulsion');
  });

  it('you can fly a freighter before you can run a convoy of them', () => {
    expect(levelOf('hull.freighter')).toBeLessThan(levelOf('trade.convoy2'));
  });
});

describe('the tree stays walkable', () => {
  // THE RULE, tightened (Lorne, 2026-08-25): named unlocks run from
  // level 1 with NO empty rungs between them. Dead levels are allowed
  // only BEHIND the last one, where they read as scaling rather than as
  // a stretch of nothing you paid full price for.
  //
  // Construction is the one exception, and a deliberate one: the Dyson
  // Foundation sits at 10 with 8 and 9 empty beneath it, because a
  // victory path should be the top of a ladder you can see yourself
  // climbing rather than the next rung up.
  const GAPPED_BY_DESIGN = new Set<TechId>(['construction']);

  it('every track but Construction runs unbroken from level 1', () => {
    const byTrack = new Map<TechId, number[]>();
    for (const u of RESEARCH_UNLOCKS) {
      byTrack.set(u.track, [...(byTrack.get(u.track) ?? []), u.level]);
    }
    const offenders: string[] = [];
    for (const [track, raw] of byTrack) {
      if (GAPPED_BY_DESIGN.has(track)) continue;
      const levels = [...new Set(raw)].sort((a, b) => a - b);
      if (levels[0] !== 1) offenders.push(`${track}: starts at ${levels[0]}, not 1`);
      for (let i = 1; i < levels.length; i++) {
        if (levels[i] !== levels[i - 1] + 1) {
          offenders.push(`${track}: empty rung(s) after ${levels[i - 1]}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('Construction leaves its gap under the Dyson, not somewhere else', () => {
    const levels = [...new Set(
      RESEARCH_UNLOCKS.filter(u => u.track === 'construction').map(u => u.level),
    )].sort((a, b) => a - b);
    const dyson = levelOf('dyson');
    // Everything below the Dyson is unbroken from 1; the gap is the run
    // between the last ordinary unlock and the Dyson itself.
    const below = levels.filter(l => l < dyson);
    expect(below).toEqual(below.map((_, i) => i + 1));
    expect(levels[levels.length - 1]).toBe(dyson);
  });
});
