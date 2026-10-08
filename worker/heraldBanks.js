// ============================================================
// HERALD PHRASE BANKS — the frontier desk.
//
// Nine chronicle kinds reached the paper and fell straight through it.
// The digest reads every public row in the window and turns the ones it
// recognises into stories; anything it does not recognise is dropped
// without a word. So a gate flinging a hull across the system, a
// megastructure topping out, a rock aimed at somebody's homeworld — all
// of it happened, was logged, was fetched, and was never printed.
//
// These are the banks for those nine. Same contract as the banks in
// digest.js: an array of functions taking one context object and
// returning a sentence. They live here rather than inline because
// digest.js is already nine thousand lines, and because a bank is data —
// there is nothing to read in it except the writing.
//
// NO HELPERS. Markdown is written out (`**name**`) rather than routed
// through digest's b(), and anything needing formatting arrives already
// formatted on the context. That keeps this file importable from
// anywhere and impossible to break with a signature change.
//
// Headlines are ALL CAPS and carry no markdown — Discord embed titles
// render neither. Every headline bank is drawn from the same cursor
// machinery as the rest of the paper, so an edition never runs the same
// shape twice.
// ============================================================

// ------------------------------------------------------------
// asteroid_launched — a world-sized rock put on a collision course.
// The loudest thing a player can do short of winning, and until now the
// paper only ever reported the impact, never the launch.
// ------------------------------------------------------------

export const ASTEROID_LAUNCHED = [
  c => `**${c.actor}** has taken hold of ${c.rock} and thrown it at ${c.target}. Impact in ${c.eta} ticks.`,
  c => `${c.rock} is no longer on its own orbit. **${c.actor}** has aimed it at ${c.target}, and it arrives in ${c.eta} ticks.`,
  c => `Thrusters fired on ${c.rock} today. Its new heading ends at ${c.target} in ${c.eta} ticks, and **${c.actor}** is not pretending otherwise.`,
  c => `**${c.actor}** has turned ${c.rock} into ordnance. ${c.target} has ${c.eta} ticks to become somewhere else.`,
  c => `There is a rock falling toward ${c.target}. It is called ${c.rock}, it was moved on purpose, and **${c.actor}** moved it.`,
  c => `Observers logged the burn: ${c.rock} under power, bound for ${c.target}, ${c.eta} ticks out. **${c.actor}** has said nothing since.`,
  c => `**${c.actor}** answered the question of what it would take to end this. It takes ${c.rock}, and ${c.eta} ticks.`,
  c => `${c.rock} has been pushed off its lane and onto ${c.target}. Whatever **${c.actor}** wanted, this is the price it named.`,
  c => `The math is public and it is not in dispute: ${c.rock} meets ${c.target} in ${c.eta} ticks, on a course **${c.actor}** chose.`,
  c => `A rock the size of a grievance is on its way to ${c.target}. **${c.actor}** lit the engines ${c.eta} ticks ahead of the ending.`,
  c => `**${c.actor}** has committed ${c.rock} to ${c.target}. There is no abort on a rock — the burn is the whole decision.`,
  c => `Nothing about ${c.rock} was natural today. It turned, it accelerated, and it now ends at ${c.target} in ${c.eta} ticks.`,
  c => `${c.target} is under a countdown. **${c.actor}** started it by putting ${c.rock} on a heading nobody can talk it out of.`,
  c => `Somewhere between a siege and a sentence: **${c.actor}** has aimed ${c.rock} at ${c.target}, arrival ${c.eta} ticks.`,
  c => `The Herald confirmed the trajectory twice because it did not want to print it once. ${c.rock} strikes ${c.target} in ${c.eta} ticks, courtesy of **${c.actor}**.`,
  c => `**${c.actor}** has spent a world to make a point at ${c.target}. ${c.rock} arrives in ${c.eta} ticks to deliver it.`,
  c => `Traffic control has stopped issuing advisories for ${c.rock}. It is not traffic any more; it is **${c.actor}**'s answer to ${c.target}, ${c.eta} ticks out.`,
  c => `${c.rock} was a place once. **${c.actor}** has made it a weapon, and ${c.target} has ${c.eta} ticks of daylight left.`,
  c => `The burn was short and it was enough. ${c.rock} now falls toward ${c.target}; **${c.actor}** will not be talked down inside ${c.eta} ticks.`,
  c => `**${c.actor}** did not declare war on ${c.target}. It simply moved ${c.rock} into the path of one, ${c.eta} ticks ahead.`,
  c => `Every telescope in the system is pointed at the same object tonight: ${c.rock}, under thrust, ${c.eta} ticks from ${c.target}, with **${c.actor}**'s name on the flight plan.`,
  c => `**${c.actor}** has escalated past ships. ${c.rock} is inbound on ${c.target} and the clock reads ${c.eta}.`,
  c => `A course correction of a few degrees, made once, ends a world. **${c.actor}** made it on ${c.rock}; ${c.target} has ${c.eta} ticks.`,
  c => `File it under acts of god if you like — but ${c.rock}'s new heading toward ${c.target} was signed by **${c.actor}**, and it lands in ${c.eta} ticks.`,
];

export const ASTEROID_LAUNCHED_HEADLINE = [
  c => `${c.rockPlain.toUpperCase()} IS FALLING TOWARD ${c.targetPlain.toUpperCase()}`,
  c => `${c.actorPlain.toUpperCase()} AIMS A WORLD AT ${c.targetPlain.toUpperCase()}`,
  c => `${c.eta} TICKS TO ${c.targetPlain.toUpperCase()}`,
  c => `THE ROCK IS UNDER POWER`,
  c => `${c.targetPlain.toUpperCase()} PUT ON A COUNTDOWN`,
  c => `${c.actorPlain.toUpperCase()} THROWS ${c.rockPlain.toUpperCase()}`,
  c => `A COLLISION COURSE, CHOSEN`,
  c => `${c.rockPlain.toUpperCase()} LEAVES ITS ORBIT`,
  c => `SOMETHING VERY LARGE IS COMING FOR ${c.targetPlain.toUpperCase()}`,
  c => `${c.actorPlain.toUpperCase()} ESCALATES PAST SHIPS`,
  c => `NO ABORT ON A ROCK`,
  c => `${c.targetPlain.toUpperCase()} HAS ${c.eta} TICKS`,
  c => `THE HEADING WAS SIGNED`,
  c => `${c.rockPlain.toUpperCase()} REDESIGNATED AS ORDNANCE`,
  c => `WORLD-KILLER INBOUND`,
  c => `${c.actorPlain.toUpperCase()} NAMES ITS PRICE AT ${c.targetPlain.toUpperCase()}`,
];

// ------------------------------------------------------------
// megastructure_complete — a build that held the map's attention for a
// dozen ticks finally switches on.
// ------------------------------------------------------------

export const MEGA_COMPLETE = [
  c => `**${c.actor}**'s ${c.structure} at ${c.where} is finished and live.`,
  c => `The scaffolding is off. ${c.structure} stands complete over ${c.where}, flying **${c.actor}**'s colors.`,
  c => `After a long haul of freight and patience, **${c.actor}** has switched on ${c.structure} at ${c.where}.`,
  c => `${c.structure} came to full power at ${c.where} today. **${c.actor}** owns the only one anybody has finished.`,
  c => `Construction closed out at ${c.where}: ${c.structure}, operational, **${c.actor}**'s.`,
  c => `**${c.actor}** has something at ${c.where} that nobody else has. ${c.structure} is done.`,
  c => `The yards at ${c.where} have gone quiet in the good way — ${c.structure} is complete and drawing power for **${c.actor}**.`,
  c => `Every hauler that fed ${c.where} through the long stretch can stand down. **${c.actor}**'s ${c.structure} is finished.`,
  c => `${c.structure} opened its systems at ${c.where} this cycle. **${c.actor}** has been quiet about what it intends to do with them.`,
  c => `A line of freighters, a great deal of metal, and now a working ${c.structure} at ${c.where} — **${c.actor}** has closed the account.`,
  c => `**${c.actor}** finishes what most factions only budget for: ${c.structure}, complete, at ${c.where}.`,
  c => `The map changed shape at ${c.where} today. ${c.structure} is live and it answers to **${c.actor}**.`,
  c => `Rivals who watched the frame go up at ${c.where} now watch it work. **${c.actor}**'s ${c.structure} is finished.`,
  c => `${c.where} has stopped being a construction site. **${c.actor}**'s ${c.structure} is a going concern.`,
  c => `Final module seated, final check passed: ${c.structure} is operational at ${c.where} under **${c.actor}**.`,
  c => `**${c.actor}** has spent the campaign's largest sum in one place, and ${c.where} now has the ${c.structure} to show for it.`,
  c => `There is a new fixture in the sky over ${c.where}, and **${c.actor}** built it. ${c.structure} is complete.`,
  c => `The Herald has covered ${c.where} as a worksite for some time. It is a facility now — **${c.actor}**'s ${c.structure}, finished.`,
  c => `${c.structure} at ${c.where} passed from ambition to infrastructure today. **${c.actor}** signs the log.`,
  c => `**${c.actor}**'s engineers have handed ${c.structure} over at ${c.where}. Whatever it was built to do, it can now do it.`,
  c => `No ceremony worth the name, but the numbers are in: ${c.structure} complete at ${c.where}, **${c.actor}** presiding.`,
  c => `${c.where} joins the short list of places with a finished megastructure. The owner is **${c.actor}**; the structure is ${c.structure}.`,
];

// ---- A MOBILE MEGASTRUCTURE LEAVES ITS SLIPWAY ------------------------
// Not the same story as MEGA_COMPLETE. A fixed structure that finishes
// switches on where it stands; a Mega Destroyer or Mobile Foundry that
// finishes becomes a HULL, and the news is that it can now go anywhere.
// For the destroyer that means every terraformed world in the system is
// suddenly a question — which is exactly why it is public.
//
// This event was written from the day mobile sites existed and never
// once reached the page: the launch wrote to a table that did not exist,
// and the launch itself was rolling back every tick behind it.
export const MEGA_LAUNCHED = [
  c => `**${c.actor}**'s ${c.structure} has left its slipway at ${c.where}. It is a ship now, and it can go anywhere.`,
  c => `The slipway at ${c.where} is empty. **${c.actor}**'s ${c.structure} is under its own power.`,
  c => `${c.structure} launched from ${c.where} today, flying **${c.actor}**'s colors. Everyone should know where it is.`,
  c => `**${c.actor}** has a ${c.structure} in open space, cast off from ${c.where}. It moves slowly. It does not need to move quickly.`,
  c => `The largest hull in the system cleared its slipway at ${c.where}: **${c.actor}**'s ${c.structure}, now free to manoeuvre.`,
  c => `What was a construction site over ${c.where} this morning is a ship this evening. **${c.actor}** has launched a ${c.structure}.`,
  c => `**${c.actor}** paid for the ${c.structure} a load at a time. Today it paid off: the hull is off the slipway at ${c.where}.`,
  c => `Dockhands at ${c.where} report the slipway clear and the ${c.structure} gone. **${c.actor}** has not said where it is headed.`,
  c => `A ${c.structure} is loose in the system. It belongs to **${c.actor}**, and it left ${c.where} today.`,
  c => `The scaffolding over ${c.where} came down today and the ${c.structure} underneath flew away. **${c.actor}** now owns one of the largest hulls ever built.`,
  c => `**${c.actor}** launched a ${c.structure} from ${c.where}. Its neighbours will be tracking it from now on.`,
  c => `Traffic control at ${c.where} logged one departure of unusual size: **${c.actor}**'s ${c.structure}, outbound.`,
  c => `The ${c.structure} that **${c.actor}** has been building over ${c.where} is finished, crewed, and under way.`,
  c => `A fortune in metal and credit left ${c.where} today in the shape of a ${c.structure}. **${c.actor}** is at the helm.`,
  c => `**${c.actor}**'s ${c.structure} is no longer a project. As of today it is a ship, and it has left ${c.where}.`,
  c => `Freighter crews who hauled for the slipway at ${c.where} watched their work fly off today: **${c.actor}**'s ${c.structure} is launched.`,
  c => `There is a new flagship in the system. **${c.actor}**'s ${c.structure} cast off from ${c.where} and has the whole map to choose from.`,
  c => `The ${c.structure} at ${c.where} was the slowest build in the system. Its launch, by **${c.actor}**, was over in a morning.`,
];
export const MEGA_LAUNCHED_HEADLINE = [
  c => `${c.structurePlain.toUpperCase()} LAUNCHES`,
  c => `${c.actorPlain.toUpperCase()} CASTS OFF AT ${c.wherePlain.toUpperCase()}`,
  c => `THE SLIPWAY AT ${c.wherePlain.toUpperCase()} IS EMPTY`,
  c => `${c.actorPlain.toUpperCase()}'S ${c.structurePlain.toUpperCase()} IS UNDER WAY`,
  c => `A ${c.structurePlain.toUpperCase()} IS LOOSE`,
  c => `${c.wherePlain.toUpperCase()} LAUNCHES A GIANT`,
  c => `${c.actorPlain.toUpperCase()} PUTS ITS ${c.structurePlain.toUpperCase()} TO SEA`,
  c => `OFF THE SLIPWAY AT ${c.wherePlain.toUpperCase()}`,
  c => `THE ${c.structurePlain.toUpperCase()} FLIES`,
  c => `${c.actorPlain.toUpperCase()}'S GIANT LEAVES ${c.wherePlain.toUpperCase()}`,
];

