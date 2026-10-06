// ============================================================
// A FAR SYSTEM'S BARYCENTER IS ITS STAR, AND IS NOTHING.
//
// Seen on staging (2026-10-06): the Centauri Barycenter, an empty centre
// of mass carrying the type 'lagrange' (which on this map otherwise means
// a trojan ROCK), took a planet's floor and drew as a grey ball. Both
// Centauri suns orbit it, so they folded into it and vanished; its
// worlds, whose parent was not a star, all took a moon's tiny floor.
// ============================================================

import {
  computePresentation, floorClass, isBarycenter, DISPLAY_FLOOR_PX,
} from '../bodyPresentation';
import type { Body } from '../../types';

const B = (o: Partial<Body> & { id: string; type: Body['type'] }): Body => ({
  name: o.id, radius: 1, orbitRadius: 0, orbitPeriod: 0, angle0: 0, soi: 0, color: '#fff',
  ...o,
} as Body);

const sol = B({ id: 'sol', type: 'star', radius: 50 });
const bary = B({ id: 'g1:binary_barycenter', type: 'lagrange', parent: 'sol', radius: 1, orbitRadius: 265200 });
const starA = B({ id: 'g1:centauri_a', type: 'star', parent: 'g1:binary_barycenter', radius: 8, orbitRadius: 18 });
const starB = B({ id: 'g1:centauri_b', type: 'star', parent: 'g1:binary_barycenter', radius: 6, orbitRadius: 28 });
const verdant = B({ id: 'g1:verdant', type: 'terrestrial', parent: 'g1:binary_barycenter', radius: 4, orbitRadius: 400 });
const crimson = B({ id: 'g1:crimson', type: 'gas_giant', parent: 'g1:binary_barycenter', radius: 9, orbitRadius: 850 });
const prismara = B({ id: 'g1:prismara', type: 'moon', parent: 'g1:crimson', radius: 1.8, orbitRadius: 26 });
// Sol's own trojan rock: a REAL lagrange body, which must be left alone.
const trojan = B({ id: 'g1:hektor', type: 'lagrange', parent: 'sol', radius: 1, orbitRadius: 4600 });

describe('far-system barycenters', () => {
  it('knows a far barycenter, game-prefixed or not, and nothing else', () => {
    expect(isBarycenter(bary)).toBe(true);
    expect(isBarycenter({ id: 'bh_barycenter' } as Body)).toBe(true);
    expect(isBarycenter(trojan)).toBe(false);
    expect(isBarycenter(sol)).toBe(false);
  });

  it('its worlds are planets and giants, not moons', () => {
    expect(floorClass(verdant, bary)).toBe('planet');
    expect(floorClass(crimson, bary)).toBe('giant');
    expect(floorClass(prismara, crimson)).toBe('moon');
  });

  it('a trojan rock keeps the planet floor it always had', () => {
    expect(floorClass(trojan, sol)).toBe('planet');
  });

  it('the barycenter takes no space; its suns stay lit at every zoom', () => {
    const bodies = [sol, bary, starA, starB, verdant, crimson, prismara];
    // Zoomed far out: everything in the system lands on one pixel.
    const at = (id: string) => {
      if (id === 'sol') return { x: 0, y: 0 };
      return { x: 500, y: 300 };
    };
    const p = computePresentation(bodies, 0.0015, at, null, { w: 1200, h: 800 });
    expect(p.radius.get(bary.id)).toBe(0);
    // At least one sun shows (the pair may merge into the brighter one).
    const lit = [starA, starB].filter(s => (p.shown.get(s.id) ?? 0) >= 0.5);
    expect(lit.length).toBeGreaterThan(0);
    // The suns never fold into the empty point.
    expect([starA, starB].map(s => p.host.get(s.id))).not.toContain(bary.id);
  });

  it('a world still gets its proper floor, not a moon\'s', () => {
    const bodies = [sol, bary, starA, starB, verdant];
    const at = (id: string) => (id === 'g1:verdant' ? { x: 900, y: 300 } : id === 'sol' ? { x: -5000, y: 0 } : { x: 500, y: 300 });
    const p = computePresentation(bodies, 0.01, at, null, null);
    expect(p.radius.get(verdant.id)).toBeGreaterThanOrEqual(DISPLAY_FLOOR_PX.planet);
  });
});

