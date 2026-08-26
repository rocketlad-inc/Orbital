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