export const MEGA_COMPLETE_HEADLINE = [
  c => `${c.wherePlain.toUpperCase()} SWITCHES ON`,
  c => `${c.actorPlain.toUpperCase()} FINISHES AT ${c.wherePlain.toUpperCase()}`,
  c => `THE SCAFFOLDING COMES OFF`,
  c => `${c.structurePlain.toUpperCase()} IS COMPLETE`,
  c => `${c.actorPlain.toUpperCase()} HAS THE ONLY ONE`,
  c => `${c.wherePlain.toUpperCase()} STOPS BEING A WORKSITE`,
  c => `A LONG ACCOUNT, CLOSED`,
  c => `${c.structurePlain.toUpperCase()} DRAWS POWER`,
  c => `${c.actorPlain.toUpperCase()} FINISHES WHAT IT STARTED`,
  c => `AMBITION BECOMES INFRASTRUCTURE`,
  c => `THE MAP CHANGES SHAPE AT ${c.wherePlain.toUpperCase()}`,
  c => `${c.wherePlain.toUpperCase()} GOES OPERATIONAL`,
  c => `THE FREIGHTERS CAN STAND DOWN`,
  c => `${c.actorPlain.toUpperCase()} TOPS OUT`,
];

// ------------------------------------------------------------
// megastructure_claimed — walking onto a derelict site and putting your
// flag on the half-built frame somebody else paid for.
// ------------------------------------------------------------

export const MEGA_CLAIMED = [
  c => `**${c.actor}** has claimed the ${c.structure} site at ${c.where}.`,
  c => `The frame at ${c.where} has an owner again: **${c.actor}** has taken the ${c.structure} on.`,
  c => `Somebody else drew up ${c.structure} at ${c.where}. **${c.actor}** has claimed it.`,
  c => `**${c.actor}** filed on the abandoned works at ${c.where} and now holds the ${c.structure}.`,
  c => `A derelict no longer — ${c.structure} at ${c.where} passes to **${c.actor}**.`,
  c => `**${c.actor}** picked up ${c.structure} at ${c.where} for the price of showing up.`,
  c => `The unfinished ${c.structure} over ${c.where} flies **${c.actor}**'s colors as of this cycle.`,
  c => `Whatever the last owner meant to build at ${c.where}, **${c.actor}** intends to finish it. The ${c.structure} is claimed.`,
  c => `**${c.actor}** has taken title to the ${c.structure} works at ${c.where}, sunk metal and all.`,
  c => `${c.where}'s idle scaffolding is idle no longer. **${c.actor}** claims the ${c.structure}.`,
  c => `Salvage rights, cheerfully exercised: **${c.actor}** now holds ${c.structure} at ${c.where}.`,
  c => `The ${c.structure} at ${c.where} sat unclaimed long enough for **${c.actor}** to walk onto it.`,
  c => `**${c.actor}** inherits somebody's abandoned ambition at ${c.where}. The ${c.structure} is theirs to finish.`,
  c => `Registry updated at ${c.where}: ${c.structure}, incomplete, now **${c.actor}**'s problem and prize.`,
  c => `A flag went up over the ${c.structure} frame at ${c.where}. It is **${c.actor}**'s.`,
  c => `**${c.actor}** claims ${c.structure} at ${c.where} — the cheapest megastructure anyone will build this campaign.`,
  c => `The half-built ${c.structure} at ${c.where} changed hands without a shot. **${c.actor}** was simply there.`,
  c => `**${c.actor}** has adopted the orphaned ${c.structure} works at ${c.where}.`,
  c => `${c.structure} at ${c.where} is under new management. **${c.actor}** did not have to ask.`,
  c => `The site at ${c.where} went to whoever wanted it enough to file. That was **${c.actor}**, and the ${c.structure} is now theirs.`,
];

export const MEGA_CLAIMED_HEADLINE = [
  c => `${c.wherePlain.toUpperCase()} CHANGES HANDS QUIETLY`,
  c => `${c.actorPlain.toUpperCase()} CLAIMS THE FRAME`,
  c => `A DERELICT, ADOPTED`,
  c => `${c.actorPlain.toUpperCase()} FILES ON ${c.wherePlain.toUpperCase()}`,
  c => `SOMEBODY ELSE'S AMBITION, INHERITED`,
  c => `${c.structurePlain.toUpperCase()} HAS AN OWNER AGAIN`,
  c => `THE CHEAPEST MEGASTRUCTURE OF THE CAMPAIGN`,
  c => `${c.wherePlain.toUpperCase()} UNDER NEW MANAGEMENT`,
  c => `NO SHOT FIRED AT ${c.wherePlain.toUpperCase()}`,
  c => `${c.actorPlain.toUpperCase()} WALKS ONTO A BUILD SITE`,
  c => `SALVAGE RIGHTS EXERCISED`,
  c => `THE FLAG GOES UP AT ${c.wherePlain.toUpperCase()}`,
];

// ------------------------------------------------------------
// megastructure_abandoned — the opposite, and usually the sadder story:
// an owner walking away from a build too big to carry.
// ------------------------------------------------------------

export const MEGA_ABANDONED = [
  c => `**${c.actor}** has walked away from the ${c.structure} at ${c.where}.`,
  c => `Work has stopped at ${c.where}. **${c.actor}** is no longer building the ${c.structure}, and no longer pretending to be.`,
  c => `The ${c.structure} frame at ${c.where} stands abandoned. **${c.actor}** could not carry it.`,
  c => `**${c.actor}** has given up the ${c.structure} works at ${c.where} — a great deal of metal left in the dark.`,
  c => `${c.where}'s scaffolding is empty. **${c.actor}** has abandoned the ${c.structure}.`,
  c => `A megastructure is a promise, and **${c.actor}** has broken this one. ${c.structure} at ${c.where} is derelict.`,
  c => `The freighters stopped coming to ${c.where} some time ago. Today it became official: **${c.actor}** abandons the ${c.structure}.`,
  c => `**${c.actor}** cut its losses at ${c.where}. The unfinished ${c.structure} belongs to whoever wants it.`,
  c => `${c.structure} at ${c.where} joins the list of things this campaign started and did not finish. **${c.actor}** signed off.`,
  c => `Nothing was destroyed at ${c.where}. It was simply left — **${c.actor}**'s ${c.structure}, mid-build, lights out.`,
  c => `**${c.actor}** has released its claim on the ${c.structure} at ${c.where}. The frame stays; the flag comes down.`,
  c => `The ledger finally said no. **${c.actor}** abandons ${c.structure} at ${c.where}.`,
  c => `${c.where} is a monument now rather than a worksite. **${c.actor}** stopped building the ${c.structure}.`,
  c => `Whatever ${c.structure} was going to be for **${c.actor}**, it will not be that. The site at ${c.where} is abandoned.`,
  c => `**${c.actor}** leaves ${c.where} to the vacuum. The half-built ${c.structure} is anyone's for the taking.`,
  c => `A hard call, made late: **${c.actor}** walks off the ${c.structure} at ${c.where}.`,
  c => `The ${c.structure} at ${c.where} outgrew its owner. **${c.actor}** has let it go.`,
  c => `**${c.actor}** has stopped feeding ${c.where}. The ${c.structure} stands, unfinished and unclaimed.`,
];

export const MEGA_ABANDONED_HEADLINE = [
  c => `${c.actorPlain.toUpperCase()} WALKS AWAY FROM ${c.wherePlain.toUpperCase()}`,
  c => `THE LIGHTS GO OUT AT ${c.wherePlain.toUpperCase()}`,
  c => `A PROMISE, BROKEN`,
  c => `${c.structurePlain.toUpperCase()} ABANDONED`,
  c => `${c.wherePlain.toUpperCase()} LEFT TO THE VACUUM`,
  c => `TOO BIG TO CARRY`,
  c => `${c.actorPlain.toUpperCase()} CUTS ITS LOSSES`,
  c => `THE SCAFFOLDING STANDS EMPTY`,
  c => `THE LEDGER SAID NO`,
  c => `${c.wherePlain.toUpperCase()} BECOMES A MONUMENT`,
  c => `ANYONE'S FOR THE TAKING`,
  c => `THE FLAG COMES DOWN AT ${c.wherePlain.toUpperCase()}`,
];

// ------------------------------------------------------------
// asset_sold — a hull or a world handed over for metal and credits,
// delivered by freighter. Commerce, not conquest, and the paper should
// treat it as the oddity it is: territory changing hands by invoice.
// ------------------------------------------------------------

export const ASSET_SOLD = [
  c => `**${c.seller}** has sold ${c.asset} to **${c.buyer}** for ${c.price}.`,
  c => `${c.asset} changed hands today without a shot fired. **${c.buyer}** paid **${c.seller}** ${c.price}.`,
  c => `A bill of sale, not a battle plan: ${c.asset} passes from **${c.seller}** to **${c.buyer}**, ${c.price} settled.`,
  c => `**${c.buyer}** bought ${c.asset} outright. **${c.seller}** took ${c.price} and the paperwork.`,
  c => `The deed to ${c.asset} now reads **${c.buyer}**. The price was ${c.price}, and **${c.seller}** named it.`,
  c => `Commerce succeeded where a fleet would have cost more: **${c.buyer}** takes ${c.asset} from **${c.seller}** for ${c.price}.`,
  c => `**${c.seller}** liquidated ${c.asset} this cycle. **${c.buyer}** was buying, at ${c.price}.`,
  c => `${c.asset} is **${c.buyer}**'s now, bought and paid at ${c.price}. **${c.seller}** has moved on.`,
  c => `Freight, not fire. ${c.asset} transfers to **${c.buyer}**; **${c.seller}** banks ${c.price}.`,
  c => `The Herald notes with some surprise that ${c.asset} was simply purchased. **${c.buyer}** paid **${c.seller}** ${c.price}.`,
  c => `**${c.seller}** decided ${c.asset} was worth more as ${c.price} than as an asset. **${c.buyer}** disagreed, and bought it.`,
  c => `A quiet transaction with loud implications: **${c.buyer}** now holds ${c.asset}, at a cost of ${c.price} to itself and nothing to its fleet.`,
  c => `${c.asset} went to market and did not come back. **${c.buyer}** holds it; **${c.seller}** holds ${c.price}.`,
  c => `**${c.buyer}** has bought its way into ${c.asset}. The seller was **${c.seller}**; the figure was ${c.price}.`,
  c => `Some borders move by war and some by invoice. This one moved by invoice: ${c.asset}, **${c.seller}** to **${c.buyer}**, ${c.price}.`,
  c => `**${c.seller}** has taken ${c.price} for ${c.asset}. Whether that was a bargain is now **${c.buyer}**'s problem.`,
  c => `The freighters carried payment rather than ordnance for once. ${c.asset} is **${c.buyer}**'s, at ${c.price}.`,
  c => `**${c.buyer}** and **${c.seller}** closed on ${c.asset} today — ${c.price}, delivered.`,
  c => `Rivals will read ${c.price} for ${c.asset} as either shrewd or desperate. **${c.seller}** signed it either way.`,
  c => `${c.asset} has a new owner and no new craters. **${c.buyer}** paid **${c.seller}** ${c.price}.`,
];

