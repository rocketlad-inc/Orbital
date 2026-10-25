// ============================================================================
// saga/arcBanks.js — the words of the season's story (saga/arcs.js).
//
// A space opera narrated like a reality show: it picks a side (the
// protagonist's), it names the villain, it enjoys the betrayals. Every line
// is a template over the record: the empires, worlds, days, ship counts and
// the Senate's own bill titles come from the match, never from here.
//
// Each act has a TITLE (on the act card: "ACT II · THE PILE-ON"), a HEAD
// (the headline) and a BECAUSE (the line under it, the evidence), banked by
// the kind of event the act landed on, with `any` as the fallback. Context:
//   p protagonist   n nemesis   r ringleader   h heir   t turncoat
//   a the act's actor   b its target   world   bill   day   d days since
//   the last act   n0/N0 a count in words   lost  pl/bl ships each side lost
//   peak  final  drop (%)  k leaders  reigns
// ============================================================================

const S = (s) => String(s ?? '').trim();

/** The arc's name, shown with the crawl's credit and in the script read. */
export const ARC_NAME = {
  tallPoppy: 'The Tall Poppy',
  siege: 'Everyone Against One',
  usurper: 'The Usurper',
  duel: 'Two Crowns',
  rebellion: 'The Rebellion',
  thrones: 'Musical Thrones',
  longWar: 'The Long War',
};

// ---------------------------------------------------------------------------
// THE CRAWL'S SETUP: true at the start, paid off by the end
// ---------------------------------------------------------------------------

export const ARC_SETUP = {
  tallPoppy: [
    c => `${c.P} is about to get very big, very fast. Nobody forgives that.`,
    c => `Every war has a favourite. This one's is ${c.P}, and favourites make enemies.`,
    c => `${c.P} will be the biggest empire in the system. That is the problem.`,
  ],
  siege: [
    c => `Soon every empire in the system will want ${c.P} dead. Some of them are its friends.`,
    c => `${c.P} is about to make a lot of enemies, all at once.`,
    c => `By the end, ${c.P} will have been at war with ${c.N0} empires. It only needs to survive them.`,
  ],
  usurper: [
    c => `${c.Nn} has the head start. ${c.P} has patience.`,
    c => `${c.Nn} will lead this war for a long time. ${c.P} is counting the days.`,
    c => `Second place is a fine place to wait. ${c.P} knows it.`,
  ],
  duel: [
    c => `Two empires, ${c.P} and ${c.Nn}, and one crown between them.`,
    c => `${c.P} and ${c.Nn} will pass the lead back and forth like a knife.`,
    c => `There is room at the top for one of ${c.P} and ${c.Nn}. Neither agrees which.`,
  ],
  rebellion: [
    c => `An empire is coming: ${c.Nn}. Someone has to stand in its way. It will be ${c.P}.`,
    c => `${c.Nn} will eat this system world by world. ${c.P} intends to make it choke.`,
    c => `Every empire falls to ${c.Nn} eventually. ${c.P} takes the longest about it.`,
  ],
  thrones: [
    c => `${c.K} empires will wear the crown before this is over. ${c.P} is one of them.`,
    c => `The lead in this war will change hands ${c.reigns} times. Nobody stays on top.`,
    c => `Nobody keeps the lead here for long. ${c.P} will find that out.`,
  ],
  longWar: [
    c => `This is ${c.P}'s war, whatever the others think.`,
    c => `Of all the empires in this system, watch ${c.P}.`,
  ],
};

// ---------------------------------------------------------------------------
// THE ACTS
// ---------------------------------------------------------------------------

