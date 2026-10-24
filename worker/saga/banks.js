// ============================================================================
// saga/banks.js — every hand-written sentence the Saga Engine can say.
//
// Templates are functions of a context; prose.js walks them so no line
// repeats inside a film and neighbouring films enter each bank at different
// points. The empires' OWN words (bills, bios, the public channel) never live
// here: they come from the dossier and are shown as typed.
//
// Voice: a war epic's narrator, dry, the Herald's register. Hints are TRUE
// at the moment they describe and pay off later (Lorne, 2026-10-24: "It can
// tease, they all know who won"). Every claim a template makes about a
// number is checked by the context it is given (see prose.overclaims).
// ============================================================================

// THE CRAWL lives in crawlBanks.js (it is the biggest bank by far).
export * from './crawlBanks.js';

// ---------------------------------------------------------------------------
// THE CAST
// ---------------------------------------------------------------------------

/** Each role's name on screen. */
export const ROLE_LABEL = {
  hegemon: 'THE HEGEMON', upstart: 'THE UPSTART', champion: 'THE CHAMPION', comeback: 'THE COMEBACK',
  fallenFavourite: 'THE FALLEN FAVOURITE', oathbreaker: 'THE OATHBREAKER', besieged: 'THE BESIEGED',
  fallingStar: 'THE FALLING STAR', zealots: 'THE ZEALOTS', conqueror: 'THE CONQUEROR',
  kingmaker: 'THE KINGMAKER', merchantPrince: 'THE MERCHANT PRINCE', patron: 'THE PATRON',
  abdicator: 'THE ABDICATOR', monsterSlayer: 'THE MONSTER-SLAYER', builder: 'THE BUILDER',
  dissenter: 'THE DISSENTER', diplomat: 'THE DIPLOMAT', graveyard: 'THE GRAVEYARD',
  firstToFall: 'FIRST TO FALL', collateral: 'THE COLLATERAL', scrapper: 'THE SCRAPPER',
  survivor: 'THE SURVIVOR', silent: 'THE SILENT', contender: 'THE CONTENDER', fallen: 'THE FALLEN',
};

/** Taglines for empires with no bio (the cast card's creed line). */
export const NO_BIO = [
  c => `No word from ${c.a}.`,
  c => `${c.a} declined to comment.`,
  c => `${c.a} keeps its own counsel.`,
  c => `${c.a} would rather not say.`,
];

// ---------------------------------------------------------------------------
// HEADLINES AND BECAUSE-LINES (the lower third of a story scene)
// ---------------------------------------------------------------------------

export const HEAD = {
  betrayal: [
    c => `${c.a} signed, then fired`,
    c => `${c.a} tears up its pact with ${c.b}`,
    c => `The pact with ${c.b} lasts until ${c.a} needs it not to`,
    c => `${c.a} breaks its word to ${c.b}`,
  ],
  war: [
    c => `${c.a} declares war on ${c.b}`,
    c => `${c.a} goes to war with ${c.b}`,
    c => `War: ${c.a} against ${c.b}`,
  ],
  pile: [
    c => `${c.N} empires turn on ${c.b}`,
    c => `Everyone against ${c.b}`,
    c => `${c.b} stands alone against ${c.n}`,
  ],
  fall: [
    c => `${c.a} falls`,
    c => `The end of ${c.a}`,
    c => `${c.a} is gone`,
    c => `Silence where ${c.a} once stood`,
  ],
  fallBy: [
    c => `${c.k} finishes ${c.a}`,
    c => `${c.a} falls to ${c.k}`,
  ],
  law: [
    c => `The Senate passes "${c.title}"`,
    c => `"${c.title}" becomes law`,
    c => `By ${c.yea} votes to ${c.nay}: "${c.title}"`,
  ],
  warLaw: [
    c => `The Senate votes war on ${c.b}`,
    c => `The Senate sends the system to war on ${c.b}`,
  ],
  sphereBegun: [
    c => `${c.a} begins a Dyson Sphere`,
    c => `${c.a} starts building around the sun`,
  ],
  sphereStruck: [
    c => `A last strike on the Sphere at ${c.pct}%`,
    c => `The Sphere under fire at ${c.pct}%`,
  ],
  beastDead: [
    c => `${c.a} kills the Leviathan`,
    c => `The Leviathan dies at ${c.world}`,
  ],
  veteran: [
    c => `Captain ${c.name} goes down with the ${c.ship}`,
    c => `The ${c.ship} is lost, and Captain ${c.name} with her`,
    c => `${c.a} loses Captain ${c.name}`,
  ],
  gift: [
    c => `${c.a} hands ${c.b} ${c.amount}`,
    c => `${c.amount} from ${c.a}, nothing asked back`,
  ],
  sold: [
    c => `${c.a} sells ${c.world} to ${c.b}`,
  ],
  vote: [
    c => `The Senate elects ${c.a}`,
    c => `${c.a} wins the vote`,
  ],
};