export const ASSET_SOLD_HEADLINE = [
  c => `${c.assetPlain.toUpperCase()} SOLD`,
  c => `${c.buyerPlain.toUpperCase()} BUYS ${c.assetPlain.toUpperCase()}`,
  c => `A BORDER MOVES BY INVOICE`,
  c => `${c.sellerPlain.toUpperCase()} TAKES THE MONEY`,
  c => `NO SHOT FIRED, NO ASSET KEPT`,
  c => `${c.assetPlain.toUpperCase()} CHANGES HANDS FOR ${c.pricePlain}`,
  c => `COMMERCE, NOT CONQUEST`,
  c => `${c.buyerPlain.toUpperCase()} PAYS ITS WAY IN`,
  c => `THE DEED IS TRANSFERRED`,
  c => `${c.sellerPlain.toUpperCase()} LIQUIDATES`,
  c => `BOUGHT OUTRIGHT`,
  c => `A BILL OF SALE, NOT A BATTLE PLAN`,
];

// ------------------------------------------------------------
// gate_transit — a hull steps into an ancient gate and comes out the
// far side of the system. Back-page colour, but it is the one part of
// the mechanic a player cannot infer from the map.
// ------------------------------------------------------------

export const GATE_TRANSIT = [
  c => `**${c.actor}**'s ${c.ship} entered the gate at ${c.from} and left it at ${c.to}.`,
  c => `The gate at ${c.from} took the ${c.ship} and gave it back at ${c.to}. **${c.actor}** made the crossing look routine.`,
  c => `${c.ship} stepped through at ${c.from} and arrived at ${c.to} without crossing the distance between. **${c.actor}** is using the door.`,
  c => `**${c.actor}** ran the ${c.ship} through the ${c.from} gate today, out at ${c.to}.`,
  c => `A crossing at ${c.from}: the ${c.ship} in, and out again at ${c.to}, flying **${c.actor}**'s colors.`,
  c => `The ancients left a door at ${c.from}. **${c.actor}**'s ${c.ship} used it, and stepped out at ${c.to}.`,
  c => `${c.ship} made the jump from ${c.from} to ${c.to} this cycle. **${c.actor}** did not have to burn for it.`,
  c => `**${c.actor}** shortened the map today. The ${c.ship} went in at ${c.from} and came out at ${c.to}.`,
  c => `No burn, no transit time, no warning: **${c.actor}**'s ${c.ship} at ${c.from}, then at ${c.to}.`,
  c => `Gate traffic at ${c.from} — one hull, the ${c.ship}, bound for ${c.to} under **${c.actor}**.`,
  c => `The ${c.ship} vanished from ${c.from} and turned up at ${c.to}. **${c.actor}** has the gate and knows it.`,
  c => `**${c.actor}** keeps finding uses for the ${c.from} gate. Today it was the ${c.ship}, delivered to ${c.to}.`,
  c => `A distance that costs everyone else a dozen ticks cost **${c.actor}** none. The ${c.ship} crossed from ${c.from} to ${c.to}.`,
  c => `Rivals plotting intercepts against the ${c.ship} may wish to start again — it is at ${c.to} now, via the ${c.from} gate.`,
  c => `${c.from} to ${c.to} in a single step. **${c.actor}**'s ${c.ship} made the crossing.`,
  c => `The gate lit at ${c.from} and dimmed at ${c.to}. Between the two, **${c.actor}**'s ${c.ship}.`,
  c => `**${c.actor}** put the ${c.ship} through the door at ${c.from}. It is at ${c.to} now, and nobody watched it get there.`,
  c => `Whoever built the ${c.from} gate is long gone. **${c.actor}** used it anyway, and the ${c.ship} is at ${c.to}.`,
];

export const GATE_TRANSIT_HEADLINE = [
  c => `A HULL STEPS THROUGH AT ${c.fromPlain.toUpperCase()}`,
  c => `${c.actorPlain.toUpperCase()} USES THE DOOR`,
  c => `${c.fromPlain.toUpperCase()} TO ${c.toPlain.toUpperCase()}, IN ONE STEP`,
  c => `THE GATE LIGHTS AT ${c.fromPlain.toUpperCase()}`,
  c => `NO BURN, NO WARNING`,
  c => `${c.actorPlain.toUpperCase()} SHORTENS THE MAP`,
  c => `GATE TRAFFIC AT ${c.fromPlain.toUpperCase()}`,
  c => `THE CROSSING WAS ROUTINE`,
  c => `${c.toPlain.toUpperCase()} GAINS A VISITOR`,
  c => `PLOT YOUR INTERCEPTS AGAIN`,
];

// ------------------------------------------------------------
// The sun gates (sunGates.js). Four moments, all front page: the omen,
// a gate leaving the Sun, a gate opening, and the first hull through.
// Context: c.gate (the Sol-side name), c.system (where it leads),
// c.wait / c.arrive / c.near where the moment has them, and for the
// first crossing c.actor, c.ship and c.system. c.near can be null.
// ------------------------------------------------------------

const pastNear = (c, pre = ' out past ') => (c.near ? `${pre}${c.near}` : '');

export const SUN_GATE_OMEN = [
  c => `Every observatory in the system turned to the Sun this cycle. Something is coming out of it, and the best estimate gives it ${c.wait} ticks.`,
  c => `The Sun is not behaving. Instruments across the system report a shape rising through the photosphere, due to clear it in ${c.wait} ticks.`,
  c => `Astronomers on every world agree on one thing and nothing else: something strange is emerging from the Sun, and it will be out in ${c.wait} ticks.`,
  c => `A disturbance at the solar surface has every empire's telescopes pointed the same way. Whatever it is, it breaks the surface in ${c.wait} ticks.`,
  c => `No one claims it and no one can explain it. Something is pushing up out of the Sun, and it should be clear within ${c.wait} ticks.`,
  c => `For the first time in living memory the Sun is the news. A mass is rising through it, expected out in ${c.wait} ticks.`,
  c => `The Sun has a passenger. Spectrographs show something solid climbing through the plasma, and it will surface in ${c.wait} ticks.`,
  c => `Every navigator in the system is recalculating. A body is rising out of the Sun on a course nobody plotted, due out in ${c.wait} ticks.`,
  c => `Solar weather offices have stopped issuing forecasts and started issuing warnings: something is emerging from the star, ${c.wait} ticks out.`,
  c => `It began as a dark fleck on the photosphere. It is now a shape, and the shape is rising. Expect it in ${c.wait} ticks.`,
  c => `The oldest question in the system has a new answer pending. Something is coming out of the Sun, and it will be here in ${c.wait} ticks.`,
  c => `Fleet captains report every sensor in the inner system saturated by the same signal. Its source is the Sun; its arrival is ${c.wait} ticks away.`,
  c => `What the Sun is doing has no name in any manual. A structure is surfacing through it, and the count stands at ${c.wait} ticks.`,
  c => `There is something inside the Sun, and it is on its way out. Every empire has ${c.wait} ticks to decide what to do about it.`,
  c => `The photosphere has opened like a wound. Something geometric is rising through it, set to clear the surface in ${c.wait} ticks.`,
  c => `Rival empires did not coordinate, yet every one of them pointed its telescopes at the Sun today. It will give up its secret in ${c.wait} ticks.`,
  c => `The star at the centre of everything is shedding something it has kept since before anyone looked. It will be loose in ${c.wait} ticks.`,
  c => `No fleet moved and no treaty broke, and still the whole system holds its breath. The Sun is opening, and ${c.wait} ticks remain.`,
];
// Any warning after the first: the system has seen this once already.
export const SUN_GATE_OMEN_AGAIN = [
  c => `The Sun is not finished. A second shape is rising through the photosphere where the first gate came from, due out in ${c.wait} ticks.`,
  c => `It is happening again. Observatories that tracked the first gate out of the Sun report another on the way, ${c.wait} ticks from the surface.`,
  c => `Anyone who thought the first gate was the whole story was wrong. Something else is climbing out of the Sun, and it breaks the surface in ${c.wait} ticks.`,
  c => `The star has more to give. A new mass is rising through the Sun on the same path as the last, expected out in ${c.wait} ticks.`,
  c => `Every empire knows the shape of this now, and none of them knows where this one leads. Another gate is surfacing from the Sun in ${c.wait} ticks.`,
  c => `The telescopes never really turned away. They have a second target: something rising out of the Sun, ${c.wait} ticks from open space.`,
  c => `Second verse, same as the first. The Sun is pushing out another arrival, and the count is ${c.wait} ticks.`,
  c => `The first gate was not a fluke. Another is coming out of the Sun, and this time every fleet has ${c.wait} ticks of warning.`,
  c => `Navigators who just finished plotting for one gate are starting over. Something else is emerging from the Sun in ${c.wait} ticks.`,
  c => `Solar offices have reissued the warning they wrote last time, word for word. Another shape, ${c.wait} ticks out.`,
  c => `The Sun keeps its secrets one at a time. The next is rising through the photosphere and will be loose in ${c.wait} ticks.`,
  c => `Whatever sent the first gate out of the Sun is sending another. It clears the surface in ${c.wait} ticks, and its far side is anyone's guess.`,
  c => `A dark fleck has appeared on the photosphere again. Last time it was a door. This one surfaces in ${c.wait} ticks.`,
  c => `The system had one new road. It is about to have two. Something else is rising out of the Sun, ${c.wait} ticks from the surface.`,
  c => `Spectrographs that caught the first gate have caught a second. It is climbing through the plasma, due out in ${c.wait} ticks.`,
  c => `The rush to the first gate is not over and the Sun has already started the next one. ${c.wait} ticks until it surfaces.`,
  c => `It turns out the Sun was carrying more than one passenger. The next is rising now and will be free in ${c.wait} ticks.`,
  c => `Every empire that missed the first gate has a second chance coming. Something is emerging from the Sun again, ${c.wait} ticks out.`,
];
export const SUN_GATE_OMEN_AGAIN_HEADLINE = [
  () => `THE SUN IS NOT DONE`,
  () => `ANOTHER ONE`,
  () => `IT IS HAPPENING AGAIN`,
  () => `A SECOND SHAPE IN THE SUN`,
  c => `${c.wait} TICKS TO THE NEXT`,
  () => `THE STAR HAS MORE TO GIVE`,
  () => `A SECOND CHANCE RISING`,
  () => `TWO ROADS, SOON`,
  () => `SAME SUN, NEW DOOR`,
  () => `NOT A FLUKE`,
];
export const SUN_GATE_OMEN_HEADLINE = [
  () => `SOMETHING IS COMING OUT OF THE SUN`,
  () => `THE SUN STIRS`,
  () => `EVERY TELESCOPE, ONE TARGET`,
  () => `A SHAPE IN THE PHOTOSPHERE`,
  () => `THE STAR IS NOT ALONE`,
  c => `${c.wait} TICKS TO WHATEVER IT IS`,
  () => `THE SUN HAS A PASSENGER`,
  () => `NO MANUAL COVERS THIS`,
  () => `THE OLDEST LIGHT, A NEW SHADOW`,
  () => `ALL EYES SUNWARD`,
];

