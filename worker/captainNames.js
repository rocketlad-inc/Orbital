// ============================================================
// captainNames — the default captain name bank + picker.
//
// Unlike SHIP_NAME_POOLS / SETTLEMENT_NAME_POOLS (given+surname or
// place-name style flavor), captains are named after specific,
// recognizable characters from classic sci-fi — the point is
// "my captain is Naomi Nagata," not a procedurally-combined given
// name and surname. One flat pool, picked whole.
//
// Drawn from Dune, Star Wars, Star Trek, The Expanse, Stargate, and
// other popular sci-fi (Battlestar Galactica, Firefly, Alien,
// Foundation, Guardians of the Galaxy, Mass Effect) as an homage —
// same register as the ship/settlement banks reusing canonical
// names (Rocinante-era freighter names, Tycho Station, etc).
//
// KEEP IN SYNC: this is the only copy — worker/captains.js is the
// sole caller (captain minting is server-authoritative).
// ============================================================

export const CAPTAIN_NAMES = [
  // Dune
  'Paul Atreides', 'Leto Atreides', 'Jessica Atreides', 'Chani Kynes',
  'Duncan Idaho', 'Gurney Halleck', 'Stilgar', 'Liet-Kynes',
  'Thufir Hawat', 'Alia Atreides', 'Vladimir Harkonnen', 'Feyd-Rautha',
  'Irulan Corrino', 'Margot Fenring', 'Piter De Vries', 'Glossu Rabban',
  'Shaddam Corrino', 'Otheym', 'Korba', 'Farok',

  // Star Wars
  'Luke Skywalker', 'Leia Organa', 'Han Solo', 'Chewbacca',
  'Obi-Wan Kenobi', 'Anakin Skywalker', 'Padmé Amidala', 'Lando Calrissian',
  'Ahsoka Tano', 'Din Djarin', 'Cara Dune', 'Poe Dameron',
  'Rey Skywalker', 'Finn', 'Wedge Antilles', 'Hera Syndulla',
  'Kanan Jarrus', 'Sabine Wren', 'Ezra Bridger', 'Mace Windu',
  'Qui-Gon Jinn', 'Jyn Erso', 'Cassian Andor', 'Wilhuff Tarkin', 'Boba Fett',

  // Star Trek
  'James Kirk', 'Spock', 'Leonard McCoy', 'Jean-Luc Picard',
  'William Riker', 'Data', 'Geordi La Forge', 'Worf',
  'Deanna Troi', 'Beverly Crusher', 'Benjamin Sisko', 'Kira Nerys',
  'Kathryn Janeway', 'Chakotay', 'Tuvok', "B'Elanna Torres",
  'Seven of Nine', 'Jonathan Archer', "T'Pol", 'Christopher Pike',
  'Una Chin-Riley', 'Nyota Uhura', 'Hikaru Sulu', 'Pavel Chekov',
  'Montgomery Scott',

  // The Expanse
  'James Holden', 'Naomi Nagata', 'Amos Burton', 'Alex Kamal',
  'Bobbie Draper', 'Chrisjen Avasarala', 'Josephus Miller', 'Camina Drummer',
  'Klaes Ashford', 'Fred Johnson', 'Anderson Dawes', 'Michio Pa',
  'Clarissa Mao', 'Praxidike Meng', 'Emily Santos',

  // Stargate
  "Jack O'Neill", 'Samantha Carter', 'Daniel Jackson', "Teal'c",
  'George Hammond', 'Cameron Mitchell', 'Vala Mal Doran', 'John Sheppard',
  'Elizabeth Weir', 'Rodney McKay', 'Teyla Emmagan', 'Ronon Dex',
  'Hank Landry', 'Janet Fraiser', 'Walter Harriman',

  // Other popular sci-fi — Battlestar Galactica, Firefly, Alien,
  // Foundation, Guardians of the Galaxy, Mass Effect
  'William Adama', 'Laura Roslin', 'Kara Thrace', 'Lee Adama',
  'Saul Tigh', 'Gaius Baltar', 'Sharon Valerii',
  'Malcolm Reynolds', 'Zoe Washburne', 'Hoban Washburne', 'Inara Serra',
  'Jayne Cobb', 'River Tam', 'Kaylee Frye',
  'Ellen Ripley', 'Dwayne Hicks',
  'Hari Seldon', 'Salvor Hardin', 'Gaal Dornick',
  'Peter Quill', 'Gamora', 'Drax the Destroyer', 'Rocket Raccoon',
  'Garrus Vakarian', 'Tali Zorah', "Liara T'Soni",
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
