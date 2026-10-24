// ============================================================
// Names in the player's language, at DISPLAY time.
//
// World, settlement, design and ship names are stored in English (the
// catalogue seeds them, the worker composes the defaults). They are ids to
// the game in places (event lines name worlds, the recap matches them in
// text), so they are never rewritten in state. Instead the screens that
// SHOW a name pass it through here:
//
//   bodyName('Ganymede')            -> 'Ganimedes'   (pt-BR)
//   settlementName('Mars Capital')  -> 'Capital de Marte'
//   designName('Default')           -> 'Padrão'
//   shipName('Vanguard of Earth')   -> 'Vanguard da Terra'
//
// Only REAL names have a Portuguese form: the Sol bodies astronomers named
// (Terra, Lua, Júpiter...), and the template words the server builds
// names from ("Capital", "Station", "of", "Gate"). Generated proper names
// (faction names, the city pool, ship class names like "Kestrel", the
// invented far-system worlds) stay as stored, in every language.
// ============================================================

import { getLang, tIn, type Lang } from './core';

/** Sol bodies whose Portuguese name differs from the English one. A name
 *  missing here is the same in both languages (Io, Europa, Ceres...). */
const BODY_PT: Record<string, string> = {
  Mercury: 'Mercúrio',
  Venus: 'Vênus',
  Earth: 'Terra',
  Luna: 'Lua',
  Mars: 'Marte',
  Phobos: 'Fobos',
  Pallas: 'Palas',
  Hygiea: 'Hígia',
  Jupiter: 'Júpiter',
  Ganymede: 'Ganimedes',
  Callisto: 'Calisto',
  Saturn: 'Saturno',
  Enceladus: 'Encélado',
  Rhea: 'Reia',
  Titan: 'Titã',
  Uranus: 'Urano',
  Titania: 'Titânia',
  Neptune: 'Netuno',
  Proteus: 'Proteu',
  Triton: 'Tritão',
  Nereid: 'Nereida',
  Pluto: 'Plutão',
  Charon: 'Caronte',
  Eris: 'Éris',
  Orcus: 'Orco',
  Ixion: 'Íxion',
  Salacia: 'Salácia',
  Actaea: 'Acteia',
  Dysnomia: 'Disnomia',
};

/** Worlds Portuguese names with the article "a" (da Terra, na Lua): every
 *  other world reads "de X". Used where a template says "of <world>". */
const FEMININE_PT = new Set(['Terra', 'Lua']);

/** "de Marte" / "da Terra": the Portuguese "of <world>". */
function ofPlacePt(placePt: string): string {
  return FEMININE_PT.has(placePt) ? `da ${placePt}` : `de ${placePt}`;
}

/** A shown world name as it fills an "of <world>" slot: the name itself in
 *  English ("{name} System"), "da Terra" / "de Urano" in Portuguese, whose
 *  catalog writes "Sistema {name}". `shown` is already in `lang`. */
export function ofPlace(lang: Lang, shown: string): string {
  return lang === 'pt-BR' ? ofPlacePt(shown) : shown;
}

/** A world's name in `lang`. Unknown names (custom maps, invented far
 *  worlds, player-named things) come back untouched. */
export function bodyNameIn(lang: Lang, name: string | null | undefined): string {
  if (name == null) return '';
  if (lang !== 'pt-BR') return name;
  const own = BODY_PT[name];
  if (own) return own;
  // "<World> Gate" (a discovered stargate) and the Sun's own gate.
  if (name === 'Solar Gate') return 'Portal Solar';
  const gate = /^(.+) Gate$/.exec(name);
  if (gate) return `Portal ${ofPlacePt(bodyNameIn(lang, gate[1]))}`;
  const bary = /^(.+) Barycenter$/.exec(name);
  if (bary) return `Baricentro ${ofPlacePt(bodyNameIn(lang, bary[1]))}`;
  return name;
}

/** `bodyNameIn` for the language on screen. Call it while rendering. */
export function bodyName(name: string | null | undefined): string {
  return bodyNameIn(getLang(), name);
}

/** A settlement's name in `lang`: the server's default names are
 *  templates ("Station", "New City", "<Faction> Capital", "<World> City 2"),
 *  so their fixed words translate; a name a player typed never matches. */
export function settlementNameIn(lang: Lang, name: string | null | undefined): string {
  if (name == null) return '';
  if (lang !== 'pt-BR') return name;
  if (name === 'Station') return tIn(lang, 'data.settlement.station.name');
  if (name === 'City') return tIn(lang, 'data.settlement.city.name');
  if (name === 'New City') return 'Nova Cidade';
  const cap = /^(.+) Capital$/.exec(name);
  if (cap) return `Capital ${ofPlacePt(bodyNameIn(lang, cap[1]))}`;
  const placed = /^(.+) (City|Station)( \d+)?$/.exec(name);
  if (placed && BODY_PT[placed[1]] !== undefined) {
    const kind = placed[2] === 'City' ? 'Cidade' : 'Estação';
    return `${kind} ${ofPlacePt(bodyNameIn(lang, placed[1]))}${placed[3] ?? ''}`;
  }
  return name;
}

export function settlementName(name: string | null | undefined): string {
  return settlementNameIn(getLang(), name);
}

/** The seeded standard-issue loadout is stored as "Default" (factions.js,
 *  index.js); a design the player named is theirs and stays as typed. */
export function designNameIn(lang: Lang, name: string | null | undefined): string {
  if (name == null) return '';
  return name === 'Default' ? tIn(lang, 'ship.design.defaultName') : name;
}

export function designName(name: string | null | undefined): string {
  return designNameIn(getLang(), name);
}

/** A ship's name in `lang`. The starter hulls are "<Name> of <World>"
 *  (factions.js STARTER_FLEET); only the "of <World>" half translates. */
export function shipNameIn(lang: Lang, name: string | null | undefined): string {
  if (name == null) return '';
  if (lang !== 'pt-BR') return name;
  const of = /^(\S+) of (.+)$/.exec(name);
  if (of) return `${of[1]} ${ofPlacePt(bodyNameIn(lang, of[2]))}`;
  return name;
}

export function shipName(name: string | null | undefined): string {
  return shipNameIn(getLang(), name);
}
