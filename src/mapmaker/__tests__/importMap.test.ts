import { importMapText, exportMapText, extractJson, exportFileName } from '../importMap';
import { buildAiPrompt } from '../aiPrompt';
import { checkMap, generateMap, normalizeMap, MAX_BODIES } from '../../game/customMap';

const ok = (text: string) => {
  const r = importMapText(text);
  if (!r.ok) throw new Error(`import failed: ${r.error} ${r.detail ?? ''}`);
  return r;
};
const codes = (r: { notes: Array<{ code: string }> }) => r.notes.map(n => n.code).sort();
const byName = (r: ReturnType<typeof ok>, name: string) => {
  const b = r.map.bodies.find(x => x.name === name);
  if (!b) throw new Error(`no body ${name}: ${r.map.bodies.map(x => x.name).join(', ')}`);
  return b;
};

describe('reading JSON out of text', () => {
  it('reads plain JSON', () => {
    expect(extractJson('{"a":1}')).toEqual({ ok: true, value: { a: 1 } });
  });
  it('reads a fenced block inside prose', () => {
    const r = extractJson('Sure! Here is your map:\n\n```json\n{"name": "X"}\n```\nEnjoy it.');
    expect(r).toEqual({ ok: true, value: { name: 'X' } });
  });
  it('reads braces inside prose without a fence', () => {
    expect(extractJson('Here you go: {"name": "Y"} -- have fun')).toEqual({ ok: true, value: { name: 'Y' } });
  });
  it('forgives comments, trailing commas, single and curly quotes, bare keys and words', () => {
    const r = extractJson(`{
      // the map
      name: 'Kestrel',   /* a name */
      "blurb": “It’s cold”,
      bodies: [{ type: planet, rings: True, lore: "a // not a comment", }, ],
    }`);
    expect(r).toEqual({ ok: true, value: { name: 'Kestrel', blurb: 'It’s cold', bodies: [{ type: 'planet', rings: true, lore: 'a // not a comment' }] } });
  });
  it('says when there is no JSON, or it cannot be read', () => {
    expect(extractJson('no braces here')).toMatchObject({ ok: false, error: 'noJson' });
    expect(extractJson('{ "a": [1, 2 }')).toMatchObject({ ok: false, error: 'badJson' });
  });
});