// ============================================================
// THE HOMES SHOW WITH THE WHOLE SYSTEM (Lorne, 2026-10-06: "I can see
// the worlds around the stars at the same time as the rest of the
// system"). Zoomed out to Centauri the floors run at their 3x growth
// (Sol's Neptune sets it), so a sun is a 48px disc and a planet 27: a
// home world closer than ~103px to its sun folds into it. Laid out as
// Lorne frames it (browser zoom 0.5, so a 2880x1920 CSS viewport, with
// Farspire's orbit reaching 0.55 of the short side), from the lobby
// mirror's geometry at live size (x2 orbits and bodies).
// ============================================================
import { SHARED_BODIES } from '../../state/mockGameState';

describe("Centauri's two homes at whole-system zoom", () => {
  const cat = (id: string) => SHARED_BODIES.find(b => b.id === id)!;
  const VIEW = { w: 2880, h: 1920 };
  const cx = VIEW.w / 2, cy = VIEW.h / 2;
  const scale = (0.55 * VIEW.h) / (2 * cat('farspire').orbitRadius);

  // Suns at periastron, the closest the dance brings them; each home
  // straight out from its own sun at `homeR` (live units).
  function present(homeR: number) {
    const live = (id: string, parent: string | null, type: Body['type']) =>
      B({ id: `g1:${id}`, type, parent: parent ? `g1:${parent}` : undefined,
        radius: cat(id).radius * 2, orbitRadius: cat(id).orbitRadius * 2 });
    const solB = B({ id: 'sol', type: 'star', radius: 50 });
    // Sol's outermost giant sets the floor growth; out at Centauri it is
    // far off screen, so the growth sits at its 3x cap. That is what
    // Lorne's screenshot shows (16px sun to a ~30px fold, image at 1/3
    // CSS px): a 48px sun.
    const neptune = B({ id: 'neptune', type: 'gas_giant', parent: 'sol', radius: 12, orbitRadius: 1e6 });
    const baryB = B({ id: 'g1:binary_barycenter', type: 'lagrange', parent: 'sol', radius: 0.5, orbitRadius: 265200 });
    const a = live('centauri_a', 'binary_barycenter', 'star');
    const b = live('centauri_b', 'binary_barycenter', 'star');
    const v = live('verdant', 'centauri_a', 'terrestrial');
    const c = live('cinder', 'centauri_b', 'terrestrial');
    const cr = live('crimson', 'binary_barycenter', 'gas_giant');
    const fs = live('farspire', 'binary_barycenter', 'dwarf');
    const rpA = 2 * cat('centauri_a').orbit_rp!, rpB = 2 * cat('centauri_b').orbit_rp!;
    const pos: Record<string, { x: number; y: number }> = {
      sol: { x: -1e6, y: 0 }, neptune: { x: -1e6, y: 9000 },
      'g1:binary_barycenter': { x: cx, y: cy },
      'g1:centauri_a': { x: cx - rpA * scale, y: cy },
      'g1:centauri_b': { x: cx + rpB * scale, y: cy },
      'g1:verdant': { x: cx - rpA * scale, y: cy - homeR * scale },
      'g1:cinder': { x: cx + rpB * scale, y: cy + homeR * scale },
      'g1:crimson': { x: cx, y: cy - cr.orbitRadius * scale },
      'g1:farspire': { x: cx, y: cy + fs.orbitRadius * scale },
    };
    const bodies = [solB, neptune, baryB, a, b, v, c, cr, fs];
    return computePresentation(bodies, scale, id => pos[id] ?? null, null, VIEW);
  }

  it('shows Verdant and Cinder beside their suns, not folded in', () => {
    const p = present(2 * cat('verdant').orbitRadius);
    expect(p.shown.get('g1:verdant')).toBe(1);
    expect(p.shown.get('g1:cinder')).toBe(1);
    expect(p.shown.get('g1:centauri_a')).toBe(1);
    expect(p.shown.get('g1:centauri_b')).toBe(1);
  });

  it('...with room to spare: they would still show zoomed out by half again', () => {
    // At 2/3 of the framing's scale the same layout must still unfold.
    const p = present(2 * cat('verdant').orbitRadius * (2 / 3));
    expect(p.shown.get('g1:verdant')).toBe(1);
    expect(p.shown.get('g1:cinder')).toBe(1);
  });

  it('models the limit: the first wide cut (500 live) folded at this zoom', () => {
    const p = present(500);
    expect(p.shown.get('g1:verdant')).toBeLessThan(1);
    expect(p.shown.get('g1:cinder')).toBeLessThan(1);
  });
});