export const SUN_GATE_EMERGED = [
  c => `It is a gate. It cleared the Sun this cycle and is burning hard for the Far Reach, where it should stop${pastNear(c)} by tick ${c.arrive}. It leads to ${c.system}.`,
  c => `The thing in the Sun was a door. The ${c.gate} is flying outward at a burn no hull can match, bound for the Far Reach${pastNear(c, ' near ')}; the far side opens on ${c.system}.`,
  c => `A gate rose out of the Sun and did not stop to be studied. It is on a hard burn for the edge of the system${pastNear(c, ', somewhere past ')}, and it answers to ${c.system}.`,
  c => `The ${c.gate} has left the Sun. It should come to rest in the Far Reach${pastNear(c, ' beyond ')} at tick ${c.arrive}, and whoever reaches it first will be looking at ${c.system}.`,
  c => `What rose from the Sun is a gate to ${c.system}. It is already climbing toward the Far Reach${pastNear(c, ', aimed somewhere past ')}, and every fleet within reach is doing the same arithmetic.`,
  c => `The wait is over and the answer is a door. The ${c.gate} burst from the Sun and is decelerating toward a stop in the Far Reach at tick ${c.arrive}.`,
  c => `Out of the Sun came something no empire built: a long dark body trailing arms like a squid's, burning outward harder than any warship. It leads to ${c.system} and it stops at tick ${c.arrive}.`,
  c => `The ${c.gate} is loose. Its course runs straight out from the Sun to the Far Reach${pastNear(c)}, and what waits on its other side is ${c.system}.`,
  c => `Every forecast was wrong except the simplest: it was a gate. It is bound for the Far Reach${pastNear(c, ' by ')}, and ${c.system} is through it.`,
  c => `The Sun has given up a gate to ${c.system}. It reaches the Far Reach at tick ${c.arrive}, and the race to meet it began the moment it surfaced.`,
  c => `A gate climbed out of the Sun this cycle, if a gate can swim: a ribbed mantle and a fan of glowing arms, on a burn that left every escort behind. It stops in the Far Reach${pastNear(c)}; the far side is ${c.system}.`,
  c => `The shape in the Sun has a purpose, and the purpose is ${c.system}. The ${c.gate} is braking toward the Far Reach and should hold station by tick ${c.arrive}.`,
  c => `Whatever built it built it to travel, and to look alive doing it. The ${c.gate} crossed out of the Sun mantle first, arms trailing, for the edge of the system${pastNear(c, ', past ')}, door open to ${c.system}.`,
  c => `Not a weapon, not a ship, not quite an animal: a gate shaped like something from a deep ocean, and it is moving. It will stop in the Far Reach at tick ${c.arrive}, one step from ${c.system}.`,
  c => `The Sun opened and a gate came through. Plotted course: the Far Reach${pastNear(c)}. Destination on the far side: ${c.system}.`,
  c => `Strategists who spent the warning arguing over what it might be are now arguing over who reaches its landing site first. It is a gate to ${c.system}, and it arrives at tick ${c.arrive}.`,
  c => `The ${c.gate} is out and burning. It is aimed at the Far Reach${pastNear(c, ' near ')}, and nobody in the system can catch it before it stops.`,
  c => `Every map in the system has a new mark: the ${c.gate}'s landing site, out in the Far Reach where it settles by tick ${c.arrive}. Fleets sent there now will be waiting when ${c.system} opens.`,
];
export const SUN_GATE_EMERGED_HEADLINE = [
  c => `A GATE TO ${c.system.toUpperCase()}`,
  () => `IT WAS A DOOR`,
  c => `THE ${c.gate.toUpperCase()} LEAVES THE SUN`,
  () => `OUT OF THE SUN, BOUND FOR THE EDGE`,
  () => `THE RACE FOR THE FAR REACH`,
  c => `${c.system.toUpperCase()} IS ONE STEP AWAY`,
  () => `THE SUN GIVES UP A GATE`,
  c => `NEXT STOP AT TICK ${c.arrive}`,
  () => `NOBODY BUILT THIS`,
  () => `A DOOR WITH ARMS`,
];

export const SUN_GATE_OPENED = [
  c => `The ${c.gate} has stopped in the Far Reach and is open. A hull parked on it crosses to ${c.system} at a tenth of the burn.`,
  c => `The thing from the Sun came to rest this cycle, curled its arms into a ring and lit. ${c.system} is now a short crossing from the edge of the system for anyone who gets there.`,
  c => `The ${c.gate} is open for business, and it belongs to no one. Park on it and ${c.system} is ten times closer.`,
  c => `The door is open. The ${c.gate} sits in the Far Reach, neutral and unbreakable, and ${c.system} is on the other side.`,
  c => `The ${c.gate} stopped where the forecasts said it would and opened at once. The way to ${c.system} is a crossing now, not a campaign.`,
  c => `The ${c.gate} has settled into orbit at the edge of the system and switched on. ${c.system} is reachable by anyone who can reach it.`,
  c => `It stopped, and it opened. The ${c.gate} now flings any hull that parks on it toward ${c.system} at ten times the speed of flight.`,
  c => `No empire owns the ${c.gate} and no fleet can break it. As of this cycle it is open, and it goes to ${c.system}.`,
  c => `The ${c.gate} has wrapped itself into a ring in the Far Reach, and something in its lit throat looks back. The trip to ${c.system} that took a campaign now takes a fraction of one.`,
  c => `The gate has landed and the door has opened. ${c.system} is through the ${c.gate}, and it costs nothing but the trip to the gate.`,
  c => `Its burn is over and its arms are folded into a ring. The ${c.gate} is open, and ${c.system} is suddenly a neighbour.`,
  c => `The ${c.gate} came to rest in the Far Reach and lit up for every empire alike. Through it: ${c.system}.`,
  c => `There is a new crossroads at the edge of the system. The ${c.gate} is open, and the road runs to ${c.system}.`,
  c => `The ${c.gate} is live. Hulls parked on it can make the crossing to ${c.system} at a tenth of the burn, and every empire knows it.`,
  c => `Whoever gets to the Far Reach first gets ${c.system} first. The ${c.gate} opened this cycle and it is waiting for traffic.`,
  c => `The ${c.gate} has finished its flight and opened its door. ${c.system}, once a voyage, is now an errand.`,
  c => `A gate nobody built and nobody can destroy is now open in the Far Reach. It answers to anyone, and it leads to ${c.system}.`,
  c => `The ${c.gate} stands open. For the price of reaching the Far Reach, any fleet can be at ${c.system} in a tenth of the time.`,
];
export const SUN_GATE_OPENED_HEADLINE = [
  c => `THE ${c.gate.toUpperCase()} IS OPEN`,
  c => `${c.system.toUpperCase()} WITHIN REACH`,
  () => `THE DOOR LIGHTS`,
  () => `NEUTRAL, UNBREAKABLE, OPEN`,
  c => `NEXT STOP: ${c.system.toUpperCase()}`,
  () => `A NEW CROSSROADS AT THE EDGE`,
  () => `THE ARMS CLOSE INTO A RING`,
  c => `${c.system.toUpperCase()} IS AN ERRAND NOW`,
  () => `OPEN TO ALL COMERS`,
  () => `THE FAR REACH HAS A DOOR`,
];

export const SUN_GATE_FIRST = [
  c => `**${c.actor}** was first through. The ${c.ship} entered the ${c.from} and is on its way to ${c.system}.`,
  c => `The first hull to use the ${c.from} flew **${c.actor}**'s colors: the ${c.ship}, bound for ${c.system}.`,
  c => `**${c.actor}** did not wait. The ${c.ship} took the ${c.from} before anyone else and is crossing to ${c.system}.`,
  c => `History records the ${c.ship}. **${c.actor}**'s hull was the first through the ${c.from}, outbound for ${c.system}.`,
  c => `Somebody had to go first, and it was **${c.actor}**. The ${c.ship} launched from the ${c.from} for ${c.system}.`,
  c => `The ${c.from} has its first traveller. **${c.actor}** sent the ${c.ship} through, and it is flying for ${c.system}.`,
  c => `While others were still plotting courses, **${c.actor}** was using the door. The ${c.ship} is through the ${c.from} and bound for ${c.system}.`,
  c => `First through the ${c.from}: the ${c.ship}, under **${c.actor}**, headed for ${c.system}.`,
  c => `**${c.actor}** has put the first hull through the ${c.from}. The ${c.ship} will be the first to see ${c.system} up close.`,
  c => `The ${c.ship} made history this cycle, launching through the ${c.from} toward ${c.system} for **${c.actor}**.`,
  c => `Every empire watched the ${c.from}; **${c.actor}** used it. The ${c.ship} is on its way to ${c.system}.`,
  c => `The race to the gate has a winner. **${c.actor}**'s ${c.ship} launched through the ${c.from} for ${c.system}.`,
  c => `**${c.actor}** planted the first flag on the crossing itself. The ${c.ship} went through the ${c.from}, bound for ${c.system}.`,
  c => `The ${c.from} took its first passenger this cycle: the ${c.ship}, flying **${c.actor}**'s colors to ${c.system}.`,
  c => `It took one hull to prove the gate works, and **${c.actor}** supplied it. The ${c.ship} is crossing to ${c.system}.`,
  c => `**${c.actor}** moved first and moved fast. The ${c.ship} is through the ${c.from} and closing on ${c.system}.`,
  c => `The first wake through the ${c.from} belongs to the ${c.ship}. **${c.actor}** has sent it on to ${c.system}.`,
  c => `Rivals now know where **${c.actor}** is looking. The ${c.ship} was the first through the ${c.from}, and it is bound for ${c.system}.`,
];
export const SUN_GATE_FIRST_HEADLINE = [
  c => `${c.actorPlain.toUpperCase()} FIRST THROUGH`,
  c => `THE ${c.shipPlain.toUpperCase()} GOES FIRST`,
  c => `FIRST CROSSING TO ${c.system.toUpperCase()}`,
  c => `${c.actorPlain.toUpperCase()} TAKES THE DOOR`,
  () => `THE GATE HAS ITS FIRST TRAVELLER`,
  c => `${c.actorPlain.toUpperCase()} WINS THE RACE`,
  c => `BOUND FOR ${c.system.toUpperCase()}`,
  () => `SOMEBODY HAD TO GO FIRST`,
  c => `${c.actorPlain.toUpperCase()} MOVES FIRST`,
  () => `THE FIRST WAKE THROUGH`,
];

// ------------------------------------------------------------
// gate_link_severed — the pact that held a gate pair open has ended,
// and the door has closed. A diplomatic consequence with a physical
// shape, which is exactly the kind of thing a newspaper is for.
// ------------------------------------------------------------

