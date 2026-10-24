// ============================================================================
// saga/crawlBanks.js — the opening crawl's sentences.
//
// Big on purpose: every finished match gets a crawl, players play many
// matches, and the crawl is the first thing a film says. prose.Walker reads
// each bank in windows that tile it film after film, so a narrator line comes
// round again only once the whole bank has been used (sim:saga checks this).
//
// Every line must be TRUE at the start of the match it opens. The board
// lines claim only what the engine checked (a Senate sat, trade moved, gates
// opened, the guns were quiet for a while); a hint is chosen by the role its
// empire turned out to play, and says only what was already so on day one.
// ============================================================================

/** Titles the engine makes when no Senate law will do. */
export const MADE_TITLES = [
  c => `The ${c.world} Affair`,
  c => `Knives at ${c.world}`,
  c => `The Long Night of ${c.world}`,
  c => `What Happened at ${c.world}`,
  c => `The Road to ${c.world}`,
  c => `Fire Over ${c.world}`,
  c => `${c.Days} Days`,
  c => `A Throne at ${c.home}`,
  c => `The ${c.home} Question`,
  c => `Banners Over ${c.world}`,
  () => 'Every World Has a Price',
  c => `The Siege of ${c.world}`,
  c => `Nobody Leaves ${c.world}`,
  c => `The ${c.home} Doctrine`,
  () => 'The Hungry Years',
  () => 'A Crowded Sky',
  c => `Smoke Over ${c.world}`,
  c => `Whoever Holds ${c.world}`,
];
export const MADE_TITLES_FALLEN = [
  c => `The Last Days of ${c.fallen}`,
  c => `After ${c.fallen}`,
  c => `Who Remembers ${c.fallen}?`,
];
export const MADE_TITLES_SPHERE = [
  () => 'A Cage Around the Sun',
  () => 'The Sphere at Sol',
  () => 'The Great Work',
  () => 'Steel Around the Sun',
  () => 'The Builders',
  () => 'Shell Game',
];
export const MADE_TITLES_VOTE = [
  () => 'The Floor Decides',
  () => 'Order in the Senate',
  () => 'By a Show of Hands',
  () => 'The Last Vote',
  () => 'The Chancellor',
  () => 'All in Favour',
];