// Cygnus, laid out the same way (2026-10-06, "do the same thing for
// Cygnus"): Requiem beside the hole, Echelon beside the giant, framed so
// Reliquary's orbit reaches 0.55 of the short side.
describe("Cygnus's two homes at whole-system zoom", () => {
  const cat = (id: string) => SHARED_BODIES.find(b => b.id === id)!;
  const VIEW = { w: 2880, h: 1920 };
  const cx = VIEW.w / 2, cy = VIEW.h / 2;
  const scale = (0.55 * VIEW.h) / (2 * cat('reliquary').orbitRadius);

  function present(homeR: number) {
    const live = (id: string, parent: string | null, type: Body['type']) =>
      B({ id: `g1:${id}`, type, parent: parent ? `g1:${parent}` : undefined,
        radius: cat(id).radius * 2, orbitRadius: cat(id).orbitRadius * 2 });
    const solB = B({ id: 'sol', type: 'star', radius: 50 });
    const neptune = B({ id: 'neptune', type: 'gas_giant', parent: 'sol', radius: 12, orbitRadius: 1e6 });
    const baryB = B({ id: 'g1:bh_barycenter', type: 'lagrange', parent: 'sol', radius: 0.5, orbitRadius: 340000 });
    const hole = live('cygnus_x', 'bh_barycenter', 'black_hole');
    const giant = live('hde_226868', 'bh_barycenter', 'star');
    const rq = live('requiem', 'cygnus_x', 'terrestrial');
    const ec = live('echelon', 'hde_226868', 'terrestrial');
    const vl = live('vellichor', 'bh_barycenter', 'gas_giant');
    const rl = live('reliquary', 'bh_barycenter', 'dwarf');
    const rpH = 2 * cat('cygnus_x').orbit_rp!, rpG = 2 * cat('hde_226868').orbit_rp!;
    const pos: Record<string, { x: number; y: number }> = {
      sol: { x: -1e6, y: 0 }, neptune: { x: -1e6, y: 9000 },
      'g1:bh_barycenter': { x: cx, y: cy },
      'g1:cygnus_x': { x: cx - rpH * scale, y: cy },
      'g1:hde_226868': { x: cx + rpG * scale, y: cy },
      'g1:requiem': { x: cx - rpH * scale, y: cy - homeR * scale },
      'g1:echelon': { x: cx + rpG * scale, y: cy + homeR * scale },
      'g1:vellichor': { x: cx, y: cy - vl.orbitRadius * scale },
      'g1:reliquary': { x: cx, y: cy + rl.orbitRadius * scale },
    };
    const bodies = [solB, neptune, baryB, hole, giant, rq, ec, vl, rl];
    return computePresentation(bodies, scale, id => pos[id] ?? null, null, VIEW);
  }

  it('shows Requiem beside the hole and Echelon beside the giant', () => {
    const p = present(2 * cat('requiem').orbitRadius);
    expect(p.shown.get('g1:requiem')).toBe(1);
    expect(p.shown.get('g1:echelon')).toBe(1);
    expect(p.shown.get('g1:cygnus_x')).toBe(1);
    expect(p.shown.get('g1:hde_226868')).toBe(1);
  });

  it('...still shows zoomed out by half again', () => {
    const p = present(2 * cat('requiem').orbitRadius * (2 / 3));
    expect(p.shown.get('g1:requiem')).toBe(1);
    expect(p.shown.get('g1:echelon')).toBe(1);
  });

  it('models the limit: at Centauri\'s first wide cut (500 live) they fold', () => {
    const p = present(500);
    expect(p.shown.get('g1:echelon')).toBeLessThan(1);
  });
});