export const GATE_LINK_SEVERED = [
  c => `The gate link between **${c.actor}** and **${c.other}** has gone dark.`,
  c => `**${c.actor}** and **${c.other}** no longer share a door. The link is severed.`,
  c => `A pact ended and a gate closed with it — **${c.actor}** and **${c.other}** are a long burn apart again.`,
  c => `The crossing between **${c.actor}** and **${c.other}** is shut. Whatever agreement held it open no longer does.`,
  c => `Two gates went quiet this cycle. **${c.actor}** and **${c.other}** are back to travelling the hard way.`,
  c => `The door between **${c.actor}** and **${c.other}** has closed, and the map got larger for both of them.`,
  c => `**${c.actor}** and **${c.other}** severed their gate link. Distance has been restored to the relationship.`,
  c => `What diplomacy opened, diplomacy has closed: the **${c.actor}**–**${c.other}** gate link is dead.`,
  c => `The gate pair binding **${c.actor}** to **${c.other}** is offline. Neither side has said which of them pulled the plug.`,
  c => `A shortcut has become a distance again. **${c.actor}** and **${c.other}** no longer share a crossing.`,
  c => `The link is cut. **${c.actor}** and **${c.other}** will burn for every unit between them from here.`,
  c => `**${c.actor}** and **${c.other}** have unstitched the map. Their gate link is severed.`,
  c => `No ceremony, just a dark ring at either end: the **${c.actor}**–**${c.other}** gate is closed.`,
  c => `Fleets that counted on the **${c.actor}**–**${c.other}** crossing will need new plans. It is severed.`,
  c => `The gate link between **${c.actor}** and **${c.other}** lasted exactly as long as the agreement under it.`,
  c => `**${c.actor}** and **${c.other}** are neighbours no longer, in the only sense that mattered. The link is down.`,
  c => `A door closes between **${c.actor}** and **${c.other}**, and the system quietly gets wider.`,
  c => `The severed link between **${c.actor}** and **${c.other}** takes a strategic option off the table for both.`,
];

export const GATE_LINK_SEVERED_HEADLINE = [
  c => `THE DOOR CLOSES`,
  c => `${c.actorPlain.toUpperCase()} AND ${c.otherPlain.toUpperCase()} CUT THE LINK`,
  c => `A SHORTCUT BECOMES A DISTANCE`,
  c => `THE GATE GOES DARK`,
  c => `THE MAP GETS LARGER`,
  c => `WHAT DIPLOMACY OPENED, DIPLOMACY SHUTS`,
  c => `NEIGHBOURS NO LONGER`,
  c => `BURN FOR IT FROM HERE`,
  c => `THE CROSSING IS SHUT`,
  c => `A DARK RING AT EITHER END`,
];

// ------------------------------------------------------------
// senate_reaped — a bill that ran out its clock without reaching a
// vote. The senate's quietest failure and the easiest to miss.
// ------------------------------------------------------------

export const SENATE_REAPED = [
  c => `**${c.actor}**'s bill, ${c.title}, expired without a vote.`,
  c => `${c.title} died on the floor. **${c.actor}** put it up; nobody put it to a vote.`,
  c => `The clock ran out on ${c.title}. **${c.actor}**'s proposal never reached the chamber.`,
  c => `No quorum, no debate, no bill: ${c.title} lapsed today, and **${c.actor}** has nothing to show for it.`,
  c => `**${c.actor}** watched ${c.title} time out unvoted. Silence did the work an opposition would have.`,
  c => `${c.title} has been reaped from the docket. **${c.actor}** may table it again; the senate may ignore it again.`,
  c => `The senate let ${c.title} die by neglect rather than defeat. **${c.actor}** proposed it.`,
  c => `A bill nobody argued against and nobody voted for: ${c.title}, **${c.actor}**'s, expired.`,
  c => `**${c.actor}** loses ${c.title} to the calendar. There was no vote, which is its own kind of answer.`,
  c => `${c.title} sat on the floor until it was no longer on the floor. **${c.actor}** takes the loss.`,
  c => `The chamber declined to notice ${c.title}. **${c.actor}**'s bill has lapsed.`,
  c => `Not defeated — ignored. **${c.actor}**'s ${c.title} expired unvoted.`,
  c => `${c.title} came to nothing without a single hand raised against it. **${c.actor}** has the floor again if it wants it.`,
  c => `**${c.actor}** tabled ${c.title} and the senate tabled its interest. The bill is dead.`,
  c => `The docket is shorter tonight. ${c.title}, proposed by **${c.actor}**, was reaped unvoted.`,
  c => `A proposal is only as strong as the attention it draws, and ${c.title} drew none. **${c.actor}**'s bill is finished.`,
  c => `**${c.actor}**'s ${c.title} timed out. The senate spent its session on other things.`,
  c => `${c.title} expired quietly, which in this chamber counts as a verdict on **${c.actor}**.`,
];

export const SENATE_REAPED_HEADLINE = [
  c => `A BILL DIES OF NEGLECT`,
  c => `${c.actorPlain.toUpperCase()} LOSES TO THE CALENDAR`,
  c => `NOT DEFEATED, IGNORED`,
  c => `THE CLOCK RUNS OUT ON THE FLOOR`,
  c => `NO HAND RAISED EITHER WAY`,
  c => `${c.actorPlain.toUpperCase()}'S PROPOSAL LAPSES`,
  c => `THE DOCKET GETS SHORTER`,
  c => `SILENCE DOES THE WORK`,
  c => `THE CHAMBER DECLINES TO NOTICE`,
  c => `EXPIRED UNVOTED`,
];

// ------------------------------------------------------------
// trade_shipment_lost — cargo destroyed in transit. Somebody's goods,
// somebody else's guns, and a partner left holding an empty manifest.
// ------------------------------------------------------------

export const TRADE_SHIPMENT_LOST = [
  c => `A shipment from **${c.sender}** to **${c.recipient}** was destroyed in transit${c.killerClause}.`,
  c => `**${c.recipient}** will not be receiving ${c.cargo}. The hull carrying it was killed en route${c.killerClause}.`,
  c => `Cargo bound for **${c.recipient}** never arrived — ${c.cargo}, lost with the ship${c.killerClause}.`,
  c => `**${c.sender}** paid the freight and lost the goods. ${c.cargo} destroyed on the run to **${c.recipient}**${c.killerClause}.`,
  c => `The manifest read ${c.cargo}. It reads nothing now: the shipment from **${c.sender}** to **${c.recipient}** is gone${c.killerClause}.`,
  c => `Somebody shot a freighter. **${c.recipient}** is short ${c.cargo} and **${c.sender}** is short a hull${c.killerClause}.`,
  c => `A trade run ended in wreckage today. ${c.cargo} bound for **${c.recipient}** never made the last leg${c.killerClause}.`,
  c => `**${c.sender}**'s obligation to **${c.recipient}** is scattered across a lane somewhere${c.killerClause}. ${c.cargo}, written off.`,
  c => `The lane between **${c.sender}** and **${c.recipient}** is not safe, and ${c.cargo} is the proof${c.killerClause}.`,
  c => `${c.cargo} left **${c.sender}** and did not reach **${c.recipient}**. The hull carrying it was destroyed${c.killerClause}.`,
  c => `An agreement is worth what its freighters survive. **${c.sender}** owes **${c.recipient}** ${c.cargo} again${c.killerClause}.`,
  c => `**${c.recipient}** signed for goods it will never see. ${c.cargo}, lost in transit${c.killerClause}.`,
  c => `The shipment is a debris field. ${c.cargo} from **${c.sender}** to **${c.recipient}**, destroyed${c.killerClause}.`,
  c => `Commerce takes a casualty: ${c.cargo} bound for **${c.recipient}** was killed on the lane${c.killerClause}.`,
  c => `**${c.sender}** dispatched ${c.cargo}. **${c.recipient}** received a report instead${c.killerClause}.`,
  c => `A freighter died doing paperwork's work. ${c.cargo} for **${c.recipient}** is gone${c.killerClause}.`,
  c => `The run from **${c.sender}** to **${c.recipient}** ended early and badly. ${c.cargo} was aboard${c.killerClause}.`,
  c => `Insurance would be a fine idea in this system. **${c.sender}** just lost ${c.cargo} bound for **${c.recipient}**${c.killerClause}.`,
  c => `**${c.recipient}**'s ledger shows a delivery due and a delivery gone. ${c.cargo}, destroyed in transit${c.killerClause}.`,
  c => `Whatever the treaty says, the lane says otherwise. ${c.cargo} from **${c.sender}** never reached **${c.recipient}**${c.killerClause}.`,
];

export const TRADE_SHIPMENT_LOST_HEADLINE = [
  c => `A FREIGHTER DIES ON THE LANE`,
  c => `${c.recipientPlain.toUpperCase()} WILL NOT BE RECEIVING`,
  c => `THE MANIFEST READS NOTHING`,
  c => `COMMERCE TAKES A CASUALTY`,
  c => `${c.senderPlain.toUpperCase()} LOSES THE GOODS AND THE HULL`,
  c => `CARGO SCATTERED ACROSS A LANE`,
  c => `THE LANE IS NOT SAFE`,
  c => `A DELIVERY DUE, A DELIVERY GONE`,
  c => `SIGNED FOR, NEVER SEEN`,
  c => `THE RUN ENDED EARLY AND BADLY`,
  c => `AN AGREEMENT IS WORTH ITS FREIGHTERS`,
  c => `WRITTEN OFF IN TRANSIT`,
];

// ------------------------------------------------------------
// meteoroid_exhausted — a rock worked until there was nothing left in
// it. Small news that a mining faction feels immediately: the hull
// stays, the yield does not.
//
// Found by the coverage guard rather than by reading, which is the
// whole argument for having one: this kind had never reached production
// yet, so no amount of looking at live data would have turned it up.
// ------------------------------------------------------------

export const MINE_EXHAUSTED = [
  c => `**${c.actor}** has worked ${c.rock} out. There is nothing left in it.`,
  c => `${c.rock} is played out. **${c.actor}**'s crews took the last of it this cycle.`,
  c => `The seam at ${c.rock} has run dry under **${c.actor}**.`,
  c => `**${c.actor}** has stripped ${c.rock} to bare rock.`,
  c => `Nothing further comes out of ${c.rock}. **${c.actor}** mined it to exhaustion.`,
  c => `${c.rock} gave up its last load to **${c.actor}** and has no more to give.`,
  c => `A rock stops being an asset when it stops paying. ${c.rock} stopped today, for **${c.actor}**.`,
  c => `**${c.actor}**'s haulers will need a new rock. ${c.rock} is finished.`,
  c => `The last cargo off ${c.rock} has shipped. **${c.actor}** leaves an empty stone behind it.`,
  c => `${c.rock} has been mined out. It was **${c.actor}**'s, and briefly it was worth having.`,
  c => `**${c.actor}** closes the book on ${c.rock} — worked to nothing, cycle by cycle.`,
  c => `There is no more ${c.mineral} in ${c.rock}. **${c.actor}** took all of it.`,
  c => `${c.rock} is spent. Whatever **${c.actor}** built with it is the only trace left.`,
  c => `The workings at ${c.rock} have gone quiet for good. **${c.actor}** got there first and stayed longest.`,
  c => `**${c.actor}** has exhausted ${c.rock}. The hull that emptied it is already looking elsewhere.`,
  c => `A finite thing, finished: ${c.rock} yields nothing more to **${c.actor}**.`,
  c => `${c.rock} has nothing left worth a burn. **${c.actor}** stripped it clean.`,
  c => `**${c.actor}** worked ${c.rock} to the end of it. The rock stays; the reason to visit does not.`,
  c => `Mining logs at ${c.rock} close today. **${c.actor}** took the last of the ${c.mineral}.`,
  c => `${c.rock} is another exhausted stone on a map that is running out of them. **${c.actor}** emptied this one.`,
];

export const MINE_EXHAUSTED_HEADLINE = [
  c => `${c.rockPlain.toUpperCase()} IS PLAYED OUT`,
  c => `${c.actorPlain.toUpperCase()} STRIPS A ROCK CLEAN`,
  c => `THE SEAM RUNS DRY`,
  c => `NOTHING LEFT IN ${c.rockPlain.toUpperCase()}`,
  c => `WORKED TO EXHAUSTION`,
  c => `${c.actorPlain.toUpperCase()} NEEDS A NEW ROCK`,
  c => `THE LAST LOAD SHIPS`,
  c => `A FINITE THING, FINISHED`,
  c => `THE WORKINGS GO QUIET`,
  c => `${c.rockPlain.toUpperCase()} CLOSES ITS LOGS`,
];