/** Paragraph one: the board. {n}/{N}: the number of empires in words. */
export const BOARD_OPEN = [
  c => `${c.N} empires share the worlds around Sol.`,
  c => `${c.N} empires have planted their flags around Sol.`,
  c => `Around Sol, ${c.n} empires are dividing up the worlds.`,
  c => `${c.N} empires. One sun. Not nearly enough worlds.`,
  c => `The worlds around Sol belong to ${c.n} empires, for now.`,
  c => `${c.N} empires have come to Sol, and every one of them means to stay.`,
  c => `${c.N} capitals, ${c.n} flags, and one star for all of them.`,
  c => `There are ${c.n} empires in the system, and room for fewer.`,
  c => `${c.N} empires wake up around the same sun.`,
  c => `Sol has ${c.n} new owners, and none of them likes sharing.`,
  c => `${c.N} empires are counting the worlds, and each other.`,
  c => `The system is young, and ${c.n} empires already want it.`,
  c => `From Mercury to the Kuiper belt, ${c.n} empires are laying claims.`,
  c => `${c.N} empires, each sure the system should be theirs.`,
  c => `${c.N} empires have arrived, and the worlds are going fast.`,
  c => `It starts the way it always does: ${c.n} empires, one sun.`,
];
export const BOARD_SENATE = [
  () => 'The Senate has only just met, and every treaty in the system is new.',
  () => 'There is a Senate, and nobody yet knows what it is for.',
  () => 'The Senate is in session. The treaties are still wet.',
  () => 'The Senate has its first laws to write, and no one has broken a pact yet.',
  () => 'A Senate sits over all of them, with no law yet on its books.',
  () => 'The Senate has opened its doors, and every empire has a seat.',
  () => 'The Senate is new, its floor is empty, and every vote is up for grabs.',
  () => 'In the Senate, the speeches have not started yet.',
  () => 'There is a Senate to keep the peace. It has not been tested.',
  () => 'Every empire holds a Senate seat, and nobody has used one yet.',
  () => 'The Senate meets for the first time. It will meet many more.',
  () => 'The chamber is open, and the first bills are being drafted.',
];
export const BOARD_TRADE = [
  () => 'Freighters already run between the worlds, and everything here is for sale.',
  () => 'The trade lanes are open, and metal is worth more than friendship.',
  () => 'Metal flows one way, credits the other, and everyone is counting.',
  () => 'The freighters are out early. So are the prices.',
  () => 'Every world has something to sell, and someone to sell it to.',
  () => 'The markets are open before the guns are.',
  () => 'Credits change hands faster than flags, for now.',
  () => 'Trade comes first. It always does.',
];
export const BOARD_FAR = [
  () => 'Beyond the edge of the system, other suns are waiting.',
  () => 'Past the Kuiper belt, gates to other stars are waiting to open.',
  () => 'At the edge of the map, the gates to other stars are still shut.',
  () => 'Somewhere out past Neptune, the way to other suns lies closed.',
  () => 'Sol is not the only star in reach, though nobody has gone yet.',
  () => 'Far out in the dark, there are other systems to take.',
  () => 'The map does not end at the Kuiper belt, whatever the charts say.',
  () => 'Two more suns wait beyond the gates, for anyone who can reach them.',
];
export const BOARD_QUIET = [
  () => 'Nobody has fired a shot. Nobody expects that to last.',
  () => 'For now, the guns are quiet.',
  () => 'It is peaceful, for the moment.',
  () => 'There is no war yet. There is time for one.',
  () => 'The fleets are in their yards, and the yards are busy.',
  () => 'Everyone is building. Nobody is shooting. It will not stay that way.',
  () => 'The first shot has not been fired.',
  () => 'The peace holds, because nobody is ready to break it.',
];

