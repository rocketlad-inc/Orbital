// ============================================================
// "IN COMBAT" badge — is a hostile really here?
//
// Player report (clownking, 2026-08-13): the fleet tab badged another
// player's corvette "IN COMBAT" while a non-aggression pact was in force
// and nothing was shooting. The screenshot carries the whole diagnosis:
// at Ceres, the OTHER player's ship read IN COMBAT while the reporter's
// own ship at the SAME body read ORBITING. An asymmetric answer to a
// symmetric question.
//
// Cause: hostility was tested against a set of the VIEWER's peace
// partners. You are never in your own peace list, so for any ship you
// don't own, YOUR presence counted as hostile. Third-party treaties were
// invisible for the same reason.
//
// Fixed by testing pairwise against gameState.pactPairs, which the
// server builds from the same treaty query room.js uses to decide
// whether to fire at all.
//
// Since d090f990 ("Combat: war is declared, not assumed") the pairwise
// check is built from gameState.warPairs instead: peace is the default
// and only an open war makes a pair shoot. makePeaceCheck() now takes
// the WAR list, and no data means total peace. The symmetry and
// third-party properties below are unchanged; only the input flipped.
//
// These assertions are all about SYMMETRY and third parties, because
// those are the properties the old shape could not have.
//
// Run: npm run sim:badge
// ============================================================

// Imports the REAL client source. `npm run sim:badge` bundles this file
// with esbuild first so the TypeScript resolves — testing a hand-copied
// mirror of the logic would prove nothing about what ships.
import { makePeaceCheck } from '../src/game/peace';
import { makeHostilesAtBody, makeArmedHostilesAtBody } from '../src/game/systemGrouping';

let failures = 0;
function check(label, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) { failures++; if (detail !== undefined) console.log(`        ${detail}`); }
}

/** Minimal ship the helpers will accept. Corvettes are armed. */
function ship(id, owner, bodyId, cls = 'corvette') {
  return {
    id, name: id, ownedBy: owner, class: cls, parts: [],
    orbit: { parentBodyId: bodyId }, transit: null, hp: 40,
  };
}

const pair = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);

// The screenshot: Ceres holds the reporter's corvette ("Hobby", owned by
// the viewer, so its id is rewritten to the 'player' token) and Rule of
// Rocketlad's corvette ("Friend Maker"). No war between the two (the
// reporter had a NAP; under declared war, any non-warring pair is the
// same case). The viewer IS at war with somebody else, so the peace
// check is a real pairwise test and not the no-data ALWAYS_PEACE.
const CERES = 'ceres';
const ROCKETLAD = 'f_rocketlad';
const ELSEWHERE = 'f_elsewhere';
const ships = [
  ship('hobby', 'player', CERES),
  ship('friend_maker', ROCKETLAD, CERES),
];
const otherWar = [pair('player', ELSEWHERE)];

{
  const atPeace = makePeaceCheck(otherWar);
  const hostiles = makeHostilesAtBody(ships, [], atPeace);
  const armed = makeArmedHostilesAtBody(ships, atPeace);

  // The reported bug, exactly.
  check('NAP partner\'s ship is NOT in combat next to mine',
    hostiles(CERES, ROCKETLAD) === false, 'still reads hostile');
  check('my ship is NOT in combat next to a NAP partner',
    hostiles(CERES, 'player') === false, 'still reads hostile');

  // The signature that made it obvious in the screenshot: two ships at
  // one body disagreeing. Whatever the answer is, it must be the same
  // for both, because "is there a fight at Ceres" has one answer.
  check('both ships at the body agree',
    hostiles(CERES, ROCKETLAD) === hostiles(CERES, 'player'),
    `${hostiles(CERES, ROCKETLAD)} vs ${hostiles(CERES, 'player')}`);
  check('armed-hostile test agrees with itself too',
    armed(CERES, ROCKETLAD) === armed(CERES, 'player'),
    `${armed(CERES, ROCKETLAD)} vs ${armed(CERES, 'player')}`);
}

{
  // At war: the same two ships ARE fighting, and both must say so.
  const atPeace = makePeaceCheck([pair('player', ROCKETLAD)]);
  const hostiles = makeHostilesAtBody(ships, [], atPeace);
  check('at war, both ships read in combat',
    hostiles(CERES, ROCKETLAD) === true && hostiles(CERES, 'player') === true,
    `${hostiles(CERES, ROCKETLAD)} / ${hostiles(CERES, 'player')}`);
}

