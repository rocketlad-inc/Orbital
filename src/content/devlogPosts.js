// ============================================================
// Devlog seed content — the posts as originally authored.
//
// PLAIN JS ON PURPOSE. The worker imports this file directly (the same
// way room.js imports ../src/physics/rendezvous.js) to seed the
// devlog_posts table on an empty database, and the landing page imports
// it as the fallback body when /api/devlog cannot be reached. One copy,
// two readers — a second hand-maintained copy under worker/ would drift
// the first time somebody fixed a typo in only one of them.
//
// After the seed runs, THE DATABASE IS THE SOURCE OF TRUTH. Editing a
// post in the admin UI does not write back here, and this file is not
// consulted again except as an offline fallback. Do not "fix" a live
// post by editing this file.
// ============================================================

export const SEED_POSTS = [
  {
    slug: 'megastructures',
    title: 'Megastructures: Building Things That Outlive Your Fleet',
    date: '25 August 2026',
    lede: 'Seven things to build in empty space, a new gun that does no '
        + 'damage, veterancy moving fully onto captains, and a pass on '
        + 'pacing across the whole map.',
    charts: false,
    html: `
<p>Everything you have built in Orbital so far has been on a world, or made of ships. Worlds you inherit. Ships die. The space between them has been empty: somewhere fleets cross on the way to a fight, nothing more.</p>
<p>That changes here. You can now build in open space, and what you build stays there. It holds an orbit, it shows up on sensors, and it can be found, besieged, boarded, and taken from you. It outlives the fleet that built it.</p>

<h2>Megastructures</h2>
<p>A megastructure starts as a framework, laid down by a colony ship fitted with a Construction Module. Placing one uses up the ship, the same way founding a settlement does. From there it is a construction site with a meter, and you fill the meter by flying freight to it.</p>
<p>Seven structures, spread across three research tracks, so no single empire gets all of them:</p>
<ul>
<li><strong>Warp Gate</strong> (Propulsion 6). 5,000 metal, 7,000 credits. Two-way, paired to exactly one other gate.</li>
<li><strong>Weapons Station</strong> (Weapons 6). 7,000 metal, 5,000 credits. Reaches 700 units into a transit lane, three gun mounts.</li>
<li><strong>Gravity Sink</strong> (Propulsion 8). 4,000 metal, 4,000 credits. Catches crossing ships and holds them for eight ticks. You choose who is caught and who passes.</li>
<li><strong>Null Field</strong> (Armor 7). 4,000 metal, 4,000 credits. Blinds rival sensors within 700 units.</li>
<li><strong>Deep Space Array</strong> (Armor 9). 3,500 metal, 4,500 credits. An 1,100-unit sensor bubble anywhere you can afford to put one.</li>
<li><strong>Mobile Foundry</strong> (Propulsion 10). 9,000 metal, 11,000 credits. A shipyard that moves.</li>
<li><strong>Mega Destroyer</strong> (Weapons 9). 12,000 metal, 8,000 credits. A capital warship.</li>
</ul>
<p>The last two are not emplacements. They finish, then they launch.</p>

<h3>Two capital hulls</h3>
<p>The Mobile Foundry builds four hulls at once, wherever you park it, stacked on top of any yard already there. Move it and the slipway moves with it. Anything still on the ways finishes where it was laid down.</p>
<p>The Mega Destroyer has 4,000 hull points, does 350 damage a tick, and moves at a tenth the speed of a corvette. It cannot use gates. It is the slowest thing in the game and the hardest hitting, so it takes a long time to say what it says.</p>
<p>Its real weapon is the strike. Park it over a terraformed world and it charges for 24 ticks, then strips the biosphere off the planet. A terraformed world is the only place cargo can land, so this does not kill anyone. It takes away the loading dock.</p>
<p>The target can see it coming. The world under threat wears a filling ring, there is a countdown, the Situation log warns the owner, and the Herald runs it as a headline. A 24-tick fuse nobody can see is not a threat. It is an ambush.</p>

<h3>Taking one costs you</h3>
<p>Structures have 3,000 hull points and repair 12 a tick. Both numbers moved a long way in testing. The first pass priced them off a bare hull's damage, no weapon mounts fitted. Real ships carry mounts. A six-mount destroyer at Weapons 10 fires for 130 a tick, not 22.5, and at that rate the original 200 hull points was one volley for a squadron.</p>
<p>At 3,000, a lone destroyer needs twenty-odd ticks and has to stay there the whole time. Three destroyers do it in six to eight. A corvette screen cannot manage it at all, which is what the repair rate is there to guarantee.</p>
<p>Break a structure below 20% and it is breached. Then you choose: capture it, and whatever construction stores were inside it are lost, or destroy it, and nobody gets it. Either way you need an armed hull holding the orbit. A freighter parked at a gate is not a siege.</p>

<h3>Derelicts</h3>
<p>When a faction is eliminated, its structures do not vanish and they do not stay flagged to a dead empire. They go abandoned: ownerless, still in orbit, still working. The first faction to park any ship in the orbit claims it. No breach, no warship, because there is nobody left to fight. It costs you the trip, nothing more.</p>
<p>Ancient gates, which have belonged to nobody since the map was drawn, cannot be claimed. One faction holding the only permanent crossing on the map is a different game.</p>

<h3>Gates fling, they do not teleport</h3>
<p>A gate takes a crossing that would burn ten ticks under your own engines and does it in three: a quarter of the flight time, not an instant hop. A ship in that compressed burn is still in flight. It can be seen, chased, and caught by a Gravity Sink, the same as any other transfer.</p>
<p>Gates can be paired across empires too, through a construction pact.</p>

<h3>Pacts and sales</h3>
<p>A construction pact lets two factions fund each other's sites and wire each other's gates. That is all it grants. Not a ceasefire, not an alliance. Two factions can co-fund a gate and still be shooting at each other over it. The Senate can also set a price on megaprojects, so the chamber decides whether this is an era of great works or an era of fleets.</p>
<p>You can also sell things that are not resources. An asset deal trades a hull or a settled world for freight. The seller names a price, the buyer hauls payment to wherever the asset actually is, and it changes hands when the meter fills. Payment sits in escrow rather than paying out per run, so a seller who walks away from a half-paid deal keeps nothing.</p>
<p>A sold hull arrives clean. Every standing order is stripped, the captain stays with the seller, and every armed charge is cleared. Selling someone a corvette with a live self-destruct aboard is not a trade.</p>

<h2>New Ship Parts</h2>
<p>The Flak Battery does no damage at all. Every one you fit slows every enemy hull in the battle by 5%, compounding, floored at half speed. Speed is survivability in this game, and a slower ship is easier for your whole fleet to hit. Flak is a force multiplier for everyone shooting next to it, and it costs almost nothing. It fits corvettes, frigates, and destroyers.</p>

<h2>Captain Updates</h2>
<p>Experience now lives in exactly one place: the captain. Ships used to carry a vestigial rank and kill count of their own, left over from before veterancy moved to officers. Those columns were zeroed and unread, but the shipyard kept writing to them anyway, because the column was there. They are gone now.</p>
<p>Rank still climbs the same way: a confirmed kill adds one rank, worth 1% more damage and 1% more hull. The tiers are Rookie, Regular, Veteran, Elite, and Ace at rank 10. A fleet still runs on one commanding officer. Members surrender their captain to the bank when they join, and the flagship's captain becomes the fleet's admiral.</p>
<p>Veteran Yards used to launch new hulls carrying a share of the fleet's average rank, which was hull veterancy under another name and stopped doing anything the day rank moved to captains. It now does the same job in the place experience actually lives: your new captains start at rank 1, already blooded.</p>

<h2>Pacing Updates</h2>
<p>Games were resolving too fast, and three changes slow them down.</p>
<p><strong>Travel time follows distance correctly now.</strong> A torch transfer accelerates for half the trip and brakes for the other half, so travel time scales with the square root of distance, not distance itself. Four times the distance buys twice the time. The old help text claimed a setting of 2 roughly doubled travel time; it actually bought 1.4 times. That is now fixed, so the dial does what it says.</p>
<p><strong>Moons are further apart.</strong> Most fights happen inside a planet's system, and a moon hop used to take under four ticks: barely a fight at all. Moons now sit further from their parent planet, with orbital periods scaled to match, so a moon hop takes real time without breaking the physics that hold everything else together.</p>
<p><strong>Structure combat is calibrated against real ships, not bare hulls.</strong> The 200 to 3,000 hull point change above came from the same fix: every number that touches combat is now priced off a fitted ship, mounts and all, not the hull a ship starts with before you put anything on it.</p>
<p>None of this changes what you can do. It changes how long each fight and each crossing takes to matter.</p>

<h2>Bug Fixes</h2>
<p>Two bugs came out of a full regression pass, and both were the same shape: the game accepted an order and then quietly did nothing.</p>
<ul>
<li>You could arm a dead man's switch on a ship with no detonator fitted. The order took, the panel showed it, and nothing ever happened. It now refuses at the moment you set it and tells you why.</li>
<li>An eliminated faction could still capture a structure, only for the abandonment rule to take it back one tick later with no warning. Both actions are blocked for eliminated factions now.</li>
</ul>
<p>A separate player report on detonator damage turned out to be right on both counts raised. The tooltip promised one number, the blast dealt another, and the description still quoted a percentage we had already lowered. All three now read the same number: the one on the health bar.</p>

<p>Go build something that is still there next game.</p>
`,
  },
  {
    slug: 'rendezvous-and-routes',
    title: 'Rendezvous and Routes: The Possibilities for Piracy Open',
    date: '15 August 2026',
    lede: 'Trade routes became a network worth robbing, and ships in flight '
        + 'stopped being untouchable. Escorts finally mean something.',
    charts: false,
    html: `
<p>For three games, a ship in flight could not be shot and could not shoot. Meanwhile the Trades panel told you "freighters can be raided — escort what you can't afford to lose." That was a lie. A loaded freighter crossing hostile space was untouchable, and the space between worlds was decoration.</p>
<p>Both halves of that have changed. Trade is now a network worth robbing, and there is finally a way to rob it.</p>

<h2>1. Routes are circuits now, not one-way trips</h2>
<p>A trade route used to be an origin, a destination, and one freighter shuttling between them. Now a route is a <strong>list of stops</strong>, and at each one you say what happens: pick up, or drop off. Up to eight stops, then it loops — forever, or for a set number of runs.</p>
<ul>
<li><strong>Build it two ways.</strong> Add stops from a searchable list grouped by what they orbit, or hit <strong>Pick on map</strong> and click the worlds directly. In pick mode, worlds you can't ship from dim out and refuse the click, stops already on the circuit wear a ring, and the camera keeps the whole run framed as it grows. Click a knot of moons and it asks which one you meant.</li>
<li><strong>More than one freighter per lane.</strong> How many depends on your Logistics research. Two hulls on a two-stop circuit start at opposite ends, so goods move both directions at once instead of in convoy.</li>
<li><strong>Escorts.</strong> Assign warships as <strong>guards</strong> and they fly the route with the freighter — burning to meet it when you assign them, pacing it stop to stop, holding defensive stance the whole way. This is the part that used to be pointless.</li>
</ul>

<h2>2. Standing deals fly on one lane, both directions</h2>
<p>A recurring deal used to commission two routes: your freighter carried your goods out and came home empty, theirs did the mirror image. Half of every run was an empty hull.</p>
<p><strong>Fold the deal onto one circuit</strong> and every freighter on it collects <em>and</em> delivers at both ends. Same ships, twice the trade. Nobody gives up a hull — every freighter already working the deal comes across — so either party can just do it, without asking.</p>
<p>You can also pin a freighter to an offer when you send it. Accept, and the lane is already flying on that hull, both directions, before anyone opens a panel. The offer now says plainly whether accepting costs you a freighter or not.</p>

<h2>3. A lane that stops tells you why</h2>
<p>Routes fail in two completely different ways that used to look identical:</p>
<ul>
<li><strong>Stalled</strong> — no freighter on it. Counts down 30 ticks, then cancels itself.</li>
<li><strong>Starved</strong> — the loading side can't cover the shipment. Ten ticks, then the whole agreement dies.</li>
</ul>
<p>Starving used to be invisible right up until the deal collapsed, naming a shortfall you had never been shown. Now the card says who is short and by exactly how much, while there is still time to fix it. Every ship on a route also reports where it is, where it's headed, what's in the hold, and how many ticks until it lands.</p>

<h2>4. The rendezvous order: aim at a ship, not a place</h2>
<p>You could only ever order a ship to a <em>body</em>. Escorting worked by accident — same destination, same tick — and interception was a lottery: guess a destination whose path happens to pass near theirs, with no tooling and no feedback.</p>
<p>There is now an order that targets <strong>a ship</strong>. It solves for a manoeuvre that arrives where that ship will be, <em>carrying its velocity</em> — burn, coast, burn, instead of the flip-and-burn every other transfer flies. Three things, in the order they matter:</p>
<ul>
<li><strong>Meet them at the door.</strong> Read their destination and arrival, time your own to match. No solver needed, and it catches most of what you actually want to catch.</li>
<li><strong>Match velocity in open space.</strong> The full solver: meet them mid-flight with relative velocity near zero. Deliberately zero — because a crossing at high relative speed is the shot nobody lands.</li>
<li><strong>Follow on meet.</strong> On contact, copy their remaining burn. Without this you touch for one tick and drift apart; with it, you are still alongside when they arrive.</li>
</ul>
<p><strong>The solver is allowed to fail.</strong> For most geometries there is no pair of burns that closes both the position gap and the velocity gap before the target gets home, and you will be told there is no solution. Nothing decided that interception should be hard — it simply is, and that falls out of the arithmetic rather than out of a balance knob.</p>
<p>Two consequences worth internalising. <strong>Your target cannot dodge</strong> — a committed burn cannot be re-aimed, so you are solving against something that physically cannot move under you. And <strong>interception is an intel problem</strong>: you solve against the target's <em>last known</em> trajectory. Good sensors make it surgical. Bad sensors make you miss.</p>

<h2>5. Transit combat: how being fast actually saves you</h2>
<p>With transit combat on, ships in flight can shoot and be shot at. The interesting part is what decides whether a shot lands, because "fast means hard to hit" turns out to be two unrelated things:</p>
<ul>
<li><strong>Aim</strong> — how fast the target sweeps <em>across</em> your sights. Only sideways motion does this. Something closing straight at you is boresighted: it sits still in the reticle and grows.</li>
<li><strong>Exposure</strong> — how much of the tick it was in range at all. A contact crossing at 380 units per tick clears a 12-unit envelope in 6% of a tick.</li>
</ul>
<p>Collapse those into one "how fast is it going" number and flying can only ever be a penalty. Split them and geometry starts mattering: a radial departure and a beam pass at the same speed differ by <strong>45 percentage points</strong>. How you approach is now a real decision.</p>
<p>The rest of the rules:</p>
<ul>
<li><strong>Reach is per hull.</strong> Corvette 12, frigate 16, destroyer 20. Freighters and colony ships have <strong>zero</strong> — they never initiate, and they remain perfectly targetable. The corvette's edge is that it can close, not that it can reach.</li>
<li><strong>Halved inside a planet's system.</strong> Moon systems are packed an order of magnitude tighter than interplanetary space; at full reach one destroyer covered three orbits at once.</li>
<li><strong>You cannot shoot through a moon.</strong> Line of sight uses the same occlusion test your sensors do. Detection is networked across your empire; guns are not.</li>
<li><strong>Engagement is closest approach</strong>, not distance at an instant. Two ships closing head-on can converge faster than the entire gap between them within a single tick — sampling once per tick would miss most crossings entirely.</li>
<li><strong>Nothing about fights at a body changes.</strong> Two ships parked at the same world have identical motion, so every number in the Combat v2 notes holds exactly.</li>
</ul>
<p><strong>The vulnerable window is about two ticks — one at each end — regardless of how long the trip is.</strong> A fourteen-hour haul is not fourteen hours of exposure; it is two, with twelve hours of untouchable cruise in between. Long hauls are proportionally <em>safer</em>. Piracy happens at the doors.</p>
<p><strong>Running fights are to the death.</strong> Two hostiles that launch onto the same lane are locked in at full odds for the entire flight, and neither can break off, because a committed burn cannot be re-aimed. Your retreat-at-HP% setting does nothing in transit. Launching alongside an enemy is a commitment — that is the point.</p>
<p><strong>Transit combat is OFF by default.</strong> The machinery is in and it works, but it is a host setting, and a fight at a body is numerically identical either way. Turn it on in a sim room before you turn it on in a match you care about.</p>

<h2>6. Also in this update</h2>
<ul>
<li><strong>Fuel is gone.</strong> Not hidden — gone. It had been economically dead for a while (nothing produced it, every yield was zero), but it still sat in ship tanks, holds, stockpiles and open offers where it could never be spent. It has been purged from every table in every running game, and no offer, grant or endpoint will create any more.</li>
<li><strong>A partner's lane counts as yours.</strong> A world served by a folded lane you do not own no longer reports "no route is collecting this", and no panel will tell you to commission a freighter for goods already in flight.</li>
<li><strong>You get told when your offer is accepted</strong> — by DM as well as in the log. The log also now delivers the trade events it had been writing and showing to nobody.</li>
<li><strong>Other players' queued trajectories are hidden.</strong> Only your own plans draw on the map. A rival's live burn still shows: that is a real ship in real flight, and knowing about it is the point.</li>
</ul>
`,
  },
  {
    slug: 'game-3',
    title: 'Game 3',
    date: 'July 2026',
    lede: 'Collectors are gone, expansion runs on freighters now, and weapons '
        + 'pick a side of your economy.',
    charts: true,
    html: `
<h2>1. Collectors are dead. Long live terraforming.</h2>
<p>This is the big one. I’ve rewritten how expansion works, and replaced collectors with terraforming.</p>
<p>Every world starts RAW and can be terraformed once you land a station there, and the difference matters a lot:</p>
<ul>
<li><strong>Raw</strong> worlds only kick 10% of their yield back to your treasury. The other 90% just piles up locally — you can spend it on-site (ships and station upgrades), or send a freighter to haul it home, but it's not touching your empire pool on its own.</li>
<li><strong>Terraformed</strong> worlds send you 100% or resources to your stockpile, can host cities and buildings, and can originate trade routes to other players, dyson spheres, or terraforming projects.</li>
</ul>
<p>Your capital and Earth start terraformed. Everything else is raw dirt until you fix it.</p>
<p><strong>To begin terraforming, you must deliver the goods:</strong></p>
<ul>
<li><strong>Scout it.</strong> Visit the world to discovery any secrets.</li>
<li><strong>Claim it.</strong> A colony ship drops a station, cities can no longer be built on worlds that are not terraformed.</li>
<li><strong>Supply it.</strong> Set a freighter on a trade route from a terraformed world to your raw target. It'll load metal and credits from your pool and haul it over.</li>
<li><strong>Wait.</strong> Once 124 metal + 124 credits have physically shown up, a 24-tick countdown starts. The world flips when it hits zero.</li>
<li><strong>Settle it.</strong> Now you can drop a city.</li>
</ul>
<p>A few notes on terraforming:</p>
<ul>
<li>The clock doesn't start until the full payload lands. Partial shipments just sit there banked, patiently, forever.</li>
<li>Terraforming sticks. Conquer a developed world and you keep the work that's already been done. So, don’t want to terraform your own world? Steal someone else's.</li>
<li>The only thing that undoes it is an asteroid strike — which is exactly why the asteroid weapon is scary. It's the one button that un-develops the map.</li>
<li>Gas giants, ice giants, and asteroids can never be terraformed. They're forever staging grounds on the 10% trickle. Use them for what they're good for, and set up trade routes to get faster access to their stockpiles.</li>
</ul>
<h2>2. Cities want Construction 1. Stations want nothing.</h2>
<p>The research requirement moved. Stations — the thing that claims a world — now cost zero research. Cities need Construction 1, which you'll have well before your first terraform even finishes cooking.</p>
<h2>3. Different currencies build different weapons</h2>
<p>It was noted the different types of weapons didn’t make much difference last game, so I’ve made it so that different resources by different weapons. Your weapon type will now be party decided by what’s most affordable for you.</p>
<p>Metal buys kinetic weapons and shields. Credits buy energy weapons and armor. The exchange rate is 8:1, so technically nothing is unbuildable — it's just brutally expensive in the wrong economy.</p>
<div class="cl-tablewrap"><table class="cl-table"><tr><th><strong>Part</strong></th><th><strong>Metal</strong></th><th><strong>Credits</strong></th></tr><tr><td>Kinetic mount</td><td>8</td><td>1</td></tr><tr><td>Shield array</td><td>8</td><td>1</td></tr><tr><td>Energy mount</td><td>1</td><td>8</td></tr><tr><td>Armor plate</td><td>1</td><td>8</td></tr><tr><td>Booster engine</td><td>2</td><td>6</td></tr><tr><td>Fusion detonator</td><td>10</td><td>10</td></tr></table></div>
<p>This pairing is crossed on purpose: shields stop kinetic, armor stops energy. So if you're running a one-currency empire, you will be weaker against an empire specialized in the other currency. You cannot field a complete warship on one economy alone. Go trade.</p>
<p><strong>Heads up:</strong> the default destroyer loadout is all-metal (kinetic + shields), meaning zero armor. Send it against an energy fleet and watch it melt. Refit before you commit to a fight.</p>
<h2>4. You start richer, and your population never stops growing</h2>
<p>Starting resources went from 100/50, to 100/100, and now to <strong>300/300</strong>. Also, population no longer caps at 10. Any settlement you hold grows +1 every 20 ticks, forever, no ceiling. Yield scales with population.</p>
<h2>Combat got rebuilt</h2>
<p>Combat v2 was forged in the fires of the battle of Sol last game:</p>
<ul>
<li>Ships fire <strong>every tick</strong> now, not every third tick.</li>
<li><strong>Peer targeting</strong>: ships go after enemies near their own speed first, then slower, then faster. Speed ties go to the slower ship.</li>
<li>Hit chance is speed-based — attacker² / (attacker² + defender²). Fast ships are genuinely hard to hit, not just nominally.</li>
<li>Stations are basically immobile destroyers now: 400 HP, and they shoot back if you've got Weapons research. Cities still never fire.</li>
<li>You control targeting priority directly — ship cards have drag-and-drop priority lists that show your per-tick hit chance against each hull class, and it applies across bulk orders too. Settlements are always last priority and can't be reordered.</li>
</ul>
<p><strong>Orbital Shields</strong> are a second health bar for settlements — 120 HP per level, regenerating 6/tick, with a grace period after it breaks so a bombardment can actually finish what it started.</p>
<p>Other changes: cities sit at 300 HP and stations at 400 HP, settlements auto-repair between raids, and repair scales +5 HP/tick per shipyard level.</p>
<h2>Captains and fleets</h2>
<p>Captains are a real, limited resource now. You start with 10. More cost 50 metal + 100 credits. They have traits, ranks, names and have a 50% chance of survival if their ship is destroyed.</p>
<p>Veterancy lives on the captain, not the ship. Score a kill with an empty cockpit and you bank nothing. Rank follows the officer, not the hull.</p>
<p>Fleets take orders as a group under a flag captain. One captain per fleet — the flag officer is the only one giving orders.</p>
<h2>The Senate</h2>
<ul>
<li>A chairman rotates in and holds the floor for a 24-tick term. Only they can propose a bill, and only one bill runs at a time — it has to resolve before the term's up.</li>
<li>Bills now require a quorum of active players to pass, no more passing votes with 1 player participating.</li>
<li>Vote weight = 1 + 1 per system you control (systems, not individual bodies). You control a system by holding more of it than any rival; ties are contested and count for nobody.</li>
<li>Debate and voting windows have a 6-tick minimum.</li>
<li>Slider laws can target everyone, or just one named faction.</li>
</ul>
<h2>Winning</h2>
<p>Three ways, and only three:</p>
<ul>
<li><strong>Engineering</strong> — finish the Dyson Sphere at Sol.</li>
<li><strong>Chancellor</strong> — win the Senate vote.</li>
<li><strong>Domination</strong> — hold more than 60% of the map's claimable bodies.</li>
</ul>
<p>The Dyson Sphere is now king-of-the-hill. Blow up the foundation and it doesn't vanish — the builder gets thrown off, 20% of remaining progress tears loose, and the lattice just sits there, unclaimed. Whoever drops the next foundation at Sol inherits the rest and keeps building.</p>
<p>It's also fed by real freighters now, not parked ships doing nothing useful. You need an actual supply route from a terraformed world to Sol — and yes, those freighters can be raided the entire way there.</p>
<h2>Economy</h2>
<ul>
<li>Fleet upkeep now has arrears: corvette 0.25c, frigate 0.5c + 0.5m, destroyer 1c + 1m, freighter 1c. Fall behind on payments and your ships start fighting worse.</li>
<li>Rush construction: pay the cost again to cut remaining build time in half, with a chance it botches.</li>
<li>Ship designer has been rebuilt for easier use.</li>
<li>Standing trade routes: set a deal once and it runs on repeat until something stops it.</li>
<li>Ships can be built straight from a world's local stockpile before touching your pool — so even a raw frontier world can fund its own hulls.</li>
</ul>
<h2>Intel now costs something</h2>
<p>You no longer see everyone's business for free. Rival ship counts, income, and tech levels are all locked behind Sensors research. Territory and system control stay visible to everyone, since they're literally how you win — hiding them would make the whole race unreadable.</p>
<h2>Accounts and profile</h2>
<p>You can rename yourself now. There's a career profile with your win/loss history, friends, a Past Games shelf for finished matches, and faction emblems — pick a flag in the lobby and fly it the whole game. No two factions can share the same one.</p>
`,
  },
];