/** Paragraph two: one hint per featured empire, keyed by its role. {a}. */
export const HINTS = {
  hegemon: [
    c => `${c.a} is already the largest power in the system.`,
    c => `${c.a} is growing faster than anyone can follow.`,
    c => `${c.a} has started early, and it is not slowing down.`,
    c => `${c.a} is out ahead, and it knows it.`,
    c => `${c.a} has the most worlds, and wants more.`,
    c => `${c.a} is already bigger than its neighbours would like.`,
  ],
  hegemonLate: [
    c => `${c.a} is patient.`,
    c => `${c.a} is in no hurry.`,
    c => `${c.a} is taking its time.`,
    c => `${c.a} is not worried about anyone.`,
  ],
  upstart: [
    c => `${c.a} is keeping its head down.`,
    c => `Nobody is watching ${c.a}. They should be.`,
    c => `${c.a} has bigger plans than anyone has noticed.`,
    c => `${c.a} is quiet, and quiet is not the same as weak.`,
    c => `${c.a} is easy to overlook.`,
    c => `${c.a} is not the empire anyone is worried about.`,
    c => `${c.a} is minding its own business, for now.`,
  ],
  champion: [
    c => `${c.a} wants all of it.`,
    c => `${c.a} has come to win.`,
    c => `${c.a} means to finish what it starts.`,
    c => `${c.a} has no intention of coming second.`,
  ],
  comeback: [
    c => `${c.a} will not stay down.`,
    c => `${c.a} is harder to kill than it looks.`,
  ],
  fallenFavourite: [
    c => `${c.a} is settling faster than anyone.`,
    c => `${c.a} looks like the empire to beat.`,
    c => `Everyone is watching ${c.a}.`,
    c => `${c.a} is everyone's favourite.`,
    c => `${c.a} is out in front, and enjoying it.`,
  ],
  oathbreaker: [
    c => `${c.a} is signing pacts with its neighbours.`,
    c => `${c.a} makes friends easily.`,
    c => `${c.a} will sign anything.`,
    c => `${c.a} is generous with its promises.`,
    c => `${c.a} has a treaty for every occasion.`,
  ],
  besieged: [
    c => `${c.a} has more neighbours than friends.`,
    c => `${c.a} is about to find out who its friends are.`,
    c => `${c.a} is standing in everyone's way.`,
    c => `${c.a} has something everyone wants.`,
  ],
  fallingStar: [
    c => `${c.a} is rising fast.`,
    c => `${c.a} is climbing, and it has not looked down.`,
    c => `${c.a} is on its way up.`,
    c => `${c.a} is growing in every direction at once.`,
  ],
  zealots: [
    c => `${c.a}'s crews would rather die than surrender a ship.`,
    c => `${c.a} does not believe in retreat.`,
    c => `${c.a} keeps a charge in every hull.`,
  ],
  conqueror: [
    c => `${c.a} has its eye on its neighbours' worlds.`,
    c => `${c.a} is counting its neighbours' worlds.`,
    c => `${c.a} is building warships, not freighters.`,
    c => `${c.a} is looking for a fight it can win.`,
  ],
  kingmaker: [
    c => `${c.a} has already decided whose side it is on.`,
    c => `${c.a} knows which way the Senate will lean.`,
    c => `${c.a} picks its friends carefully.`,
  ],
  merchantPrince: [
    c => `${c.a} would rather trade than fight.`,
    c => `${c.a} has a price for everything.`,
    c => `${c.a} is open for business.`,
    c => `${c.a} counts in credits, not in hulls.`,
  ],
  patron: [
    c => `${c.a} has more metal than it needs, and a friend who needs it.`,
    c => `${c.a} is generous with its friends.`,
    c => `${c.a} backs the empires it believes in.`,
  ],
  abdicator: [
    c => `${c.a} holds more than it wants.`,
    c => `${c.a} is tired of holding the line.`,
    c => `${c.a} has a great deal to give away.`,
  ],
  monsterSlayer: [
    c => `${c.a} is spoiling for a real fight.`,
    c => `${c.a} has the guns, and is waiting for a target worth them.`,
    c => `${c.a} is looking for something big to shoot at.`,
  ],
  builder: [
    c => `${c.a} wants to build something the system will remember.`,
    c => `${c.a} is building, not fighting.`,
    c => `${c.a} has plans for every world it holds.`,
  ],
  dissenter: [
    c => `${c.a} votes the way it likes.`,
    c => `${c.a} does not follow the crowd.`,
  ],
  diplomat: [
    c => `${c.a} speaks most often of peace.`,
    c => `${c.a} is everyone's friend.`,
    c => `${c.a} has a pact with half the system.`,
  ],
  graveyard: [
    c => `${c.a} is about to spend a great many captains.`,
    c => `${c.a}'s captains are brave. It will cost them.`,
  ],
  silent: [
    c => `${c.a} has not said a word.`,
    c => `${c.a} keeps to itself.`,
  ],
};