export const ACT_TITLE = {
  rise: ['THE RISE', 'TOO BIG, TOO SOON', 'TOP OF THE WORLD'],
  wound: ['THE FIRST WOUND', 'BLOOD IN THE WATER'],
  firstStone: ['THE FIRST STONE', 'SOMEBODY HAD TO'],
  pileOn: ['THE PILE-ON', 'EVERYONE ELSE', 'THE KNIVES COME OUT'],
  fall: ['THE FALL', 'CUT DOWN', 'HOW THE MIGHTY'],
  target: ['THE TARGET', 'A MARK ON ITS BACK'],
  defiance: ['BUILDING ANYWAY', 'DEFIANCE'],
  gang: ['THE GANG', 'THEY COME FOR IT'],
  knife: ['THE KNIFE', 'A FRIEND, BRIEFLY'],
  knifeSenate: ['THE SENATE TURNS', 'BY ORDER OF THE SENATE'],
  siege: ['THE SIEGE', 'HOLD THE LINE'],
  king: ['THE KING', 'THE EARLY LEAD'],
  shadow: ['IN THE SHADOW', 'SECOND PLACE'],
  turn: ['THE TURN', 'THE CROWN CHANGES HANDS'],
  first: ['ROUND ONE', 'THE FIRST CROWN'],
  answer: ['THE ANSWER', 'ROUND TWO'],
  blood: ['BLOOD', 'THE BIG ONE'],
  decider: ['THE DECIDER', 'LAST ROUND'],
  wakes: ['THE EMPIRE', 'THE EMPIRE STIRS'],
  firstFall: ['THE FIRST TO FALL', 'ONE DOWN'],
  anotherFalls: ['ANOTHER ONE', 'THE EMPIRE FEEDS'],
  stand: ['THE STAND', 'THE REBELLION'],
  rebelFalls: ['THE LAST STAND', 'THE REBELLION ENDS'],
  holdout: ['STILL HERE', 'THE HOLDOUT'],
  firstReign: ['THE FIRST CROWN', 'FIRST AMONG MANY'],
  myReign: [c => `${S(c.P).toUpperCase()}'S TURN`, () => 'A TURN AT THE TOP'],
  senate: ['THE SENATE TURNS', 'BY ORDER OF THE SENATE'],
  lastReign: ['THE LAST CROWN', 'ONE MORE TURN'],
  opening: ['THE FIRST SHOT', 'WAR'],
  battle: ['THE BATTLE', 'THE BLOODIEST DAY'],
  ending: ['THE END OF IT', 'THE LAST DAY'],
};

