// ============================================================
// bodyFlavor — per-body flavor text shown in the BodyInspector.
//
// Authored prose (typically 2-3 sentences) keyed by body.id. Kept
// in its own file rather than added as a field on Body so the
// 41-row body catalog in mockGameState.ts stays focused on game
// data — orbital elements, resources, IDs — while the writing
// lives somewhere it can be edited without grepping past tables
// of numbers.
//
// To add or edit: drop a string under the body's id. Empty / missing
// entries render nothing in the inspector (no awkward placeholder),
// so you can fill these in incrementally.
//
// Voice notes:
//   - 2-3 sentences, atmospheric. Not a manual page.
//   - Hint at the body's mood, history, or what makes it worth
//     visiting / avoiding. Numbers (yields, distances) already
//     show elsewhere — don't repeat them verbatim, but woven
//     references are welcome.
//   - For bodies that CAN host hidden secrets, the flavor can
//     gesture at the possibility ("a stargate sleeping under the
//     dust, or a dead warship adrift above it"). Don't author the
//     actual discovery toast; the secrets system owns those.
//   - Barycenters get flavor too — the "still point two suns turn
//     around" reads as a real concept worth pointing at, even if
//     the rendered marker is small.
// ============================================================

export const BODY_FLAVOR: Record<string, string> = {
  // === Sol system ============================================
  // Sol itself intentionally empty for now (no flavor authored yet).
  sol: '',

  // Inner planets
  mercury: "Closest to the fire, it turns three times for every two laps around Sol, so a single day outlasts the year that contains it. Sunward faces glaze to slag while crater floors at the poles have cradled water ice in permanent shadow for billions of years. There is wealth in its oversized iron heart — but you'll pry that metal loose under a sun that does not forgive.",

  venus: "A world the same size as home, drowned beneath an ocean of pressure and cloud, where the air is hot enough to melt lead and the rain is acid that never reaches the ground. Beneath that shroud the surface is younger than it should be, resurfaced by some violence we still don't understand. Whatever its secret holds, it has kept it well, behind a veil nothing has yet seen clearly through.",

  earth: "The pale blue cradle — balanced fuel, ore, and a depth of science that comes from being the one world we know learned how to live. A single moon raised its tides and steadied its tilt long enough for that to happen, which may be the rarest luck in the whole catalog. Everything starts here; the question Orbital asks is how far you'll get from it.",

  mars: "A rusted desert that once ran with rivers, its dry channels and ancient deltas still carved into iron-red rock as if the water left only yesterday. The ore runs rich and the secrets run dark out here — a stargate sleeping under the dust, or a dead warship adrift above it. The first real frontier, close enough to reach and strange enough to be worth the trip.",

  luna: "Earth's silent companion, born from a collision so vast it nearly unmade both worlds, now keeping the same gray face turned homeward for all of time. Little grows from its regolith but ore and quiet, yet old surveys left things in the dust here — a salvaged collector, a databank still patient in the dark. The first stepping-stone off the cradle, and the easiest place to learn what the void costs.",

  // Asteroid belt
  ceres: "The largest body in the belt, round enough to be a world in its own right, with bright salt deposits glinting where briny water once welled up from below. There may be a buried ocean still in there, sealed under ice and rock. Rich in ore and rumor both — if a lost city sleeps anywhere in the belt, this is where you'd look first.",

  vesta: "A battered protoplanet that never finished forming, scarred by an impact so enormous it flung fragments all the way to Earth as meteorites. Its core is iron, its crust is stone, and its ore yield is among the highest in the belt. A broken world that almost became something more — and may yet hold the bones of someone who got there first.",

  pallas: "Tilted hard on its axis and tracing a steep, lonely path that keeps it apart from the rest of the rubble, Pallas is a wanderer even among wanderers. Its surface is a study in violence, every face cratered and unsettled. The metal is good and the silence is deep; whatever's buried here has had a long time to be forgotten.",

  hygiea: "The dark, quiet fourth giant of the belt — round despite its modest mass, smooth where its siblings are scarred, as if a long-ago shattering reassembled itself into something almost peaceful. It gives up fuel and ore in equal, unspectacular measure. An overlooked world, which is exactly the kind that keeps its secrets longest.",

  juno: "One of the first asteroids ever found, an irregular lump of rocky metal that flares unexpectedly bright as it tumbles through the sun's light. Decent credits, decent ore, and the same belt-deep chance of treasure underfoot. Small, sharp-edged, and easy to pass by — which is why something might still be waiting on it.",

  // Jovian system
  jupiter: "The king of worlds — a storm-banded giant so massive it nearly became a second sun, with a single tempest larger than Earth that has raged for centuries. Its winds are pure fuel, drawn from clouds that have no bottom. A stargate could anchor itself in that immense gravity well, or a dead warship could be drifting in its shadow; either way, Jupiter rewards the bold and swallows the careless.",

  io: "The most volcanic world known, kneaded relentlessly by Jupiter's pull until its surface runs with sulfur and molten rock, repaving itself faster than its craters can form. There is fuel in its fury and ore in its restless crust. A hellish, glorious place — and old hands left a collector and a databank somewhere in the fire.",

  europa: "Beneath a fractured shell of ice lies an ocean holding more water than all of Earth's seas, kept liquid by the tides Jupiter never stops working into it. The science here runs deep and strange; whatever was filed into that databank was filed with care. If life were ever found waiting in the dark, it would be in a place exactly like this.",

  ganymede: "The largest moon in the system — bigger than Mercury — and the only one to spin a magnetic field of its own from a churning iron core. A hidden ocean is layered between sheets of ice far below. Rich in ore and well-rounded in every yield, it's a moon that thinks itself a planet, and it has the depth to hide a planet's worth of secrets.",

  callisto: "The most cratered surface in the system, an ancient dark face that has barely changed in four billion years — a museum of every impact the outer system ever threw at it. Far enough from Jupiter to escape the worst of its radiation, it's the calm one of the family. Good credits, good ore, and the patience to have kept whatever it found a very long time ago.",

  // Saturnian system
  saturn: "The jewel of the system, ringed in countless shards of ice that span the gap between worlds yet stand thinner than a mountain is tall. So light it would float on water, it gives up fuel and credits from clouds laced with crystal. A gate could moor in its splendor, or a derelict could hang silent against those rings — beauty and danger orbiting the same center.",

  enceladus: "A blinding white moon that fires geysers of seawater straight into space from cracks at its south pole, feeding one of Saturn's own rings with its hidden ocean. The science here is extraordinary — liquid water, warmth, and the chemistry of life all venting into the dark for anyone to read. Small and brilliant and impossibly alive; the surveys left their best findings here for a reason.",

  rhea: "Saturn's second-largest moon, a frozen world of nearly pure ice and rock that may once have worn a faint, fragile ring of its own. Quiet and balanced in what it offers — a little fuel, a little ore, a little of everything. The kind of cold, clean waypoint where something could lie undisturbed for ages.",

  titan: "The only moon with a true atmosphere — a thick orange haze over lakes and rivers of liquid methane, where it rains hydrocarbons and the chemistry runs deep enough to make anyone wonder. Fuel and science both pour out of this place in abundance. A world stranger than fiction and richer than most planets; if you visit one moon in the whole system, make it this one.",

  // Uranian system
  uranus: "The toppled giant, knocked onto its side by some long-ago blow, so that it rolls around the sun pole-first with seasons that last decades in unbroken light or dark. Beneath pale cyan haze its mantle is a slush of exotic ice. Fuel and science in good measure, and a gate or a wreck waiting in a place that already does everything sideways.",

  miranda: "A small, shattered moon that looks stitched together from mismatched parts — cliffs miles high, terrain that seems torn apart and reassembled by something. Modest ore, modest secrets, outsized strangeness. A jigsaw world that raises more questions than it answers, which is exactly why it's worth the landing.",

  ariel: "The brightest of Uranus's moons, its surface laced with valleys that may once have flowed with icy slush, younger and smoother than its battered siblings. Balanced credits and ore, nothing extreme. A clean, reflective face that has clearly reshaped itself before — and could be hiding what it buried in the process.",

  umbriel: "The darkest of the family, an ancient, dim sphere that drinks the light and gives little back, save for one mysterious bright ring on its surface that no one has ever fully explained. Ore-rich and tight-lipped. The shadowed sibling, keeping a secret it has held longer than any of them.",

  titania: "The largest of Uranus's moons, cut through by enormous canyons where the crust pulled itself apart as a buried ocean froze and expanded long ago. Solid ore, even yields, a respectable haul. A scarred and spacious world with room enough to hide whatever drifted out this far.",

  oberon: "The outermost major moon, an old red-tinged world pocked with craters whose floors are stained dark by some material welling up from below. Good credits and ore for those who come this far. The last waypoint before the giant's reach gives out — and the loneliest place a secret could keep.",

  // Neptunian system
  neptune: "The farthest giant, a deep, vivid blue driven by the fastest winds in the system — supersonic gales howling across a world that receives almost no warmth from the distant sun. Rich in fuel and science, fed by storms that come and vanish like dark eyes opening in the clouds. A gate or a wreck could hide out here at the edge of the sun's domain, where few ever bother to look.",

  proteus: "A dark, lumpy moon riding the very edge of where a body that size can hold itself together as a sphere — any smaller and it would simply be a rock. Balanced ore and yields, nothing flashy. An overlooked guardian at Neptune's gate, the sort of place a careful surveyor leaves things behind.",

  triton: "It circles Neptune backward, against the grain of everything — almost certainly a captured world from the Kuiper belt, dragged into orbit and slowly doomed by it. Nitrogen geysers still erupt across its frozen pink surface, and the science yield runs high. A stolen world remembering a different sky; whatever it brought with it from the deep is still aboard.",

  nereid: "On one of the most stretched, eccentric orbits of any moon, Nereid swings wildly close to Neptune and then far out into the cold before looping back. Modest, even yields and a long, lonely circuit. A wanderer barely held by its world — and the farthest you can drift and still call yourself a moon.",

  // Kuiper belt
  pluto: "Demoted from planet to dwarf yet beloved beyond all of them, Pluto wears a frozen heart of nitrogen ice across a face of red-brown haze and pale mountains of solid water. It shares a near-locked dance with its great moon Charon, the two forever turned toward each other. Rich in credits, deep in cold — but never a gateway; whatever sleeps here, it's bound to this system.",

  charon: "Half the size of the world it orbits, locked face-to-face with Pluto in a waltz that keeps each hanging motionless in the other's sky, scarred by a dark red cap of unknown origin at its pole. Ore-rich and quiet. A companion world more than a moon — and old surveys treated it like one, leaving a collector and a databank in its rock.",

  haumea: "Spun so fast it has stretched itself into an egg, Haumea whirls through the deep belt trailing a ring and a pair of small moons, its surface a glaze of crystalline ice. Ore-rich and far from anywhere. One of the five worlds that might conceal a warp gate — a door to Centauri or Cygnus, hidden on a world already spinning toward the edge of reason.",

  makemake: "A reddish, frozen world out in the cold dark, bright with frozen methane and so distant that its single faint moon went unseen for years. Decent credits and ore for those willing to come this far. One of the five that could hide a gate — and a fittingly remote threshold for a leap between stars.",

  quaoar: "A small frozen world that defies the rules by wearing a ring no one expected it could hold, orbiting impossibly far out where the math says no ring should survive. Ore-rich and strange. One of the five gate-bearers — a world that already keeps one impossible thing, and might keep another.",

  eris: "The world that toppled Pluto — nearly its twin in size, found far beyond it, forcing us to decide what a planet even is. It rides an orbit so distant and tilted that its thin atmosphere freezes and falls as snow for centuries at a time. Wealthy in credits and science, and one of the five that may hide a gate; a world that once redrew the map may yet open a door off it.",

  sedna: "On an orbit so vast a single year outruns eleven thousand of ours, Sedna spends nearly all of time in a cold beyond cold, looping out toward the dark where the sun is just another star. It is rich in metal and may hide a gate to somewhere else entirely — fitting, for a world that already lives halfway to the next system. Few things ever drift this far out; fewer still will be waiting when you arrive.",

  // === Centauri binary system ================================
  binary_barycenter: "Not a body at all, but the still point the whole system turns around — an invisible center of mass where two stars trade their endless pull. Nothing orbits closer to the true heart of this place. There is nothing here to mine and everything here to understand: the hidden pivot on which two suns and all their worlds depend.",

  centauri_a: "The yellow primary, half again as massive as its partner, anchoring the system with its steady golden light. It and its companion chase each other around the barycenter on a tireless cycle, neither ever quite catching the other. You cannot land on a sun — but everything in this system lives or dies by the warmth this one gives.",

  centauri_b: "The orange secondary, smaller and cooler, forever phased to the far side of the dance from its brighter sibling. Together they make a sky no Sol-born eye has seen: two suns, two sets of shadows, two dawns. Unreachable and essential — the second hearth of a system built for two.",

  verdant: "A green world circling two suns at once, and the richest mind in any system — eighteen measures of science from a single harvest, a garden of biology that should not, by any law we know, exist. Everything grows here, including questions. Whatever learned to thrive under a doubled sky has had a very long time to think, and longer still to wait for someone to come asking.",

  crimson: "A deep red giant swollen with fuel and ringing with science, its banded clouds lit blood-dark by the light of two suns. Twelve measures of fuel from a single draw — no world burns richer. It offers no ore and no credits, only power and knowledge in staggering excess; a furnace for an empire bold enough to tap it.",

  prismara: "A pale violet moon hanging against its crimson giant, its strange coloring catching the doubled starlight in ways nothing in Sol ever did. Wealthy in credits and deep in science. A jewel-toned world that looks unreal and yields like a dream — the kind of place explorers cross light-years to stand upon.",

  cinder: "A rusty rock that looks dead and isn't — beneath its burnt surface lies a fortune in credits, ore, and some of the highest science in the system. Two suns have baked it to the color of old iron. Plain to the eye and priceless to the survey; never judge a Centauri world by its face.",

  farspire: "The lonely outpost at the system's edge, a small frozen spire of rock and ice rich in science despite its modest size. Here lies the guaranteed gate home — the fixed door that leads back to whichever far KBO of Sol opened the way out. The end of one journey and the beginning of the road back; every road through Centauri eventually passes through Farspire.",

  // === Cygnus X-1 analogue ===================================
  // Awaiting flavor text — drop entries here for bh_barycenter,
  // cygnus_x, hde_226868, requiem, vellichor, echelon, reliquary.
  bh_barycenter: '',
  cygnus_x: '',
  hde_226868: '',
  requiem: '',
  vellichor: '',
  echelon: '',
  reliquary: '',
};

/** Lookup helper. Returns the flavor string for a body id, or
 *  empty string if none is authored. Callers should treat empty
 *  as "render nothing" rather than a placeholder. */
export function getBodyFlavor(bodyId: string): string {
  return BODY_FLAVOR[bodyId] ?? '';
}
