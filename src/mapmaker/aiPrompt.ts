// The prompt a player copies into any AI chat to get a map back. Built
// from the format's own constants, so the limits it states are the ones
// the importer and the server enforce. It is for the AI, so it stays in
// English; it asks for names and lore in the player's own language.

import { MAP_SECRETS, MAX_BODIES, MAX_SECTORS, ORBIT_LIMITS, RESOURCE_MAX, SURFACES, TEXT_LIMITS, TYPE_INFO, BACKDROPS } from '../game/customMap';
import type { CustomMap, MapBodyType } from '../game/customMap';

const EXAMPLE = {
  name: 'Ember Reach',
  blurb: 'Two warm worlds, one cold giant, and a rich belt everyone will want.',
  sun: { name: 'Ember', color: '#ffb26b', size: 55, mass: 1 },
  settings: { backdrop: 'amber' },
  sectors: [
    { name: 'The Hearth', inner: 100, outer: 330 },
    { name: 'The Tide', inner: 330, outer: 900 },
    { name: 'The Cold', inner: 900, outer: 3000 },
  ],
  bodies: [
    {
      id: 'cinder', name: 'Cinder', type: 'terrestrial', parent: 'sun', orbit: 240, angle: 0.4, radius: 3,
      surface: 'desert', yields: { metal: 3, credits: 4, science: 3 }, start: true,
      lore: 'Glass dunes that sing at dawn.',
    },
    {
      id: 'hollow', name: 'Hollow', type: 'moon', parent: 'cinder', orbit: 22, angle: 2.1, radius: 1.5,
      surface: 'barren', yields: { metal: 2, credits: 1, science: 2 },
      secret: 'ancient_databank', secretName: 'The Quiet Archive', secretText: 'Row on row of crystal, still humming.',
    },
    {
      id: 'tamar', name: 'Tamar', type: 'terrestrial', parent: 'sun', orbit: 410, angle: 3.5, radius: 3,
      surface: 'ocean', yields: { metal: 2, credits: 3, science: 4 }, start: true,
    },
    { id: 'shard', name: 'Shard', type: 'asteroid', parent: 'sun', orbit: 620, angle: 5.0, radius: 0.7, yields: { metal: 8, credits: 2, science: 0 } },
    { id: 'gold1', name: 'Gilt Rock', type: 'rock', parent: 'sun', orbit: 640, angle: 1.2, mineral: { kind: 'gold', tons: 1500 } },
    {
      id: 'vast', name: 'Vast', type: 'gas-giant', parent: 'sun', orbit: 1400, angle: 4.4, radius: 8, rings: true,
      surface: 'storm', yields: { metal: 1, credits: 9, science: 2 },
    },
  ],
};

const TYPE_LINES: Record<MapBodyType, string> = {
  terrestrial: 'a rocky planet; players can start here',
  'gas-giant': 'big, rich in credits, holds many moons; nobody starts here',
  'ice-giant': 'cold giant, good science; nobody starts here',
  dwarf: 'small world; players can start here',
  moon: 'orbits a planet, gas giant, ice giant or dwarf (set parent to its id); players can start here',
  asteroid: 'tiny, usually metal-rich; nobody starts here',
  rock: 'a mineable meteoroid: no yields, holds a mineral stock instead',
};

/** The prompt. With `current`, it asks the AI to change that map rather
 *  than invent one (ids kept, so the editor's selection still matches). */
export function buildAiPrompt(current?: CustomMap): string {
  const types = (Object.keys(TYPE_INFO) as MapBodyType[])
    .map(k => `  - "${k}": ${TYPE_LINES[k]}. radius ${TYPE_INFO[k].radius[0]}–${TYPE_INFO[k].radius[1]} (typical ${TYPE_INFO[k].radius[2]})`)
    .join('\n');
  return `You are designing a star system for Orbital, a multiplayer space strategy game. Players each start on one world, then expand, trade, research and fight for the rest.

${current ? `MY CHANGES: [describe what to change in my map below]

Reply with the WHOLE changed map as ONE JSON object and nothing else: no explanation, no comments. Keep the ids of worlds you keep. Write new names and lore in the same language as my request.` : `MY IDEA: [describe your system here: a theme, how many players, what should make it interesting]

Reply with ONE JSON object and nothing else: no explanation, no comments. Write names and lore in the same language as my idea.`}

FORMAT
{
  "name": map name (max 40 characters),
  "blurb": one or two sentences pitching the map (max ${TEXT_LIMITS.blurb} characters),
  "sun": { "name", "color" (hex like "#ffd180"), "size" (30–90, ours is 50), "mass" (0.4–2.5, ours is 1) },
  "settings": { "backdrop": one of ${BACKDROPS.map(b => `"${b}"`).join(', ')} },
  "sectors": optional orbit bands for the senate: [{ "name", "inner", "outer" }], up to ${MAX_SECTORS}, outward, not overlapping,
  "bodies": [ ... up to ${MAX_BODIES} ... ]
}

EACH BODY
  "id": short lowercase letters/digits, unique (max 12),
  "name": max 24 characters,
  "type": one of the types below,
  "parent": "sun", or a moon's planet id,
  "orbit": distance from its parent in map units (see SCALE),
  "angle": where on its orbit, in radians 0–6.28 (spread worlds out),
  "radius": size, inside its type's range,
  "surface": one of ${SURFACES.map(s => `"${s}"`).join(', ')},
  "yields": { "metal", "credits", "science" }: whole numbers 0–${RESOURCE_MAX} per tick,
  "rings": true for a ringed planet (optional),
  "start": true where a player may start (optional; terrestrial, moon or dwarf only),
  "lore": one line of flavour (optional, max ${TEXT_LIMITS.lore} characters),
  "secret": a hidden discovery (optional): ${MAP_SECRETS.map(s => `"${s}"`).join(', ')}, or "random",
  "secretName" / "secretText": that discovery's own title and message (optional),
  "mineral": rocks only: { "kind": "metal" or "gold", "tons": 200–5000 }

TYPES
${types}

SCALE (map units, NOT AU or km)
  - Worlds round the sun: orbit ${ORBIT_LIMITS.sun[0]}–${ORBIT_LIMITS.sun[1]}. In our Solar System Mercury is 144, Earth 372, Mars 566, the asteroid belt about 720, Jupiter 920, Saturn 1686, Neptune 3000, Pluto 3800.
  - Moons round their planet: orbit ${ORBIT_LIMITS.moon[0]}–${ORBIT_LIMITS.moon[1]}. Our Moon is 20, Jupiter's moons 22–75.
  - Keep neighbours' orbits clearly apart, and keep a moon outside its planet's radius.

BALANCE
  - Sizes: Earth radius 3, Mars 2.5, our Moon 1.5, Jupiter 8.
  - Our Solar System's yields are small: most worlds 0–9 of each. Earth is metal 2, credits 6, science 3; Jupiter credits 9; a rich asteroid metal 8.
  - Every start world needs science 2 or more, radius 1.5 or more, and each should be about as good as the others. Space starts apart (different orbits, ideally different sectors) and give every player some contested worlds nearby.
  - Mark at least 2 start worlds, one per player you want to seat (up to 10).

${current ? `MY MAP
${JSON.stringify(current)}
` : `EXAMPLE (a small one; make yours fuller)
${JSON.stringify(EXAMPLE, null, 2)}
`}`;
}