/** Headlines, by act, then by the kind of event it landed on. */
export const ACT_HEAD = {
  rise: {
    lead: [
      c => `${c.P} takes the lead, and everyone notices`,
      c => `${c.P} is the biggest empire in the system. For now.`,
      c => `${c.P} pulls ahead. Nobody claps.`,
      c => `${c.P} takes the lead`,
    ],
  },
  wound: {
    battle: [
      c => `${c.P} bleeds at ${c.world}`,
      c => `${c.world}: ${c.pl} of ${c.P}'s ships do not come home`,
    ],
  },
  firstStone: {
    war_declared: [
      c => `${c.A} throws the first stone at ${c.P}`,
      c => `${c.A} says what everyone is thinking: ${c.P} has to go`,
      c => `${c.A} goes first`,
    ],
  },
  pileOn: {
    senate_vote: [
      c => `The Senate votes war on ${c.P}`,
      c => `The Senate picks a side, and it is not ${c.P}'s`,
    ],
    war_declared: [
      c => `${c.N0cap} empires turn on ${c.P} at once`,
      c => `${c.A} joins the pile on ${c.P}`,
      c => `Everyone wants a piece of ${c.P}`,
      c => `Everyone turns on ${c.P}`,
    ],
  },
  fall: {
    faction_eliminated: [
      c => `${c.P} falls`,
      c => `${c.P} is gone`,
      c => `And then there was no ${c.P}`,
    ],
    battle: [
      c => `${c.P} loses everything at ${c.world}`,
      c => `${c.world} breaks ${c.P}`,
    ],
    settlement_seized: [
      c => `${c.A} takes ${c.world} from ${c.P}`,
      c => `${c.P} loses ${c.world} to ${c.A}`,
      c => `${c.A} takes ${c.world}`,
    ],
    settlement_destroyed: [
      c => `${c.B} burns ${c.P} out of ${c.world}`,
      c => `${c.world} burns, and ${c.P} with it`,
      c => `${c.world} burns`,
    ],
    lead: [
      c => `${c.A} takes the lead from ${c.P}`,
      c => `${c.P} is not the biggest any more`,
      c => `${c.P} loses the lead`,
    ],
  },
  target: {
    dyson_initiated: [
      c => `${c.P} starts building a sphere around the sun`,
      c => `${c.P} reaches for the sun`,
    ],
    lead: [
      c => `${c.P} takes the lead`,
      c => `${c.P} is out in front, where everyone can see it`,
    ],
  },
  defiance: {
    dyson_initiated: [
      c => `At war with half the system, ${c.P} starts building around the sun`,
      c => `${c.P} answers with a Dyson Sphere`,
      c => `${c.P} builds anyway`,
    ],
  },
  gang: {
    war_declared: [
      c => `${c.A} declares war on ${c.P}. It will not be the last.`,
      c => `${c.A} goes first. ${c.N0cap} empires will follow.`,
      c => `${c.A} comes for ${c.P}`,
    ],
  },
  knife: {
    war_declared: [
      c => `${c.A} breaks its pact with ${c.P} and attacks`,
      c => `${c.A} was ${c.P}'s friend. Was.`,
      c => `${c.A} signs with ${c.P}, then fires on it`,
      c => `A friend turns: ${c.A}`,
      c => `${c.A} betrays ${c.P}`,
    ],
    senate_vote: [
      c => `The Senate votes war on ${c.P}`,
      c => `Now the Senate wants ${c.P} gone too`,
    ],
  },
  siege: {
    battle: [
      c => `The siege of ${c.world}`,
      c => `${c.P} holds ${c.world} against ${c.B}`,
      c => `${c.lost} ships go down at ${c.world}`,
    ],
  },
  king: {
    lead: [
      c => `${c.A} takes the lead early`,
      c => `${c.A} leads. ${c.P} waits.`,
      c => `${c.A} leads early`,
    ],
  },
  shadow: {
    war_declared: [
      c => `${c.P} makes its move against ${c.B}`,
      c => `${c.P} stops waiting: war on ${c.B}`,
      c => `${c.P} moves on ${c.B}`,
    ],
    settlement_seized: [
      c => `${c.P} takes ${c.world} from ${c.B}`,
      c => `${c.P} starts collecting worlds: ${c.world}`,
    ],
  },
  turn: {
    battle: [
      c => `${c.P} and ${c.Nn} meet at ${c.world}`,
      c => `${c.world}: where ${c.Nn} lost the crown`,
      c => `The crown changes hands at ${c.world}`,
    ],
    lead: [
      c => `${c.P} overtakes ${c.Nn}`,
      c => `${c.P} is first. ${c.Nn} is not.`,
      c => `${c.P} takes the crown`,
    ],
  },
  first: {
    lead: [
      c => `${c.A} takes the lead`,
      c => `${c.A} goes first. ${c.O} is right behind it.`,
    ],
  },
  answer: {
    lead: [
      c => `${c.A} takes it back from ${c.B}`,
      c => `${c.A} answers ${c.B}`,
      c => `${c.A} answers`,
    ],
  },
  blood: {
    battle: [
      c => `${c.P} and ${c.Nn} at ${c.world}: ${c.lost} ships lost`,
      c => `${c.world}, where ${c.P} and ${c.Nn} stop pretending`,
      c => `Blood at ${c.world}`,
    ],
  },
  decider: {
    lead: [
      c => `${c.A} takes the lead for the last time`,
      c => `${c.A} takes it back, and this time keeps it`,
      c => `${c.A} takes it for good`,
    ],
  },
  wakes: {
    war_declared: [
      c => `${c.Nn} goes to war with ${c.B}`,
      c => `${c.Nn} starts eating its neighbours`,
      c => `${c.Nn} starts to eat`,
    ],
  },
  firstFall: {
    faction_eliminated: [
      c => `${c.A} falls to ${c.Nn}`,
      c => `${c.Nn} swallows ${c.A}`,
    ],
  },
  anotherFalls: {
    faction_eliminated: [
      c => `${c.A} falls to ${c.Nn}`,
      c => `${c.Nn} swallows ${c.A} too`,
    ],
  },
  stand: {
    battle: [
      c => `${c.P} stands against ${c.Nn} at ${c.world}`,
      c => `${c.P} makes ${c.Nn} pay for ${c.world}`,
    ],
    war_declared: [
      c => (c.A === c.P ? `${c.P} picks the fight nobody else will` : `${c.Nn} comes for ${c.P}`),
      c => (c.A === c.P ? `${c.P} declares war on ${c.Nn}` : `${c.P} is next on ${c.Nn}'s list`),
      c => (c.A === c.P ? `${c.P} fights back` : `${c.Nn} turns on ${c.P}`),
    ],
  },
  rebelFalls: {
    faction_eliminated: [
      c => `${c.P} falls`,
      c => `The rebellion ends with ${c.P}`,
    ],
  },
  holdout: {
    settlement_seized: [
      c => `${c.Nn} takes ${c.world}, and ${c.P} is still standing`,
      c => `${c.P} loses ${c.world}. Not everything.`,
    ],
  },
  firstReign: {
    lead: [
      c => `${c.A} takes the first turn at the top`,
      c => `${c.A} leads first. Enjoy it.`,
    ],
  },
  myReign: {
    lead: [
      c => `${c.P} takes its turn at the top`,
      c => `${c.P} leads, which makes it the target`,
      c => `${c.P}'s turn at the top`,
    ],
  },
  senate: {
    senate_vote: [
      c => `The Senate votes war on ${c.P}`,
      c => `The Senate comes for ${c.P}`,
    ],
  },
  lastReign: {
    lead: [
      c => `${c.A} takes the lead. Last of ${c.Kw}.`,
      c => `${c.A} is on top when the music stops`,
      c => `${c.A} has the last turn`,
    ],
  },
  opening: {
    war_declared: [
      c => `${c.A} goes to war with ${c.B}`,
      c => `War: ${c.A} against ${c.B}`,
    ],
  },
  battle: {
    battle: [
      c => `${c.world}: ${c.lost} ships`,
      c => `The battle of ${c.world}`,
    ],
  },
  ending: {
    faction_eliminated: [
      c => `${c.P} falls`,
      c => `${c.P} is gone`,
    ],
  },
};

