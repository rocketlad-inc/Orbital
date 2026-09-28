package com.orbitalempire.wear

/**
 * THE WATCH'S OWN READING OF THE EMPIRE: fleets as the player thinks of
 * them, and the list of things that need an answer. Everything here is
 * derived from the server's documents (state.json, command.json,
 * worlds.json) and nothing is a rule of the game -- the game's rules stay
 * on the server, and these are only ways of grouping what it sent.
 */

/** One fleet as the player commands it: a fleet, or a loose hull. */
data class FleetGroup(val id: String, val lead: CmdShip, val ships: List<CmdShip>) {
  val size: Int get() = ships.size
  val ids: List<String> get() = ships.map { it.id }
  val moving: Boolean get() = lead.moving
  val at: String? get() = lead.at
  val dest: String? get() = lead.dest
  val eta: Int? get() = ships.mapNotNull { it.eta }.maxOrNull()
  val pending: Boolean get() = ships.any { it.pending }
  val hp: Int get() = if (ships.isEmpty()) 100 else ships.sumOf { it.hp } / ships.size
  val captain: Captain? get() = lead.captain ?: ships.firstNotNullOfOrNull { it.captain }
  val rested: Int? get() = ships.mapNotNull { it.rested }.maxOrNull()
  /** "VANGUARD ×5", or the hull's own name. */
  val title: String get() = if (size > 1) "${lead.name.uppercase()} ×$size" else lead.name.uppercase()
  /** The flagship's hull, coloured by the fleet's average health. */
  val hullKey: String get() = keyWithHealth(lead.key, hp)
}

private val CLASS_RANK = mapOf(
  "mega_destroyer" to 0, "destroyer" to 1, "frigate" to 2, "corvette" to 3,
  "mobile_foundry" to 4, "freighter" to 5, "colony" to 6,
)

/**
 * Fleets and loose hulls. The flagship is the hull with a captain, then
 * the heaviest, then by name -- the one whose face and hull the roster
 * shows.
 */
fun groupsOf(cmd: Command): List<FleetGroup> {
  val out = ArrayList<FleetGroup>()
  for ((fleet, ships) in cmd.ships.groupBy { it.fleet ?: "ship:${it.id}" }) {
    val lead = ships.sortedWith(
      compareBy<CmdShip>({ it.captain == null }, { CLASS_RANK[it.cls] ?: 9 }, { it.name }),
    ).first()
    out += FleetGroup(fleet, lead, ships)
  }
  return out
}

/** The group a ship belongs to. */
fun groupOf(cmd: Command, shipId: String): FleetGroup? = groupsOf(cmd).firstOrNull { g -> g.ships.any { it.id == shipId } }

/** The icon key with its health bucket replaced: 66+ green, 33+ amber. */
fun keyWithHealth(key: String, hp: Int): String {
  val base = key.substringBeforeLast(':')
  val bucket = when {
    hp >= 66 -> "green"
    hp >= 33 -> "amber"
    else -> "red"
  }
  return "$base:$bucket"
}

/** A hull class's default drawing, for hulls not yet built (the yard). */
fun classKey(cls: String): String = when (cls) {
  "freighter", "colony" -> "$cls:A:green"
  "corvette", "frigate", "destroyer" -> "$cls:B:green"
  else -> "corvette:B:green"
}

/** A body's name and sprite, wherever the watch has seen it. */
data class Place(val id: String, val name: String, val sp: String?, val color: String?)

fun placeOf(worlds: Worlds?, id: String?): Place? {
  if (id == null) return null
  worlds?.systems?.forEach { s ->
    s.bodies.firstOrNull { it.id == id }?.let { return Place(it.id, it.name, it.sp, it.color) }
  }
  worlds?.world(id)?.let { return Place(it.id, it.name, it.sp, it.color) }
  // Not in sight: the id's own tail, which is the body's slug.
  val slug = id.substringAfterLast(':').replace('_', ' ')
  return Place(id, slug.split(' ').joinToString(" ") { w -> w.replaceFirstChar { it.uppercase() } }, null, null)
}