/** Paragraph three: the question this kind of match asks. */
export const OMEN = {
  hegemony: [
    () => 'One power is growing too fast. The only question is who will stand against it, and for how long.',
    () => 'One empire is already too big. The rest will have to decide whether to fight it or to kneel.',
    () => 'Someone has to stop the biggest empire in the system. Nobody has volunteered.',
    () => 'The strongest empire in the system is getting stronger. Somebody will have to try.',
    () => 'There is one empire everyone is afraid of, and every reason to be.',
    () => 'The question is not who is ahead. The question is whether anyone can catch it.',
    () => 'Every empire will have to choose: stand in the way, or stand aside.',
    () => 'One flag is spreading faster than all the others put together.',
    () => 'It will take more than one empire to stop what is coming.',
    () => 'The biggest fleet in the system has not lost yet.',
    () => 'One empire means to own the system. The rest have not agreed.',
    () => 'Everyone can see who is winning. Not everyone will accept it.',
  ],
  upset: [
    () => 'The empire everyone is watching will not be the one that wins.',
    () => 'Keep your eye on the favourite. Then look somewhere else.',
    () => 'The winner of this war is not the empire anyone expects.',
    () => 'The empire out in front is not the empire that will finish there.',
    () => 'Being ahead is not the same as winning.',
    () => 'Watch the empire nobody is watching.',
    () => 'The biggest empire in the system will not get the last word.',
    () => 'This war will be won by someone it has not noticed yet.',
    () => 'Everyone knows who will win. Everyone is wrong.',
    () => 'Leading is easy. Finishing is not.',
    () => 'The favourite has every advantage but one.',
    () => 'Somebody is winning quietly.',
  ],
  race: [
    () => 'No empire will stay ahead for long.',
    () => 'The lead will change hands, and change back.',
    () => 'This will be close.',
    () => 'Nobody will run away with this one.',
    () => 'Two empires want the same prize, and only one can have it.',
    () => 'Every lead in this system is temporary.',
    () => 'It will come down to the last days.',
    () => 'The empire in front today will be behind tomorrow.',
    () => 'Nobody here is far enough ahead to relax.',
    () => 'The race is on, and nobody is pulling away.',
    () => 'There is no favourite. There is only the finish.',
    () => 'Whoever wins this will have earned it.',
  ],
};
export const OMEN_EXTRA = {
  vote: [
    () => 'In the end, the Senate will have the last word.',
    () => 'When it is over, it will be over by a vote.',
    () => 'The last battle will be fought on the Senate floor.',
    () => 'The fleets will decide a great deal. The Senate will decide the rest.',
    () => 'It will end with a show of hands.',
    () => 'Before it is done, every empire will have to vote.',
    () => 'The winner will be chosen, not crowned.',
    () => 'In the end, it comes down to who can count votes.',
  ],
  leviathan: [
    () => 'And past the edge of the system, something is moving toward the sun.',
    () => 'And something enormous is on its way.',
    () => 'And far beyond Neptune, something old has woken up.',
    () => 'And none of them has noticed what is coming through the gates.',
    () => 'And something is coming that does not care whose world it eats.',
    () => 'And out in the dark, something very large is hungry.',
    () => 'And the worst thing in the system has not arrived yet.',
    () => 'And something is coming that no single fleet can stop.',
  ],
  purge: [
    c => `${c.Share} of them will not see the end.`,
    c => `${c.Share} of these empires will be gone before it is over.`,
    c => `Not all of them will last. ${c.Share} will not.`,
    c => `When it is over, ${c.share} of these flags will be gone.`,
    c => `${c.Share} of these empires are living on borrowed time.`,
    c => `Count the flags now. ${c.Share} of them will come down.`,
  ],
  sphere: [
    () => 'Before it is over, someone will try to wrap the sun in steel.',
    () => 'Somebody is going to try to build a cage around the sun.',
    () => 'Someone will try to win without winning the war.',
    () => 'One empire will try to build its way to victory.',
    () => 'The sun itself will be the last prize.',
    () => 'Before the end, someone will start building something enormous.',
  ],
  betrayal: [
    () => 'Not every treaty signed here will be kept.',
    () => 'Some of these friendships will not survive.',
    () => 'Some of these pacts are worth less than the paper.',
    () => 'Every empire here has a friend. Not every friend is honest.',
    () => 'The first knife in this war will come from a friend.',
    () => 'Watch the empires that sign the most.',
  ],
  veteran: [
    () => 'Not all of the best captains in the system will come home.',
    () => 'Some of the finest captains in the system are flying their last tours.',
    () => 'Good captains will die here.',
    () => 'The war will cost more than ships.',
  ],
};