// ============================================================
// THE LEVIATHAN (kaiju.js). One story per edition: every moment it had
// in the edition, oldest first, under the latest moment's headline.
// ============================================================

export const KAIJU_OMEN = [
  c => `Observatories pointed at ${c.system} this cycle report movement where none should be: something very large, turning slowly toward the Sun. It is expected to move within ${c.wait} ticks.`,
  c => `The deep scopes have found something alive at ${c.system}. It is enormous, it is awake, and it is facing this way. Forecasters give it ${c.wait} ticks.`,
  c => `A shape the size of a moon has stirred at ${c.system}. Nobody has a name for it yet. The best guess is that it leaves in ${c.wait} ticks, and comes here.`,
  c => `${c.system} is not empty after all. Something there has begun to move, and every long-range instrument in the system has turned to watch it. ${c.wait} ticks, they say.`,
  c => `The second door was supposed to come out of the Sun. Instead the scopes are watching ${c.system}, where something vast is gathering itself. It is due to move in ${c.wait} ticks.`,
  c => `Something at ${c.system} has noticed us. The stirring began this cycle; the launch, if that is the word, is expected in ${c.wait} ticks.`,
  c => `The light from ${c.system} flickered this cycle, as if something passed in front of its stars. Then it moved again. Analysts expect it to set out within ${c.wait} ticks.`,
  c => `Every telescope pointed outward caught the same thing: a long dark shape uncurling at ${c.system}. It has ${c.wait} ticks of stillness left, by the best estimate.`,
  c => `A deep-space survey of ${c.system} has returned one word, repeated: alive. Whatever it is, it is turning toward the Sun, and it moves in ${c.wait} ticks.`,
  c => `The far system called ${c.system} has a resident. It woke this cycle and is orienting on the Sun; observers give it ${c.wait} ticks before it leaves.`,
  c => `Something in ${c.system} is flexing arms longer than a planet is wide. The movement started this cycle. It is expected to launch in ${c.wait} ticks.`,
  c => `There is a heartbeat in the instruments watching ${c.system}: a slow pulse of light from something that was not there yesterday. It moves in ${c.wait} ticks.`,
  c => `The admiralties are asking the astronomers the same question this cycle: what is moving at ${c.system}? Nobody knows. It leaves in ${c.wait} ticks.`,
  c => `A vast silhouette at ${c.system} has begun to turn. It is pointing at the Sun now, and the forecast says it will set off within ${c.wait} ticks.`,
  c => `For the first time since the far systems were charted, something at ${c.system} is moving on its own. It has ${c.wait} ticks, by the scopes' count.`,
  c => `The eyes in ${c.system} opened this cycle. Two lamps, each brighter than a city, now face the Sun. The thing they belong to moves in ${c.wait} ticks.`,
  c => `Long-range sensors report a living mass at ${c.system}, waking and turning sunward. Launch, if it comes, is ${c.wait} ticks out.`,
  c => `It started as a smudge on a plate from ${c.system}. This cycle the smudge moved. It is facing us, and the best guess is ${c.wait} ticks until it comes.`,
];
export const KAIJU_OMEN_HEADLINE = [
  c => `SOMETHING STIRS AT ${c.system.toUpperCase()}`,
  () => `IT IS FACING THIS WAY`,
  c => `${c.wait} TICKS`,
  () => `THE SCOPES SEE A SHAPE`,
  () => `NOT EMPTY AFTER ALL`,
  c => `${c.system.toUpperCase()} HAS A RESIDENT`,
  () => `SOMETHING IS AWAKE`,
  () => `TWO EYES IN THE DARK`,
  () => `THE ASTRONOMERS HAVE NO NAME FOR IT`,
  () => `A HEARTBEAT ON THE PLATES`,
];

export const KAIJU_LAUNCHED = [
  c => `A living thing the size of a moon has left ${c.system} on a 2g burn for the Sun${c.near ? `, aimed at the Far Reach out past ${c.near}` : ''}. It is due at tick ${c.arrive}, it carries a gate, and it eats worlds. Every empire is at war with it.`,
  c => `The Leviathan is coming. It cleared ${c.system} this cycle at two gravities and will reach the edge of the system at tick ${c.arrive}. Its hide is rated at ${c.hp} points. Its appetite: ${c.appetite} worlds.`,
  c => `It has launched. The thing at ${c.system} is now a squid of impossible size on a hard burn toward us, landing at tick ${c.arrive}${c.near ? ` near ${c.near}` : ''}. It eats worlds, starting at the edge and working in.`,
  c => `What the scopes saw stirring has gone to full burn. The Leviathan left ${c.system} at 2g and will stop in the Far Reach at tick ${c.arrive}. Fleets that want to meet it know where to wait.`,
  c => `The second gate is coming after all, in the arms of a monster. The Leviathan launched from ${c.system} this cycle and lands at tick ${c.arrive}. ${c.hp} hit points. It answers to no one and makes no peace.`,
  c => `There is a creature on its way from ${c.system}, and it is not coming to trade. Arrival: tick ${c.arrive}. Its landing site is marked; every admiralty in the system has already looked at it.`,
  c => `The Leviathan is under way. It left ${c.system} on a jet of violet light and will be in the Far Reach at tick ${c.arrive}, with ${c.hp} points of hide between it and anyone who wants it dead.`,
  c => `Launch confirmed. The creature at ${c.system} is crossing the dark at two gravities. Tick ${c.arrive} is when it arrives, and it has come to eat ${c.appetite} worlds.`,
  c => `It is no longer a shape on a plate. The Leviathan left ${c.system} this cycle and is burning for the Sun${c.near ? `, aimed past ${c.near}` : ''}; it arrives at tick ${c.arrive}.`,
  c => `No treaty covers it and no empire owns it. The Leviathan launched from ${c.system} and is due in the Far Reach at tick ${c.arrive}. Every fleet in the system is now at war with the same thing.`,
  c => `A monster is crossing between the stars at two gravities. It left ${c.system} this cycle, it lands at tick ${c.arrive}, and it is carrying the second gate in its arms.`,
  c => `The Leviathan has set out. ${c.hp} points of hide, a 2g burn, and a landing at tick ${c.arrive}. It will take ${c.appetite} worlds before it leaves, from the outside in.`,
  c => `Whatever woke at ${c.system} is coming. It launched this cycle and lands at tick ${c.arrive}${c.near ? `, out past ${c.near}` : ''}. The outer worlds are its first course.`,
  c => `The far system has sent us something. The Leviathan, ${c.hp} points of living hull, left ${c.system} and arrives at tick ${c.arrive}. The landing site is on every map.`,
  c => `It is coming in fast and straight. The Leviathan cleared ${c.system} at two gravities and will stop in the Far Reach at tick ${c.arrive}. There is time to arm, and not much more.`,
  c => `Every empire now shares an enemy. The Leviathan left ${c.system} this cycle; it reaches the edge of the system at tick ${c.arrive}, and it has an appetite of ${c.appetite} worlds.`,
  c => `A squid the size of a moon is crossing the gap from ${c.system}. It lands at tick ${c.arrive}. Fleets gathering at the landing site will be the first to find out what ${c.hp} hit points means.`,
  c => `The Leviathan is in flight. Departure: ${c.system}, this cycle. Arrival: the Far Reach, tick ${c.arrive}. Purpose: to eat worlds, ${c.appetite} of them.`,
];
export const KAIJU_LAUNCHED_HEADLINE = [
  () => `THE LEVIATHAN IS COMING`,
  c => `ARRIVAL AT TICK ${c.arrive}`,
  () => `A MONSTER ON A 2G BURN`,
  c => `${c.hp} HIT POINTS, NO TREATIES`,
  () => `IT EATS WORLDS`,
  c => `LAUNCH FROM ${c.system.toUpperCase()}`,
  () => `EVERY EMPIRE AT WAR WITH ONE THING`,
  () => `THE SECOND GATE RIDES A MONSTER`,
  c => `${c.appetite} WORLDS ON ITS MENU`,
  () => `IT IS IN FLIGHT`,
];

export const KAIJU_ARRIVED = [
  c => `The Leviathan reached the Far Reach this cycle and dropped the ${c.gate} where it stopped. Then it turned, and went for ${c.world}.`,
  c => `It is here. The Leviathan stopped at the edge of the system, left a gate behind it like a shed skin, and set course for ${c.world}.`,
  c => `The creature from ${c.system} has arrived. A gate now sits where it came to rest; the creature itself is already burning for ${c.world}.`,
  c => `The Leviathan made its landing on schedule, uncurled, and left the ${c.gate} hanging in the Far Reach. Its first meal: ${c.world}.`,
  c => `Arrival. The gate is open, and the thing that carried it is hungry. ${c.world} is first.`,
  c => `It came in on time and did not stop to rest. The ${c.gate} is down in the Far Reach and the Leviathan is headed for ${c.world}.`,
  c => `The Leviathan braked into the Far Reach this cycle, let go of the ${c.gate}, and turned toward ${c.world} before the gate had finished lighting.`,
  c => `Landfall, of a kind. The monster is in the system, the ${c.gate} is open behind it, and ${c.world} has just become the most dangerous place to live.`,
  c => `It set the gate down gently, which nobody expected. Then it went for ${c.world}, which everybody did.`,
  c => `The wait is over. The Leviathan is in the Far Reach, the way to ${c.system} is open through the ${c.gate}, and the beast is moving on ${c.world}.`,
  c => `The Leviathan has arrived and it has a target. The ${c.gate} it carried now stands open; ${c.world} is where it is going.`,
  c => `It stopped exactly where the forecasts said. The ${c.gate} unfolded from its arms, and the Leviathan, lighter now, turned for ${c.world}.`,
  c => `The far-side gate is open and the monster that brought it is loose. First on its list: ${c.world}.`,
  c => `The Leviathan is in the system. It dropped the ${c.gate} in the Far Reach and is already burning for ${c.world}, unhurried and enormous.`,
  c => `Contact. The creature from ${c.system} is here, the ${c.gate} is open, and every settlement on ${c.world} has been told it is next.`,
  c => `The Far Reach has a gate and the system has a predator. The Leviathan arrived this cycle and chose ${c.world}.`,
  c => `It came out of the dark between the stars, let the ${c.gate} go, and looked around. Then it went for ${c.world}.`,
  c => `The Leviathan's long flight ended this cycle in the Far Reach. The hunt began a moment later, with ${c.world}.`,
];
export const KAIJU_HUNTING = [
  c => `The Leviathan has turned toward ${c.world}.`,
  c => `Next on its list: ${c.world}.`,
  c => `It is moving again, this time for ${c.world}.`,
  c => `The beast has picked its next world. ${c.world} has until it arrives.`,
  c => `${c.world} is in its path now.`,
  c => `The Leviathan set off for ${c.world}, unhurried and enormous.`,
  c => `It has not finished. ${c.world} is next.`,
  c => `The creature is burning for ${c.world}.`,
  c => `After a moment's stillness the Leviathan turned, and went for ${c.world}.`,
  c => `The next world on its route is ${c.world}.`,
  c => `${c.world} is the Leviathan's new heading.`,
  c => `Its jet lit again, pointed at ${c.world}.`,
  c => `The hunt goes on. The Leviathan is crossing toward ${c.world}.`,
  c => `Whoever holds ground on ${c.world} has been told: it is coming.`,
  c => `It has a new target, and it is ${c.world}.`,
  c => `The Leviathan is on the move once more, heading for ${c.world}.`,
  c => `${c.world} watched it turn this cycle. It is coming that way.`,
  c => `The beast has fixed on ${c.world}.`,
];
export const KAIJU_HUNTING_HEADLINE = [
  c => `IT IS COMING FOR ${c.world.toUpperCase()}`,
  c => `${c.world.toUpperCase()} IS NEXT`,
  () => `THE HUNT BEGINS`,
  () => `THE LEVIATHAN HAS LANDED`,
  () => `IT IS HERE`,
  c => `TARGET: ${c.world.toUpperCase()}`,
  () => `THE BEAST IS LOOSE`,
  c => `A SHADOW OVER ${c.world.toUpperCase()}`,
  () => `IT HAS CHOSEN`,
  () => `THE GATE IS DOWN, THE HUNT IS ON`,
];

