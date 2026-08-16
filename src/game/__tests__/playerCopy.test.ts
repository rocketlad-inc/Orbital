// PLAYER-FACING COPY MUST NOT NAME SOURCE FILES.
//
// The Mining Rig's blurb ended with "MIRRORS MINE_RATE_PER_TICK in
// worker/room.js" and rendered verbatim in the ship panel — a
// keep-in-sync note for maintainers, sitting in the middle of flavour
// text a player reads. It got there because the natural place to record
// "this number mirrors that one" is right next to the number, and the
// number happened to live inside a string.
//
// The note belongs in a comment. This makes the distinction mechanical
// rather than remembered, across every catalogue that feeds the UI.

import { SHIP_PART_DEFS, ALL_PART_IDS } from '../shipParts';
import { BUILDING_DEFS } from '../settlements';

/** Things that mean "a maintainer wrote this to another maintainer". */
const LEAKS: [RegExp, string][] = [
  [/\bworker\/[a-zA-Z]+\.js\b/, 'names a server source file'],
  [/\bsrc\/[a-zA-Z/]+\.tsx?\b/, 'names a client source file'],
  [/\bMIRRORS?\b/, 'contains a MIRRORS maintenance note'],
  [/\bKEEP IN SYNC\b/i, 'contains a KEEP IN SYNC note'],
  [/\b[A-Z][A-Z0-9]{3,}_[A-Z0-9_]{3,}\b/, 'contains a SCREAMING_SNAKE constant name'],
  [/\bTODO\b|\bFIXME\b|\bXXX\b/, 'contains a TODO/FIXME marker'],
  [/migration \d{4}/i, 'cites a migration number'],
];

function check(label: string, text: string | undefined) {
  if (!text) return;
  for (const [re, why] of LEAKS) {
    expect(`${label}: ${text}`).not.toMatch(
      new RegExp(re.source, re.flags.includes('i') ? 'i' : ''),
    );
    // The assertion above is what fails; `why` documents the intent for
    // whoever reads the failure.
    void why;
  }
}

describe('ship part copy is written for players', () => {
  it.each(ALL_PART_IDS)('%s blurb has no maintainer notes', (id) => {
    const def = SHIP_PART_DEFS[id];
    check(`${id}.name`, def.name);
    check(`${id}.blurb`, def.blurb);
    check(`${id}.techNote`, (def as { techNote?: string }).techNote);
  });
});

describe('building copy is written for players', () => {
  it.each(Object.keys(BUILDING_DEFS))('%s description has no maintainer notes', (kind) => {
    const def = (BUILDING_DEFS as Record<string, {
      displayName?: string; description?: string; effectShort?: string;
    }>)[kind];
    check(`${kind}.displayName`, def.displayName);
    check(`${kind}.description`, def.description);
    check(`${kind}.effectShort`, def.effectShort);
  });
});
