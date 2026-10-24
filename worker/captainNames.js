// ============================================================
// captainNames — the default captain name bank + picker.
//
// Unlike SHIP_NAME_POOLS / SETTLEMENT_NAME_POOLS (given+surname or
// place-name style flavor), captains get a whole, memorable name picked
// from one flat pool: "my captain is Naveen Okafor-Lisle", not a
// procedurally-combined given name and surname.
//
// ORIGINAL NAMES ONLY. This pool used to be real characters from Dune,
// Star Wars, Star Trek, The Expanse, Stargate and others (B'Elanna
// Torres, Mace Windu, Lando Calrissian...). A playtester flagged it
// (2026-10-24): those names belong to someone else. Every entry below
// is invented, grouped by the flavour the old sections had, so a fleet
// still reads like classic space opera. Never add a character from an
// existing work here.
//
// NEWLY MINTED CAPTAINS ONLY. Captains already in a game keep the name
// they were given; nothing renames rows in the database.
//
// KEEP IN SYNC: this is the only copy — worker/captains.js is the
// sole caller (captain minting is server-authoritative).
// ============================================================

export const CAPTAIN_NAMES = [
  // Desert dynasties and old houses
  'Idris Valcaran', 'Sorel Valcaran', 'Mirah Valcaran', 'Tamsin Corvaine',
  'Oriel Dunmarch', 'Hesper Kaal', 'Ilyas Qarim', 'Rhoda Venn',
  'Barak Esh-Tali', 'Ysolde Varrin', 'Kesh Amaru', 'Nadir Sarkon',
  'Taveth Morrow', 'Corvan Halleth', 'Ashra Tolven', 'Vashti Orlenne',
  'Orhan', 'Selkie', 'Marrow', 'Tesh',

  // Knights, smugglers and rebels
  'Kael Varro', 'Teyra Solace', 'Joren Vask', 'Mira Calloway',
  'Brannoc Hale', 'Orrin Dask', 'Lysa Marwen', 'Corwin Stray',
  'Pell Antarro', 'Neva Strand', 'Talon Rusk', 'Imra Vey',
  'Cass Brightwater', 'Rook Danner', 'Severin Ashgrove', 'Ondra Kell',
  'Juno Farrows', 'Ezren Talloway', 'Varis Thorne', 'Quillon',
  'Bram Ostrander', 'Ilka Coil', 'Dorran Vex', 'Halcy Tarn', 'Vessik',

  // Starship officers
  'Eleanor Vance-Okoro', 'Tobias Renn', 'Mariko Hale', 'Desmond Achterberg',
  'Anjali Castellane', 'Lucan Ferro', 'Adaeze Monroe', 'Henrik Solberg',
  'Yusuf Calder', 'Ines Marquand', 'Rowan Ashby', 'Tamar Ilesanmi',
  'Gideon Pryce', 'Sunniva Lund', 'Matteo Qadir', 'Celeste Arunde',
  'Oskar Brightman', 'Nadia Revel', 'Callum Strathe', 'Reiko Danvers',
  'Anselm Ward', 'Lior Benhamou', 'Freya Castellan', 'Teodor Blak',
  'Halvard Moss',

  // Belters, dockhands and ice haulers
  'Naveen Okafor-Lisle', 'Marisol Kettering', 'Dagny Ruiz', 'Tobi Achebe',
  'Rafe Kowalczyk', 'Wenna Sato', 'Lark Medeiros', 'Ozzie Takahara',
  'Bex Nakamura-Reyes', 'Hollis Grange', 'Pia Lindqvist', 'Mags Olawale',
  'Teo Vasquez', 'Ruth Abernathy', 'Jules Szabo',

  // Gate teams and the marines
  'Grace Halvorsen', 'Marcus Delacroix', 'Ada Kinsella', 'Bellamy Stroud',
  'Owen Thackeray', 'Dana Whitlock', 'Silas Okonkwo', 'Harriet Vale',
  'Conrad Ibsen', 'Mae Torrance', 'Royce Gallard', 'Nell Pemberton',
  'Ike Mbeki', 'Ruthanne Cole', 'Wes Harrigan',

  // Frontier crews, fleet admirals and far voyagers
  'Augustin Rhee', 'Leonora Quist', 'Cyra Valdane', 'Emeric Lowe',
  'Saul Bannerjee', 'Ottilie March', 'Teodora Inglis',
  'Jonah Cutter', 'Wren Halloway', 'Abel Quarry', 'Sable Morrow',
  'Hatch Merriwether', 'Dot Kincaid', 'Faye Dunleavy',
  'Vera Okonedo', 'Lucius Brandt',
  'Corin Aldane', 'Mercer Vail', 'Anouk Sterling',
  'Zara Quell', 'Bosk', 'Tamsk the Wide', 'Pip Salvage',
  'Ilse Varga', 'Thessaly Rook', 'Oren Vashti',
];

/**
 * Pick a captain name: an unused pool entry, or "<Name> II"/"III"/…
 * once every entry is taken by a living captain (existingNames is
 * scoped to one game, so this only bites in very long-running games).
 */
export function pickCaptainName(rand, existingNames) {
  const available = CAPTAIN_NAMES.filter(n => !existingNames.has(n));
  if (available.length > 0) {
    return available[Math.floor(rand() * available.length)];
  }
  const base = CAPTAIN_NAMES[Math.floor(rand() * CAPTAIN_NAMES.length)];
  const suffixes = ['II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];
  for (const s of suffixes) {
    const candidate = `${base} ${s}`;
    if (!existingNames.has(candidate)) return candidate;
  }
  return `${base} ${Math.floor(rand() * 1000)}`;
}