/** The evidence line under a headline, by the kind of event. */
export const ACT_BECAUSE = {
  // What it held THAT day: its peak may come long after (a claim checked
  // against the day it is made).
  lead: [
    c => (c.held ? `Day ${c.day}: ${c.heldW} worlds, the most in the system.` : `Day ${c.day}.`),
  ],
  leadTaken: [
    c => (c.drop ? `${c.P} has lost ${c.drop}% of its worlds since its peak.` : `Day ${c.day}.`),
  ],
  battle: [
    c => (c.B ? `${c.A} lost ${c.pl} ships there, ${c.B} ${c.bl}.` : `${c.A} lost ${c.pl} of them.`),
  ],
  war_declared: [
    c => (c.d && c.d <= 30 ? `Day ${c.day}, ${c.d} days later.` : `Day ${c.day}.`),
  ],
  broke: [
    c => `The pact did not survive the war. Day ${c.day}.`,
  ],
  brokePile: [
    c => `${c.N0cap} empires against one, and one of them was a friend.`,
    c => `${c.N0cap} empires at war with it. This one had signed a pact.`,
  ],
  pile: [
    c => `${c.N0cap} empires against one.`,
  ],
  senate_vote: [
    c => (c.bill ? `"${c.bill}" — proposed by ${c.A}.` : `Proposed by ${c.A}.`),
  ],
  faction_eliminated: [
    c => (c.peak ? `From ${c.peakW} ${c.peak === 1 ? 'world' : 'worlds'} to none.${c.B ? ` ${c.B} landed the last blow.` : ''}` : `${c.B ? `${c.B} landed the last blow.` : `Day ${c.day}.`}`),
  ],
  settlement_seized: [
    c => `Day ${c.day}.`,
  ],
  settlement_destroyed: [
    c => `Day ${c.day}.`,
  ],
  dyson_initiated: [
    c => (c.d ? `${c.d} days after the first declaration of war on it.` : 'Finish it and the war is over. Everyone can count.'),
  ],
};

/** The finale's line, under the winner. */
export const ARC_FINALE = {
  tallPoppy: [
    c => (c.H ? `${c.P} was the biggest. ${c.H} is the last.` : `${c.P} was the biggest. It did not last.`),
    c => (c.H ? `The tall poppy is cut down. ${c.H} takes what it left.` : `The tall poppy is cut down.`),
  ],
  siege: [
    c => `Everyone came for ${c.P}. ${c.P} is still here.`,
    c => `${c.N0cap} empires went to war with ${c.P}. It won anyway.`,
  ],
  usurper: [
    c => `${c.Nn} led for most of it. ${c.P} led at the end.`,
    c => `Second for most of the war. First when it counted.`,
  ],
  duel: [
    c => `${c.reigns} changes at the top. One winner.`,
    c => (c.H ? `${c.P} and ${c.Nn} fought for the crown. ${c.H} took it.` : `${c.P} and ${c.Nn} fought for the crown to the last day.`),
  ],
  rebellion: [
    c => (c.fell ? `${c.Nn} took the system. ${c.P} made it pay for every world.` : `${c.Nn} took the system. ${c.P} never let it have all of it.`),
    c => `The Empire won. The rebellion is the part worth remembering.`,
  ],
  thrones: [
    c => `${c.Kcap} empires wore the crown. ${c.H || c.P} keeps it.`,
    c => `Everyone had a turn. ${c.H || c.P} had the last one.`,
  ],
  longWar: [
    () => '',
  ],
};

// ---------------------------------------------------------------------------
// THE PARTS: every empire's label and the record behind it
// ---------------------------------------------------------------------------