export const BECAUSE = {
  pactSigned: [
    c => `They had signed a pact on day ${c.t}.`,
    c => `${c.d} days after they shook on it.`,
    c => `Their pact was ${c.d} days old.`,
  ],
  pactsBrokenToo: [
    c => `${c.n} of them broke a pact to do it.`,
  ],
  killerTook: [
    c => `${c.k} took its last world.`,
    c => `Its last world fell to ${c.k}.`,
  ],
  peakWas: [
    c => `It held ${c.peak} worlds at its height.`,
    c => `${c.Peak} worlds at its height. None now.`,
  ],
  remain: [
    c => `${c.r} remain.`,
  ],
  afterWarVote: [
    c => `${c.d} days after the Senate voted war on it.`,
  ],
  sphereStakes: [
    c => `At 100%, ${c.a} wins the match.`,
    c => `If it is finished, ${c.a} wins.`,
  ],
  sphereNearly: [
    () => 'One strike from the finish line.',
    c => `The shell has held for ${c.d} days.`,
  ],
  beastAte: [
    c => `It had eaten ${c.eaten}.`,
  ],
  beastBy: [
    c => `Killed by the ${c.ship}.`,
  ],
  veteranRecord: [
    c => `${c.days} days in command. ${c.Kills} ${c.killsWord}.`,
    c => `Rank ${c.rank}, ${c.kills} ${c.killsWord}, ${c.days} days in command.`,
  ],
  lawVote: [
    c => `Passed ${c.yea} to ${c.nay}.`,
  ],
  giftBefore: [
    c => `${c.d} days after ${c.b} began its Sphere.`,
  ],
  voteWas: [
    c => `${c.yea} votes for, ${c.nay} against.`,
  ],
};

/** The stat line under each role on the roll call. */
export const RECEIPT = {
  hegemon: c => `Led for ${c.pct}% of the match.`,
  upstart: c => (c.pct > 0 ? `Led for ${c.pct}% of the match. Won it anyway.` : 'Never led on worlds. Won anyway.'),
  champion: c => `Led for ${c.pct}% of the match, and finished it.`,
  comeback: c => `Fell, came back, and won.`,
  fallenFavourite: c => `Led for ${c.pct}% of the match. Did not win.`,
  oathbreaker: c => `Broke ${c.n} pacts to declare war.`,
  besieged: c => (c.betrayed >= 2 ? `Betrayed ${c.betrayed} times.` : `${c.wars} wars declared on it.`),
  fallingStar: c => `${c.peak} worlds at its height, ${c.final} at the end.`,
  zealots: c => `${c.n} of its own ships detonated.`,
  conqueror: c => `Felled ${c.n} empires.`,
  kingmaker: c => `Voted with ${c.w} ${c.k} times out of ${c.n}.`,
  merchantPrince: c => `${c.n} trades, more than any other empire.`,
  patron: c => `Gave ${c.w} ${c.amount}, nothing asked back.`,
  abdicator: c => `Handed ${c.w} ${c.amount}.`,
  monsterSlayer: c => `Killed the Leviathan at ${c.world}.`,
  builder: c => (c.megas ? `${c.megas} megastructures, ${c.terra} worlds terraformed.` : `${c.terra} worlds terraformed.`),
  dissenter: c => `Voted alone against the floor ${c.n} times.`,
  diplomat: c => `Signed ${c.n} pacts.`,
  graveyard: c => `${c.n} captains lost.`,
  firstToFall: c => (c.tied ? `One of two to fall on day ${c.t}.` : `Fell first, on day ${c.t}.`),
  collateral: c => `Never declared a war. Fell on day ${c.t}.`,
  scrapper: c => `Declared ${c.n} ${c.n === 1 ? 'war' : 'wars'}. Fell on day ${c.t}.`,
  survivor: () => 'Never attacked. Still standing.',
  silent: () => 'Nothing in the record.',
  contender: c => `${c.final} worlds at the end.`,
  fallen: c => `Held ${c.peak} worlds. Fell on day ${c.t}.`,
};

/** The kicker over a story scene's headline. */
export const KICKER = {
  betrayal: 'BETRAYAL', war: 'WAR', pile: 'WAR', fall: 'FALLEN', law: 'THE SENATE', warLaw: 'THE SENATE',
  sphereBegun: 'THE GREAT WORK', sphereStruck: 'THE GREAT WORK', beastDead: 'THE LEVIATHAN',
  veteran: 'A VETERAN FALLS', gift: 'FOLLOW THE MONEY', sold: 'FOLLOW THE MONEY', vote: 'THE FINAL VOTE',
};
