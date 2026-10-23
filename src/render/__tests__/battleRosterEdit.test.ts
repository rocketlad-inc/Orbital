/**
 * A ROSTER CHANGE IS AN EDIT, NOT A RE-DEAL (battleLayoutLive +
 * orbitBattleLayout `prev`). The Dyson Sphere clip (2026-10-23, 13.4 s):
 * a block joined the orbit battle round the Sun and every fleet block
 * round the ring slid to a new slot inside 0.6 s, because the layout was
 * dealt again from scratch: the shares start at angle 0 and are sized to
 * who is there, so any arrival (or a new faction) turned every one.
 * Blocks already at the world now hold their places when one joins or
 * leaves; only the newcomer is fitted in.
 */
import {
  liveBattleFor, resetLiveBattles, ROSTER_DWELL_MS, type BattleUnit, type LiveBattle,
} from '../battleLayoutLive';

beforeEach(() => resetLiveBattles());

const SUN_R = 20;                      // battleReferenceRadius caps it at 320
const block = (id: string, owner: string, escorts: number, sizePx = 60): BattleUnit => ({
  id, owner, group: id, sizePx, armed: true,
  escortRel: Array(escorts).fill(0.7),
  escortIds: Array.from({ length: escorts }, (_, i) => `${id}-e${i}`),
});

/** The Dyson Sphere ring before the reinforcements: three empires, blocks. */
function ring(): BattleUnit[] {
  return [
    block('terra-1', 'terra', 12), block('terra-2', 'terra', 12), block('terra-3', 'terra', 10),
    block('mars-1', 'mars', 12), block('mars-2', 'mars', 12),
    block('jove-1', 'jove', 10), block('jove-2', 'jove', 8),
  ];
}

/** Every unit's move between two layouts, reference px. */
function moves(a: LiveBattle, b: LiveBattle): Map<string, number> {
  const out = new Map<string, number>();
  for (const [id, p] of a.layout.placements) {
    const q = b.layout.placements.get(id);
    if (q) out.set(id, Math.hypot(q.x - p.x, q.y - p.y));
  }
  return out;
}
const worst = (m: Map<string, number>) => Math.max(0, ...m.values());

/** The roster change, through the live path: seen, held for the dwell, solved. */
function change(units: BattleUnit[], owners: string[], t0: number): LiveBattle {
  liveBattleFor('sol', SUN_R, 1, units, owners, undefined, { nowMs: t0 });
  return liveBattleFor('sol', SUN_R, 1, units, owners, undefined, { nowMs: t0 + ROSTER_DWELL_MS });
}

test('a new empire’s block joins the ring: every block already there holds its slot', () => {
  const owners = ['jove', 'mars', 'terra'];
  const first = liveBattleFor('sol', SUN_R, 1, ring(), owners, undefined, { nowMs: 0 });
  // The Saturnine block in from Venus (a fourth faction, sorting between
  // the others, so a fresh deal re-proportions and turns every share).
  const owners2 = ['jove', 'mars', 'saturn', 'terra'];
  const next = change([...ring(), block('sat-1', 'saturn', 12)], owners2, 100);
  expect(next).not.toBe(first);
  expect(next.layout.placements.has('sat-1')).toBe(true);
  const m = moves(first, next);
  // A block is ~60-90 px across here; holding means a small fraction of one.
  expect(worst(m)).toBeLessThan(25);
  // The newcomer is fitted in: touching nobody, in the band round the Sun.
  expect(next.layout.overlaps).toBe(0);
  const sat = next.layout.placements.get('sat-1')!;
  expect(sat.r).toBeGreaterThan(next.refR);
  expect(sat.r).toBeLessThan(next.layout.band.rOut + 120);
});

test('the same on a full lap of the Sun (the clip’s ring): nobody moves for the newcomer', () => {
  const owners = ['jove', 'mars', 'terra'];
  const big = [...ring(), ...['terra-5', 'terra-6', 'terra-7', 'mars-5', 'mars-6', 'mars-7', 'jove-5', 'jove-6']
    .map(id => block(id, id.split('-')[0], 14))];
  const first = liveBattleFor('sol', SUN_R, 1, big, owners, undefined, { nowMs: 0 });
  expect(['ring', 'deep ring', 'crammed']).toContain(first.layout.mode);
  const next = change([...big, block('sat-1', 'saturn', 12)], ['jove', 'mars', 'saturn', 'terra'], 100);
  expect(next.layout.placements.has('sat-1')).toBe(true);
  expect(worst(moves(first, next))).toBeLessThan(25);
  expect(next.layout.overlaps).toBe(0);
});

test('a reinforcement block for an empire already there: the others do not move', () => {
  const owners = ['jove', 'mars', 'terra'];
  const first = liveBattleFor('sol', SUN_R, 1, ring(), owners, undefined, { nowMs: 0 });
  const next = change([...ring(), block('terra-4', 'terra', 12)], owners, 100);
  expect(next.layout.placements.has('terra-4')).toBe(true);
  expect(worst(moves(first, next))).toBeLessThan(25);
  // And it is fitted in, not dropped on top of anyone.
  expect(next.layout.overlaps).toBe(0);
});

test('a block leaving (destroyed): every other block holds exactly', () => {
  const owners = ['jove', 'mars', 'terra'];
  const first = liveBattleFor('sol', SUN_R, 1, ring(), owners, undefined, { nowMs: 0 });
  const next = change(ring().filter(u => u.id !== 'mars-2'), owners, 100);
  expect(next.layout.placements.has('mars-2')).toBe(false);
  expect(worst(moves(first, next))).toBeLessThan(1);
});

test('a battle losing escorts every tick never reshuffles over a long fight', () => {
  // Each re-solve is an edit of the last, so the drift does not add up.
  const owners = ['jove', 'mars', 'terra'];
  let units = ring();
  const first = liveBattleFor('sol', SUN_R, 1, units, owners, undefined, { nowMs: 0 });
  let lb = first;
  for (let tick = 1; tick <= 12; tick++) {
    units = units.map(u => (u.escortRel && u.escortRel.length > 2 && (tick + u.id.length) % 3 === 0
      ? { ...u, escortRel: u.escortRel.slice(1), escortIds: u.escortIds!.slice(1) } : u));
    lb = change(units, owners, tick * 2000);
  }
  expect(lb).not.toBe(first);
  expect(worst(moves(first, lb))).toBeLessThan(25);
});