{
  // THIRD PARTIES — the half of the bug nobody had reported yet.
  // Two rivals share an orbit, not at war with each other, while the
  // viewer is at war with BOTH. Their ships must not read as fighting
  // each other just because the VIEWER is fighting them.
  const A = 'f_a', B = 'f_b';
  const theirs = [ship('a1', A, 'mars'), ship('b1', B, 'mars')];
  const hostiles = makeHostilesAtBody(theirs, [],
    makePeaceCheck([pair('player', A), pair('player', B)]));
  check('two rivals not at war with each other are not fighting',
    hostiles('mars', A) === false && hostiles('mars', B) === false,
    `${hostiles('mars', A)} / ${hostiles('mars', B)}`);
}

{
  // Peace with one neighbour must not make everything peaceful. A real
  // enemy in the same orbit still means a fight for the side at war with
  // it — and ONLY that side: a war is a pair, not a property of a body.
  const enemy = 'f_enemy';
  const crowd = [...ships, ship('raider', enemy, CERES)];
  const hostiles = makeHostilesAtBody(crowd, [], makePeaceCheck([pair('player', enemy)]));
  check('a real enemy in the crowd still reads in combat',
    hostiles(CERES, 'player') === true, `${hostiles(CERES, 'player')}`);
  check('and the enemy sees a fight too',
    hostiles(CERES, enemy) === true, 'enemy reads peaceful');
  check('a bystander not at war with the enemy is not in combat',
    hostiles(CERES, ROCKETLAD) === false, 'bystander reads hostile');
}

{
  // Settlements count as hostile presence for the armed test's sibling.
  // A lone ship over a city it is at war with is in combat; over a
  // city it is not at war with, it is not.
  const lone = [ship('solo', 'player', 'luna')];
  const rivalCity = [{ bodyId: 'luna', ownedBy: 'f_rival' }];
  const quietCity = [{ bodyId: 'luna', ownedBy: ROCKETLAD }];
  const war = makePeaceCheck([pair('player', 'f_rival')]);
  check('over a city you are at war with: in combat',
    makeHostilesAtBody(lone, rivalCity, war)('luna', 'player') === true);
  check('over a city you are not at war with: not in combat',
    makeHostilesAtBody(lone, quietCity, war)('luna', 'player') === false);
}

{
  // A game with no war data at all (fresh game, /state not loaded). Must
  // not throw, and — since war is declared — must read as quiet, not as
  // every neighbour fighting (see ALWAYS_PEACE in src/game/peace.ts).
  const hostiles = makeHostilesAtBody(ships, [], makePeaceCheck(undefined));
  check('no war data: a foreign faction is not hostile',
    hostiles(CERES, 'player') === false, 'reads hostile with no war data');
  const bare = makeHostilesAtBody(ships, []);
  check('omitting the argument entirely defaults to peace',
    bare(CERES, 'player') === false, 'default arg reads hostile');
}

{
  // A ship under burn has left the orbit and cannot be shot at.
  const leaving = [
    ship('hobby', 'player', CERES),
    { ...ship('raider', 'f_enemy', CERES), transit: { currentTransfer: {} } },
  ];
  const hostiles = makeHostilesAtBody(leaving, [], makePeaceCheck([pair('player', 'f_enemy')]));
  check('a ship in transit is not a hostile presence',
    hostiles(CERES, 'player') === false, 'transiting ship still counted');
}

{
  // Does the symmetry assertion above actually discriminate, or would it
  // pass against the broken code too? Reproduce the OLD semantics
  // exactly — "is the other owner in the VIEWER's peace set", ignoring
  // who we're asking about — and confirm the same body gives two
  // different answers. If this block ever stops showing asymmetry, the
  // assertions above have gone vacuous.
  const viewerPeace = new Set([ROCKETLAD]);   // never contains 'player'
  const oldStyle = (o /* other */, _ownedBy) => viewerPeace.has(o);
  const hostiles = makeHostilesAtBody(ships, [], oldStyle);
  check('[regression guard] the old viewer-centric test really was asymmetric',
    hostiles(CERES, ROCKETLAD) === true && hostiles(CERES, 'player') === false,
    `got ${hostiles(CERES, ROCKETLAD)} / ${hostiles(CERES, 'player')}`
    + ' — if these now agree, the tests above prove nothing');
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