export const PART_LABEL = {
  'lead:tallPoppy': 'THE TALL POPPY',
  'lead:siege': 'THE BESIEGED',
  'lead:usurper': 'THE USURPER',
  'lead:duel': 'THE CHALLENGER',
  'lead:rebellion': 'THE REBEL',
  'lead:thrones': 'THE PRETENDER',
  'lead:longWar': 'THE STAR',
  nemesis: 'THE NEMESIS',
  'nemesis:usurper': 'THE KING',
  'nemesis:duel': 'THE RIVAL',
  'nemesis:rebellion': 'THE EMPIRE',
  ringleader: 'THE RINGLEADER',
  turncoat: 'THE TURNCOAT',
  heir: 'THE HEIR',
  lieutenant: 'THE LIEUTENANT',
  monsterSlayer: 'THE MONSTER-SLAYER',
  scavenger: 'THE SCAVENGER',
  martyr: 'THE MARTYR',
  kingmaker: 'THE KINGMAKER',
  rebel: 'THE LAST REBEL',
  fallen: 'THE FALLEN',
  ghost: 'THE GHOST',
  contender: 'THE CONTENDER',
};

/** The receipt: one line of record per part. Context per empire. */
export const PART_RECEIPT = {
  'lead:tallPoppy': c => (c.fell ? `${c.peakW} worlds at its height, day ${c.peakT}. None at the end.`
    : `${c.peakW} worlds at its height, day ${c.peakT}. ${c.finalW} at the end.`),
  'lead:siege': c => `${S(c.warsOnW).replace(/^./, x => x.toUpperCase())} empires declared war on it${c.betrayed ? `, ${c.betrayedW} of them breaking a pact` : ''}. It won.`,
  'lead:usurper': c => `${c.r30 === 2 ? 'Second' : `${c.r30W}th`} on day ${c.t30}. First at the end.`,
  'lead:duel': c => `Traded the lead with ${c.Nn} ${c.swaps} times.`,
  'lead:rebellion': c => (c.fell ? `Fought ${c.Nn} until day ${c.fellT}.` : `Fought ${c.Nn}. Still standing.`),
  'lead:thrones': c => (c.ledFrom ? `Led from day ${c.ledFrom}${c.warsOn ? `; ${c.warsOnW} empires declared war on it` : ''}.` : `${c.finalW} worlds at the end.`),
  'lead:longWar': c => (c.fell ? `Fell on day ${c.fellT}.` : `${c.finalW} worlds at the end.`),
  nemesis: c => (c.tookFromP ? `Took ${c.tookFromPW} ${c.tookFromP === 1 ? 'world' : 'worlds'} from ${c.P}.`
    : c.vsP ? `Lost ${c.vsP} ships fighting ${c.P}.` : `Led for ${c.ledPct}% of the war.`),
  'nemesis:usurper': c => `Led for ${c.ledPct}% of the war.`,
  'nemesis:duel': c => `Led for ${c.ledPct}% of the war.`,
  'nemesis:rebellion': c => `Led for ${c.ledPct}% of the war; ${c.felledW} empires fell to it.`,
  ringleader: c => (c.firstOnP ? `First to declare war on ${c.P}, day ${c.firstOnP}.`
    : c.billOnP ? `Proposed "${c.billOnP}".` : `Joined the war on ${c.P}.`),
  turncoat: c => `Broke ${c.brokeW} ${c.broke === 1 ? 'pact' : 'pacts'} to go to war${c.brokeOnP ? `, ${c.P}'s among them` : ''}.`,
  heir: c => (c.ledPct >= 50 ? `Led for ${c.ledPct}% of the war, and won it.`
    : c.ledPct > 0 ? `Led for only ${c.ledPct}% of the war. Won it anyway.` : 'Never led. Won anyway.'),
  lieutenant: c => `Fought on ${c.P}'s side.`,
  monsterSlayer: c => `Killed the Leviathan${c.beastWorld ? ` at ${c.beastWorld}` : ''}.`,
  scavenger: c => `Took ${c.scavW} worlds from the fallen.`,
  martyr: c => `First to fall, day ${c.fellT}.`,
  kingmaker: c => `Fought on ${c.H}'s side.`,
  rebel: c => (c.fell ? `Fought on until day ${c.fellT}.` : 'Never stopped fighting.'),
  fallen: c => `Fell on day ${c.fellT}${c.killer ? `, to ${c.killer}` : ''}.`,
  ghost: () => 'Never went to war. Still here.',
  contender: c => `${c.finalW} ${c.final === 1 ? 'world' : 'worlds'} at the end.`,
};