export const KAIJU_CHARGING = [
  c => `Over ${c.world} it has begun to wind up. The strike lands at tick ${c.fires}.`,
  c => `The Leviathan has settled over ${c.world} and started to glow. Tick ${c.fires} is when it strikes.`,
  c => `It is charging over ${c.world}. Anyone who means to stop it has until tick ${c.fires}.`,
  c => `${c.world} has a day. The Leviathan is winding up above it, and fires at tick ${c.fires}.`,
  c => `Above ${c.world}, the creature has gone still and bright. That is the wind-up; the strike is at tick ${c.fires}.`,
  c => `The charge over ${c.world} has begun. It ends at tick ${c.fires}, one way or the other.`,
  c => `The Leviathan is parked over ${c.world} with its arms spread and its throat lit. It strikes at tick ${c.fires}.`,
  c => `A ring of violet light is closing around the Leviathan above ${c.world}. When it closes, at tick ${c.fires}, the world pays.`,
  c => `It has stopped moving, which is worse. The Leviathan is charging over ${c.world} and will fire at tick ${c.fires}.`,
  c => `${c.world} is under the gun. The wind-up began this cycle; the strike lands at tick ${c.fires} unless the beast dies first.`,
  c => `The creature hangs over ${c.world}, swelling with light. Tick ${c.fires} is the deadline.`,
  c => `Everyone can see it from here: the Leviathan glowing over ${c.world}, a day from striking. Tick ${c.fires}.`,
  c => `The countdown over ${c.world} has started. It runs out at tick ${c.fires}.`,
  c => `The Leviathan is winding up. ${c.world} has until tick ${c.fires} for somebody to kill it.`,
  c => `Above ${c.world} the monster's photophores have all lit at once. It strikes at tick ${c.fires}.`,
  c => `It is charging over ${c.world} the way a Mega Destroyer does, with the same clock: the strike is at tick ${c.fires}.`,
  c => `A day of warning, and no more. The Leviathan fires on ${c.world} at tick ${c.fires}.`,
  c => `The Leviathan's charge over ${c.world} is visible from every world in the system. It completes at tick ${c.fires}.`,
];
export const KAIJU_CHARGING_HEADLINE = [
  c => `${c.world.toUpperCase()} HAS ONE DAY`,
  c => `STRIKE AT TICK ${c.fires}`,
  () => `IT IS WINDING UP`,
  c => `THE GLOW OVER ${c.world.toUpperCase()}`,
  () => `KILL IT OR LOSE IT`,
  c => `${c.world.toUpperCase()} UNDER THE GUN`,
  () => `THE RING IS CLOSING`,
  () => `A DAY OF WARNING`,
  c => `COUNTDOWN OVER ${c.world.toUpperCase()}`,
  () => `IT HAS STOPPED MOVING`,
];

export const KAIJU_STRIPPED = [
  c => `The first strike landed. ${c.world} is barren again${c.lost ? `, and ${c.lost} settlement${c.lost === 1 ? '' : 's'} died with its biosphere` : ''}. The Leviathan is winding up for the second.`,
  c => `${c.world} lost everything living this cycle${c.lost ? `, ${c.lost} settlement${c.lost === 1 ? '' : 's'} included` : ''}. The creature did not leave. It is charging again.`,
  c => `The Leviathan stripped ${c.world} to rock. It is still there, and it is winding up again: this is a double tap.`,
  c => `What took years to grow on ${c.world} took one strike to undo. The beast is already charging the second.`,
  c => `The air over ${c.world} is gone. The Leviathan burned it off in one strike, and it has started on the next.`,
  c => `${c.world} is a dead world now${c.lost ? `, with ${c.lost} settlement${c.lost === 1 ? '' : 's'} lost` : ''}. The second strike, the one that breaks it, is already charging.`,
  c => `First barrel: ${c.world}'s biosphere, gone. Second barrel: charging now.`,
  c => `The oceans of ${c.world} boiled away this cycle under the Leviathan's strike. It has not moved off. It is winding up again.`,
  c => `${c.world} was a living world at the start of the cycle. It is bare stone now, and the Leviathan is not finished with it.`,
  c => `The green is gone from ${c.world}. The creature that took it is still overhead, charging the strike that will take the rest.`,
  c => `One strike, one dead biosphere. ${c.world} has a day before the Leviathan comes back for the rock itself.`,
  c => `The Leviathan's first strike on ${c.world} landed${c.lost ? ` and took ${c.lost} settlement${c.lost === 1 ? '' : 's'} with it` : ''}. The second is on the clock.`,
  c => `${c.world} has been sterilised from orbit by a living thing. The thing is winding up to finish the job.`,
  c => `The terraforming on ${c.world} is undone. The Leviathan is charging over it again; this time it means to break the world.`,
  c => `It took the life off ${c.world} first. It is taking a day to gather itself for the world.`,
  c => `Ash where there were forests on ${c.world}. The beast above it has started the second wind-up.`,
  c => `${c.world} is barren, and the Leviathan is still there. Anyone who wants to save the rock has one more day.`,
  c => `The first half of the Leviathan's double tap has landed on ${c.world}. The second half is a day away.`,
];
export const KAIJU_STRIPPED_HEADLINE = [
  c => `${c.world.toUpperCase()} STRIPPED`,
  () => `THE FIRST BARREL`,
  () => `IT IS CHARGING AGAIN`,
  c => `A DEAD SKY OVER ${c.world.toUpperCase()}`,
  c => `${c.world.toUpperCase()} IS BARE STONE`,
  () => `THE DOUBLE TAP BEGINS`,
  () => `ONE STRIKE DOWN, ONE TO GO`,
  c => `ASH ON ${c.world.toUpperCase()}`,
  () => `THE BIOSPHERE IS GONE`,
  () => `IT HAS NOT FINISHED`,
];

export const KAIJU_BROKEN = [
  c => `${c.world} is gone. The Leviathan broke it apart this cycle${c.lost ? `, with ${c.lost} settlement${c.lost === 1 ? '' : 's'} on it` : ''}; what is left is a debris field.`,
  c => `The strike landed and ${c.world} came apart. It is rubble now, and it no longer counts as a world.`,
  c => `The Leviathan has eaten ${c.world}. A debris field holds its orbit${c.lost ? `, and ${c.lost} settlement${c.lost === 1 ? ' is' : 's are'} lost` : ''}.`,
  c => `There used to be a world called ${c.world}. The Leviathan finished it this cycle.`,
  c => `${c.world} is a ring of rubble after the Leviathan's strike. The map is one world smaller.`,
  c => `The Leviathan struck ${c.world} and the world did not survive it. Its pieces are still orbiting where it was.`,
  c => `${c.world} broke apart under the creature's strike this cycle${c.lost ? `, taking ${c.lost} settlement${c.lost === 1 ? '' : 's'} with it` : ''}.`,
  c => `The Leviathan has fed. ${c.world} is debris.`,
  c => `Nothing on ${c.world} survived, because ${c.world} did not survive. The beast is already looking elsewhere.`,
  c => `One more name comes off the map: ${c.world}, broken by the Leviathan this cycle.`,
  c => `The strike over ${c.world} completed, and so did the world. A cloud of rock is all that remains.`,
  c => `${c.world} was the Leviathan's meal this cycle. What it leaves behind is a debris field and a gap in every chart.`,
  c => `The monster's charge over ${c.world} ended in a single strike. The world came apart like wet paper.`,
  c => `${c.world} no longer exists as a world. The Leviathan saw to it this cycle.`,
  c => `The Leviathan has destroyed ${c.world}${c.lost ? ` and the ${c.lost} settlement${c.lost === 1 ? '' : 's'} on it` : ''}. Its rubble still circles the same orbit.`,
  c => `Another world for the Leviathan: ${c.world}, now rubble.`,
  c => `The day of warning ran out over ${c.world}, and nobody had killed the beast. The world is gone.`,
  c => `${c.world} has joined the list of worlds the Leviathan has eaten. It will not be the last unless something changes.`,
];
export const KAIJU_BROKEN_HEADLINE = [
  c => `${c.world.toUpperCase()} IS GONE`,
  c => `THE LEVIATHAN EATS ${c.world.toUpperCase()}`,
  () => `ONE WORLD FEWER`,
  c => `RUBBLE WHERE ${c.world.toUpperCase()} WAS`,
  c => `${c.world.toUpperCase()} BROKEN`,
  () => `THE BEAST HAS FED`,
  () => `A GAP IN EVERY CHART`,
  c => `GOODBYE, ${c.world.toUpperCase()}`,
  () => `NOBODY KILLED IT IN TIME`,
  () => `THE MAP GETS SMALLER`,
];

export const KAIJU_LEAVING = [
  c => `The Leviathan has had enough. It took ${c.worlds}. It is heading back to the ${c.gate}.`,
  c => `It is leaving. ${c.worlds}: that was the meal. The creature has turned for the ${c.gate} and home.`,
  c => `Sated, the Leviathan has set course for the ${c.gate}. It leaves behind the rubble of ${c.worlds}.`,
  c => `The beast is going back the way it came, toward the ${c.gate}. ${c.worlds} will not be coming back.`,
  c => `The Leviathan has stopped hunting. After ${c.worlds}, it is burning for the ${c.gate}.`,
  c => `It is full. The creature that ate ${c.worlds} has turned away from the inner system and is making for the ${c.gate}.`,
  c => `The hunt is over, for now. The Leviathan is leaving through the ${c.gate}, with ${c.worlds} behind it.`,
  c => `It has eaten its fill: ${c.worlds}. The Leviathan is on its way back to the ${c.gate}.`,
  c => `The Leviathan turned for home this cycle. The ${c.gate} is where it is going; ${c.worlds} is what it leaves.`,
  c => `Nobody stopped it, and now it is stopping itself. ${c.worlds} gone, the Leviathan is heading for the ${c.gate}.`,
  c => `The creature is withdrawing toward the ${c.gate}. Its tally: ${c.worlds}.`,
  c => `The Leviathan's appetite is satisfied. It has set course for the ${c.gate} after taking ${c.worlds}.`,
  c => `It is going. The Leviathan, having eaten ${c.worlds}, is burning back toward the ${c.gate}.`,
  c => `Its jet is pointed at the Far Reach again. The Leviathan is leaving by the ${c.gate}; ${c.worlds} paid for its visit.`,
  c => `The system can breathe, a little. The Leviathan is heading back to the ${c.gate}, done with ${c.worlds}.`,
  c => `It has had what it came for. ${c.worlds}, and now the ${c.gate}.`,
  c => `The Leviathan is going home through the ${c.gate}. Its meal, ${c.worlds}, stays behind as rubble.`,
  c => `The creature is done with us. It is crossing back to the ${c.gate} after ${c.worlds}.`,
];
export const KAIJU_LEAVING_HEADLINE = [
  () => `IT HAS EATEN ITS FILL`,
  () => `THE LEVIATHAN TURNS FOR HOME`,
  () => `LEAVING, FOR NOW`,
  () => `THE HUNT IS OVER`,
  c => `BACK TO THE ${c.gate.toUpperCase()}`,
  () => `SATED`,
  () => `THE SYSTEM CAN BREATHE`,
  () => `IT IS GOING`,
  () => `A TALLY OF WORLDS`,
  () => `NOBODY STOPPED IT`,
];