/** Every body the watch knows, for voice and the map. */
fun allPlaces(worlds: Worlds?): List<Place> =
  worlds?.systems?.flatMap { s -> s.bodies.map { Place(it.id, it.name, it.sp, it.color) } } ?: emptyList()

/**
 * SOMETHING THAT NEEDS YOU, and its answer. The Decisions page is a stack
 * of these, one to a screen, each with the button that answers it.
 */
sealed class Decision {
  /** Matches an alert's ref (battle:<id>, bill:<id>, trade:<id>). */
  abstract val key: String
  /** 0 danger (red), 1 decision (amber), 2 opportunity (teal). */
  abstract val tier: Int

  data class Fight(val battle: Battle, val mine: List<CmdShip>) : Decision() {
    override val key get() = "battle:${battle.id ?: battle.bodyId}"
    override val tier get() = 0
  }
  data class Vote(val bill: Bill) : Decision() {
    override val key get() = "bill:${bill.id}"
    override val tier get() = if (bill.closesIn <= 1) 0 else 1
  }
  data class Trade(val offer: Offer) : Decision() {
    override val key get() = "trade:${offer.id}"
    override val tier get() = 1
  }
  data class Peace(val war: War) : Decision() {
    override val key get() = "war:${war.with}"
    override val tier get() = 1
  }
  data class Research(val options: List<ResearchOption>) : Decision() {
    override val key get() = "research"
    override val tier get() = 1
  }
  data class IdleYard(val yard: Yard) : Decision() {
    override val key get() = "yard:${yard.body}"
    override val tier get() = 2
  }
  data class Idle(val group: FleetGroup, val arrived: Boolean, val idleTicks: Int) : Decision() {
    override val key get() = "fleet:${group.id}"
    override val tier get() = 2
  }
}

/** How many idle fleets make the stack before the rest wait in Fleets. */
private const val IDLE_CARDS = 3

fun decisionsOf(s: WearState, cmd: Command?): List<Decision> {
  if (!s.isLive) return emptyList()
  val out = ArrayList<Decision>()
  val fightingAt = s.battles.mapNotNull { it.bodyId }.toSet()
  for (b in s.battles) {
    val mine = cmd?.ships?.filter { it.at == b.bodyId && !it.moving } ?: emptyList()
    out += Decision.Fight(b, mine)
  }
  // Bills you can still vote on and have not; closing ones first.
  for (bill in s.senate.filter { !it.debating && it.myVote == null }.sortedBy { it.closesIn }) out += Decision.Vote(bill)
  cmd?.wars?.filter { it.ceasefire == "theirs" }?.forEach { out += Decision.Peace(it) }
  cmd?.offers?.forEach { out += Decision.Trade(it) }
  if (s.research == null && s.researchOptions.any { !it.maxed }) out += Decision.Research(s.researchOptions)
  cmd?.yards?.filter { it.queue.isEmpty() }?.forEach { out += Decision.IdleYard(it) }
  if (cmd != null) {
    val idle = groupsOf(cmd)
      .filter { g -> !g.moving && !g.pending && g.at != null && g.at !in fightingAt && g.rested != null && g.rested!! > 0 }
      .map { g ->
        val since = cmd.tick - (g.rested ?: cmd.tick)
        Decision.Idle(g, arrived = since <= 1, idleTicks = since.coerceAtLeast(0))
      }
      // NOT EVERY PARKED HULL IS A QUESTION. A garrison at home or a
      // freighter between runs is parked on purpose, and a stack that
      // always shows them is a stack nobody reads. A fleet that has just
      // ARRIVED is waiting for its next order, and an idle colony ship is
      // a settlement not being made: those two are asked. The rest are
      // listed under IDLE on the Fleets page.
      .filter { d -> d.arrived || d.group.ships.any { it.cls == "colony" } }
      // Just arrived first (the fleet you sent is waiting for its next
      // order), then the biggest.
      .sortedWith(compareByDescending<Decision.Idle> { it.arrived }.thenByDescending { it.group.size })
    out += idle.take(IDLE_CARDS)
  }
  return out.sortedBy { it.tier }
}