describe('importing a map', () => {
  it('round-trips an exported map with no notes', () => {
    const map = generateMap({ seed: 7, planets: 8, starts: 4 });
    const r = ok(exportMapText(map));
    expect(r.notes).toEqual([]);
    expect(r.map).toEqual(normalizeMap(map));
  });

  it('refuses empty, huge and non-map input', () => {
    expect(importMapText('   ')).toEqual({ ok: false, error: 'empty' });
    expect(importMapText('x'.repeat(1_000_001))).toEqual({ ok: false, error: 'tooBig' });
    expect(importMapText('{"hello": "world"}')).toEqual({ ok: false, error: 'notAMap' });
  });

  it('takes what a chat AI typically writes: nested moons, AU, degrees, aliases, names as parents', () => {
    const r = ok(`Here's a system for 3 players!

\`\`\`json
{
  "title": "The Verdant Crown",
  "description": "Three garden worlds round a red star.",
  "star": { "name": "Crown", "spectralClass": "M4V", "mass": 0.6 },
  "sky": "purple",
  "planets": [
    { "name": "Aster", "type": "Rocky planet", "distance": "0.6 AU", "position": 30, "size": "medium",
      "biome": "jungle", "resources": { "minerals": 3, "gold": 4, "research": 3 }, "homeworld": true,
      "moons": [ { "name": "Pip", "orbit": 20, "angle": 90, "description": "A grey pebble." } ] },
    { "name": "Briar", "type": "Earth-like", "distance": "1.1 AU", "position": 150, "size": "large",
      "terrain": "water", "resources": { "minerals": 2, "gold": 3, "research": 4 }, "homeworld": true },
    { "name": "Corm", "type": "terrestrial", "distance": "1.6 AU", "position": 270, "size": "medium",
      "climate": "arid", "resources": { "minerals": 3, "gold": 3, "research": 3 }, "homeworld": true },
    { "name": "Big Jove", "type": "Gas Giant", "distance": "3 AU", "position": 200, "size": "huge",
      "rings": true, "climate": "banded", "resources": { "minerals": 1, "gold": 9, "research": 2 } }
  ],
  "moons": [ { "name": "Sliver", "orbits": "Big Jove", "orbit": 30, "angle": 10, "type": "satellite" } ]
}
\`\`\`
Let me know if you want changes!`);
    expect(r.map.name).toBe('The Verdant Crown');
    expect(r.map.blurb).toBe('Three garden worlds round a red star.');
    expect(r.map.sun).toMatchObject({ name: 'Crown', color: '#ff7b4f', mass: 0.6 });
    expect(r.map.settings.backdrop).toBe('violet');
    const aster = byName(r, 'Aster');
    expect(aster).toMatchObject({ type: 'terrestrial', parent: 'sun', surface: 'verdant', start: true, yields: { metal: 3, credits: 4, science: 3 } });
    expect(aster.orbit).toBeCloseTo(0.6 * 372, 0);
    expect(aster.angle).toBeCloseTo(Math.PI / 6, 3);
    expect(byName(r, 'Pip')).toMatchObject({ type: 'moon', parent: aster.id, orbit: 20, lore: 'A grey pebble.' });
    expect(byName(r, 'Briar').surface).toBe('ocean');
    expect(byName(r, 'Corm').surface).toBe('desert');
    const jove = byName(r, 'Big Jove');
    expect(jove).toMatchObject({ type: 'gas-giant', rings: true, surface: 'gas', radius: 11 });
    expect(byName(r, 'Sliver')).toMatchObject({ type: 'moon', parent: jove.id, orbit: 30 });
    expect(codes(r)).toEqual(['degrees', 'parentByName']);
    // AU strings carry their unit, so no AU note: the value said so.
    expect(checkMap(r.map).filter(i => i.level === 'block')).toEqual([]);
  });

  it('converts bare AU numbers and says so', () => {
    const r = ok(JSON.stringify({ bodies: [
      { name: 'A', type: 'planet', orbit: 1, start: true, yields: { science: 3 } },
      { name: 'B', type: 'planet', orbit: 5.2 },
      { name: 'C', type: 'dwarf', orbit: 39.5 },
    ] }));
    expect(byName(r, 'A').orbit).toBe(372);
    expect(byName(r, 'B').orbit).toBeCloseTo(5.2 * 372, 0);
    expect(codes(r)).toContain('auOrbits');
  });

  it('converts kilometres: orbits, moon orbits and radii', () => {
    const r = ok(JSON.stringify({ bodies: [
      { name: 'Earthish', type: 'terrestrial', orbit: 149_600_000, radius: 6371,
        satellites: [{ name: 'Lune', orbit: 384_400, radius: 1737 }] },
      { name: 'Far', type: 'terrestrial', orbit: 778_500_000, radius: 69_911 },
    ] }));
    expect(byName(r, 'Earthish').orbit).toBeCloseTo(372, 0);
    expect(byName(r, 'Earthish').radius).toBeCloseTo(3, 1);
    expect(byName(r, 'Lune').orbit).toBeCloseTo(20, 0);
    expect(codes(r)).toEqual(expect.arrayContaining(['kmOrbits', 'kmMoons', 'kmRadius']));
  });

  it('makes ids, places missing orbits apart, and lifts moons of moons', () => {
    const r = ok(JSON.stringify([
      { name: 'One', moons: [{ name: 'Inner', moons: [{ name: 'Tiny' }] }] },
      { name: 'Two' },
      { name: 'Three' },
    ]));
    const ids = r.map.bodies.map(b => b.id);
    expect(new Set(ids).size).toBe(ids.length);
    const one = byName(r, 'One'), two = byName(r, 'Two'), three = byName(r, 'Three');
    expect(one.orbit).toBeLessThan(two.orbit);
    expect(two.orbit).toBeLessThan(three.orbit);
    expect(byName(r, 'Tiny').parent).toBe(one.id);
    expect(byName(r, 'Inner').orbit).not.toBe(byName(r, 'Tiny').orbit);
    expect(codes(r)).toEqual(expect.arrayContaining(['orbitsMade', 'moonsLifted']));
  });

  it('accepts names-only moon lists and bodies keyed by name', () => {
    const r = ok(JSON.stringify({ planets: { Kora: { orbit: 300, moons: ['Vel', 'Ost'] }, Zan: { orbit: 600 } } }));
    expect(r.map.bodies.map(b => b.name).sort()).toEqual(['Kora', 'Ost', 'Vel', 'Zan']);
    expect(byName(r, 'Vel').parent).toBe(byName(r, 'Kora').id);
  });

  it('scales an oversized yield range down as a whole', () => {
    const r = ok(JSON.stringify({ bodies: [
      { name: 'Rich', type: 'planet', orbit: 300, yields: { metal: 100, credits: 50, science: 20 } },
      { name: 'Poor', type: 'planet', orbit: 600, yields: { metal: 10, credits: 10, science: 10 } },
    ] }));
    expect(byName(r, 'Rich').yields).toEqual({ metal: 30, credits: 15, science: 6 });
    expect(byName(r, 'Poor').yields).toEqual({ metal: 3, credits: 3, science: 3 });
    expect(r.notes.find(n => n.code === 'yieldsScaled')?.n).toBe(100);
  });

  it('reports what it could not keep', () => {
    const r = ok(JSON.stringify({ bodies: [
      { name: 'Gassy', type: 'gas giant', orbit: 900, start: true, secret: 'ancient city' },
      { name: 'Weird', type: 'blorp', orbit: 400, surface: 'plaid', secret: 'a strange signal' },
      { name: 'Close', type: 'planet', orbit: 70000 },
      42,
      { name: 'Stone', type: 'meteoroid', orbit: 700, mineral: 'gold', tons: 3000, secret: 'cache' },
    ] }));
    expect(codes(r)).toEqual(expect.arrayContaining(['startsDropped', 'secretsDropped', 'typeGuessed', 'surfaceUnknown', 'secretUnknown', 'orbitsClamped', 'skipped']));
    expect(byName(r, 'Gassy')).toMatchObject({ start: false, secret: null });
    expect(byName(r, 'Weird')).toMatchObject({ type: 'terrestrial', secret: 'random' });
    expect(byName(r, 'Stone')).toMatchObject({ type: 'rock', mineral: { kind: 'gold', tons: 3000 }, secret: null });
    expect(r.notes.find(n => n.code === 'startsDropped')?.names).toEqual(['Gassy']);
  });

  it('turns anything nested under a world into its moon', () => {
    const r = ok(JSON.stringify({ bodies: [{ name: 'Host', type: 'gas-giant', orbit: 900, children: [{ name: 'Rocklet', type: 'asteroid', orbit: 30 }] }] }));
    expect(byName(r, 'Rocklet')).toMatchObject({ type: 'moon', parent: byName(r, 'Host').id });
    expect(codes(r)).toContain('madeMoons');
  });

  it('keeps worlds before moons when over the cap', () => {
    const planets = Array.from({ length: MAX_BODIES + 20 }, (_, i) => ({ name: `P${i}`, type: 'dwarf', orbit: 100 + i * 50, moons: i < 5 ? [{ name: `M${i}` }] : [] }));
    const r = ok(JSON.stringify({ bodies: planets }));
    expect(r.map.bodies.length).toBe(MAX_BODIES);
    expect(r.map.bodies.every(b => b.parent === 'sun')).toBe(true);
    expect(r.notes.find(n => n.code === 'overCap')?.n).toBe(25);
  });

  it('reads sectors in AU or map units, and reports dropped ones', () => {
    const r = ok(JSON.stringify({
      bodies: [{ name: 'A', orbit: 1, type: 'planet' }],
      regions: [{ name: 'Inner', from: 0.3, to: 2 }, { name: 'Outer', from: 2, to: 10 }, { name: 'Overlap', from: 3, to: 4 }],
    }));
    expect(r.map.sectors.map(s => [s.name, s.inner, s.outer])).toEqual([['Inner', 112, 744], ['Outer', 744, 3720]]);
    expect(r.notes.find(n => n.code === 'sectorsDropped')?.n).toBe(1);
  });

  it('strips invisible characters and caps text, like every map', () => {
    const r = ok(JSON.stringify({ name: 'Bad‮name', bodies: [{ name: 'X​'.repeat(40), lore: 'y'.repeat(900) }] }));
    expect(r.map.name).toBe('Badname');
    expect(r.map.bodies[0].name.length).toBeLessThanOrEqual(24);
    expect(r.map.bodies[0].lore?.length).toBeLessThanOrEqual(200);
  });
});

describe('the AI prompt', () => {
  it('has an example the importer reads with no notes and no blockers', () => {
    const prompt = buildAiPrompt();
    const example = prompt.slice(prompt.indexOf('EXAMPLE'));
    const r = ok(example);
    expect(r.notes).toEqual([]);
    expect(r.map.bodies.length).toBe(6);
    expect(checkMap(r.map).filter(i => i.level !== 'ok').map(i => i.code)).toEqual([]);
  });
  it('the whole prompt, pasted back by mistake, still reads as the example', () => {
    const r = ok(buildAiPrompt());
    expect(r.map.name).toBe('Ember Reach');
  });
});

describe('export file names', () => {
  it('are safe and recognisable', () => {
    expect(exportFileName(normalizeMap({ name: 'Ação: Nova/Lua!' }))).toBe('acao-novalua.orbital-map.json');
    expect(exportFileName(normalizeMap({ name: '!!!' }))).toBe('map.orbital-map.json');
  });
});