export const KAIJU_GONE = [
  c => `The Leviathan went back through the ${c.gate} this cycle. Nobody knows if it will return.`,
  c => `It is gone, through the ${c.gate} and out of reach. The scopes are still watching the far side.`,
  c => `The ${c.gate} took the Leviathan home. The system is quieter, and smaller.`,
  c => `The Leviathan crossed through the ${c.gate} and was gone. What it left behind is rubble and a gate.`,
  c => `It slipped back through the ${c.gate} this cycle. The far side has its monster back.`,
  c => `The creature has left the system by the ${c.gate}. Every admiralty is asking whether it will come back.`,
  c => `Gone. The Leviathan went through the ${c.gate} without a backward look.`,
  c => `The ${c.gate} flared once as the Leviathan passed through, and then it was only a gate again.`,
  c => `It has left. The Leviathan is on the far side of the ${c.gate}, and the near side is counting its losses.`,
  c => `The Leviathan is gone through the ${c.gate}. The rubble it left will be orbiting long after anyone remembers why.`,
  c => `Through the ${c.gate} and away: the Leviathan has left the system.`,
  c => `The monster is gone. The ${c.gate} it carried here is how it left.`,
  c => `The system is free of the Leviathan, for now. It went home through the ${c.gate} this cycle.`,
  c => `The last anyone saw of the Leviathan was its jet, vanishing into the ${c.gate}.`,
  c => `It is over, or paused. The Leviathan went back through the ${c.gate}.`,
  c => `The Leviathan has gone home. The ${c.gate} is open behind it, and so is the question of whether it will return.`,
  c => `The creature passed through the ${c.gate} this cycle. The scopes on the far side have lost it in the dark.`,
  c => `The Leviathan is no longer in the system. It left by the ${c.gate}, as quietly as something that size can.`,
];
export const KAIJU_GONE_HEADLINE = [
  () => `THE LEVIATHAN IS GONE`,
  () => `BACK THROUGH THE GATE`,
  () => `WILL IT COME BACK?`,
  () => `IT HAS LEFT THE SYSTEM`,
  () => `QUIET, FOR NOW`,
  c => `THROUGH THE ${c.gate.toUpperCase()}`,
  () => `THE MONSTER GOES HOME`,
  () => `OVER, OR PAUSED`,
  () => `THE FAR SIDE HAS IT BACK`,
  () => `COUNTING THE LOSSES`,
];

export const KAIJU_DEAD = [
  c => `The Leviathan is dead. It fell at ${c.world}${c.killer ? `, and ${c.killer} landed the killing blow` : ''}. Its carcass is a salvage field of ${c.tons} tonnes of metal.`,
  c => `It died. The creature from beyond the Sun came apart at ${c.world}${c.killer ? ` under fire from ${c.killer}` : ''}. ${c.tons} tonnes of it are still there for anyone with a mining rig.`,
  c => `The monster has been killed at ${c.world}.${c.killer ? ` The last shot was fired by ${c.killer}.` : ''} What remains is ${c.tons} tonnes of salvage, and every freighter in the system wants some.`,
  c => `They did it. The Leviathan is a carcass at ${c.world}${c.killer ? `, finished by ${c.killer}` : ''}, worth ${c.tons} tonnes of metal to whoever mines it first.`,
  c => `The hunt is over, and the hunter lost. The Leviathan died at ${c.world}${c.killer ? `; ${c.killer} fired last` : ''}. Its body, ${c.tons} tonnes of it, is open for salvage.`,
  c => `The Leviathan's lights went out this cycle over ${c.world}.${c.killer ? ` ${c.killer} delivered the final strike.` : ''} Its carcass holds ${c.tons} tonnes of metal.`,
  c => `Dead at ${c.world}. The Leviathan took a fleet's worth of fire and finally stopped${c.killer ? `, with ${c.killer} credited for the kill` : ''}. ${c.tons} tonnes of carcass remain.`,
  c => `The creature that came through the dark between the stars will not leave. It died at ${c.world}${c.killer ? ` to ${c.killer}'s guns` : ''}, and its body is ${c.tons} tonnes of salvage.`,
  c => `Every empire's enemy is dead.${c.killer ? ` ${c.killer} landed the blow that ended it` : ' It fell'} at ${c.world}. The carcass, ${c.tons} tonnes of metal, is open to all.`,
  c => `The Leviathan's arms went slack over ${c.world} this cycle. It is dead${c.killer ? `, and ${c.killer} has the kill` : ''}. Freighters are already turning toward ${c.tons} tonnes of carcass.`,
  c => `It is over. The Leviathan died at ${c.world}${c.killer ? `, finished by ${c.killer}` : ''}. Its hide alone is ${c.tons} tonnes of metal.`,
  c => `The monster is dead and the salvage rush has begun. ${c.tons} tonnes of Leviathan orbit ${c.world}${c.killer ? `, where ${c.killer} brought it down` : ''}.`,
  c => `Somebody finally killed it.${c.killer ? ` That somebody was ${c.killer}.` : ''} The Leviathan fell at ${c.world}, and its carcass is worth ${c.tons} tonnes of metal.`,
  c => `The Leviathan is a corpse at ${c.world}${c.killer ? `, and ${c.killer} put it there` : ''}. ${c.tons} tonnes of it are waiting for mining rigs.`,
  c => `The violet light is gone. The Leviathan died at ${c.world} this cycle${c.killer ? `, the killing blow coming from ${c.killer}` : ''}; ${c.tons} tonnes of carcass remain.`,
  c => `The worlds it ate are avenged, in a sense. The Leviathan died at ${c.world}${c.killer ? ` under ${c.killer}'s fire` : ''}, leaving ${c.tons} tonnes of salvage.`,
  c => `A fleet stood its ground at ${c.world} and the Leviathan did not survive it.${c.killer ? ` ${c.killer} fired the last shot.` : ''} The carcass holds ${c.tons} tonnes of metal.`,
  c => `The Leviathan is dead. Where it fell, over ${c.world}, ${c.tons} tonnes of carcass now drift for anyone to mine.${c.killer ? ` Credit for the kill: ${c.killer}.` : ''}`,
];
export const KAIJU_DEAD_HEADLINE = [
  () => `THE LEVIATHAN IS DEAD`,
  c => `KILLED AT ${c.world.toUpperCase()}`,
  c => `${c.tons} TONNES OF MONSTER`,
  () => `THE HUNTER FALLS`,
  () => `SALVAGE RIGHTS OPEN`,
  () => `EVERY EMPIRE'S ENEMY IS DEAD`,
  () => `THE LIGHTS GO OUT`,
  () => `THEY DID IT`,
  c => `A CARCASS AT ${c.world.toUpperCase()}`,
  () => `THE SALVAGE RUSH BEGINS`,
];

/** Its arrival in a game whose gates were already open (launchKaijuNow):
 *  it brought no gate, it came to the one that was there. */
export const KAIJU_ARRIVED_OPEN = [
  c => `The Leviathan reached the ${c.gate} this cycle and did not stop to rest. It turned for ${c.world}.`,
  c => `It is here. The creature from ${c.system} came to rest beside the ${c.gate}, then set course for ${c.world}.`,
  c => `The Leviathan arrived at the Far Reach end of the ${c.gate} on schedule. Its first meal: ${c.world}.`,
  c => `Arrival. The thing from ${c.system} is in the system, and it is going for ${c.world}.`,
  c => `The Leviathan braked to a stop by the ${c.gate} and looked around. Then it went for ${c.world}.`,
  c => `The long burn from ${c.system} ended at the ${c.gate}. The hunt began a moment later, with ${c.world}.`,
  c => `It came in on time, right on top of the ${c.gate}, and it is already moving on ${c.world}.`,
  c => `Contact. The Leviathan is in the Far Reach beside the ${c.gate}, and every settlement on ${c.world} has been told it is next.`,
  c => `The creature has arrived. It stopped by the ${c.gate}, the door it knows, and chose ${c.world}.`,
  c => `The wait is over. The Leviathan is at the ${c.gate} and burning for ${c.world}.`,
  c => `The Far Reach has a predator. The Leviathan arrived by the ${c.gate} this cycle and picked ${c.world}.`,
  c => `It did not need a gate of its own. The Leviathan came to the ${c.gate} and is now headed for ${c.world}.`,
  c => `The Leviathan is in the system. It stopped beside the ${c.gate} long enough to turn, and went for ${c.world}.`,
  c => `The monster from ${c.system} has landed by the ${c.gate}. ${c.world} is first.`,
  c => `The forecasts were right to the tick: the Leviathan reached the ${c.gate}, and it is going for ${c.world}.`,
  c => `It came out of the dark between the stars and stopped by the ${c.gate}. Then it went for ${c.world}.`,
  c => `The Leviathan's flight from ${c.system} is over. Its hunt is not: ${c.world} is the first target.`,
  c => `By the ${c.gate}, the Leviathan uncurled, lit its jet again, and set off for ${c.world}.`,
];

/** Its first strike on a world that was never living (kaiju.js): no
 *  biosphere to strip, so it burns the surface bare, then breaks it. */
export const KAIJU_SCORCHED = [
  c => `The first strike landed on ${c.world}. There was no biosphere to take, so it took everything else${c.lost ? `: ${c.lost} settlement${c.lost === 1 ? '' : 's'}, gone` : ''}. It is winding up again.`,
  c => `${c.world} has been scorched to bare rock${c.lost ? `, ${c.lost} settlement${c.lost === 1 ? '' : 's'} with it` : ''}. The Leviathan has not moved. The second strike is charging.`,
  c => `The Leviathan burned ${c.world} clean this cycle. Nothing stands on it now, and the creature is gathering itself to break the world.`,
  c => `First barrel: ${c.world}'s surface, scorched. Second barrel: charging now.`,
  c => `Every structure on ${c.world} is ash. The beast above it has started the second wind-up.`,
  c => `${c.world} is still a world, for one more day. The Leviathan scorched it this cycle and is charging the strike that ends it.`,
  c => `The Leviathan's first strike on ${c.world} left nothing standing${c.lost ? `; ${c.lost} settlement${c.lost === 1 ? ' is' : 's are'} gone` : ''}. The rock itself is next.`,
  c => `It does not eat a world in one bite. ${c.world} was scorched this cycle; the breaking comes a day later.`,
  c => `Fire first, then the end. ${c.world} took the fire this cycle.`,
  c => `The glow over ${c.world} let go and the surface burned. The Leviathan is winding up again above what is left.`,
  c => `${c.world} is scorched. Anyone who wants to save the rock has one more day to kill the beast.`,
  c => `The Leviathan has burned ${c.world} bare and stayed to finish it. The second charge has begun.`,
  c => `Half of the double tap has landed on ${c.world}. Nothing on the surface survived it.`,
  c => `The first strike scoured ${c.world}${c.lost ? ` and the ${c.lost} settlement${c.lost === 1 ? '' : 's'} on it` : ''}. The creature is charging again, slower and brighter.`,
  c => `There is nothing left on ${c.world} to defend, but the world itself is still there, for a day.`,
  c => `${c.world} has been burned clean from orbit by a living thing. The thing is charging the strike that will break it.`,
  c => `Scorched: ${c.world}. Next: the end of ${c.world}, unless somebody intervenes.`,
  c => `The Leviathan's fire swept ${c.world} this cycle. It has settled in to wind up the second.`,
];
export const KAIJU_SCORCHED_HEADLINE = [
  c => `${c.world.toUpperCase()} SCORCHED`,
  () => `THE FIRST BARREL`,
  () => `IT IS CHARGING AGAIN`,
  c => `ASH ON ${c.world.toUpperCase()}`,
  c => `${c.world.toUpperCase()} BURNED BARE`,
  () => `ONE STRIKE DOWN, ONE TO GO`,
  () => `NOTHING LEFT STANDING`,
  () => `THE DOUBLE TAP BEGINS`,
  c => `ONE MORE DAY FOR ${c.world.toUpperCase()}`,
  () => `FIRE FIRST, THEN THE END`,
];
