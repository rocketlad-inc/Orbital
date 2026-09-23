package com.orbitalempire.wear

/**
 * A STAGED EMPIRE, so every screen can be looked at.
 *
 * Two fleets in one orbit, every kind of shot and every kind of hull
 * present: pure kinetic, pure energy, a mixed loadout, a shielded target
 * (a slug splashes on it), an armoured target (a lance throws spall), a
 * hull at a third of its health (sparks and smoke) and a wreck (flash,
 * shockwave, debris).
 *
 * Reached ONLY through `am start --ez fxdemo true`, which the wear smoke
 * run uses to photograph the app. A real two-sided fight in the probe
 * game is systems apart and an hour of ticks away, and effects nobody
 * can photograph are effects nobody can check -- and the CI faction
 * holds two ships and no shipyard, so every other screen photographs as
 * an empty state.
 *
 * NOTHING HERE REACHES A PLAYER. The flag is an intent extra with no UI
 * behind it, and the view model refuses to fetch while it is set, so
 * staged numbers can never be mistaken for a real empire's.
 */
object FxDemo {
  const val BODY = "demo:titania"

  private fun ship(
    i: Int,
    mine: Boolean,
    cls: String,
    hp: Int,
    energy: Float,
    shields: Int = 0,
    armor: Int = 0,
    target: String,
  ) = OrbitShip(
    id = "demo:s$i",
    name = "Demo $i",
    key = "$cls:A:green",
    cls = cls,
    hp = hp,
    faction = if (mine) "demo:f0" else "demo:f1",
    fleet = null,
    lead = i == 0,
    fighting = true,
    target = target,
    energy = energy,
    shields = shields,
    armor = armor,
    firedTick = 100,
  )

  val worlds: Worlds by lazy {
    val ships = listOf(
      // Mine: a kinetic corvette, an energy destroyer, a mixed frigate.
      ship(0, true, "corvette", 100, 0f, target = "demo:s3"),
      ship(1, true, "destroyer", 78, 1f, target = "demo:s4"),
      ship(2, true, "frigate", 30, 0.5f, target = "demo:s5"),
      // Theirs: shielded (kinetic splashes), armoured (energy spalls),
      // and one already badly hurt.
      ship(3, false, "frigate", 64, 0f, shields = 2, target = "demo:s0"),
      ship(4, false, "corvette", 92, 1f, armor = 2, target = "demo:s1"),
      ship(5, false, "destroyer", 22, 0.5f, target = "demo:s2"),
    )
    val world = World(
      id = BODY,
      name = "Titania",
      type = "moon",
      color = "#9a9088",
      radius = 1.5,
      parent = "Uranus",
      owner = "demo:f0",
      firing = true,
      battle = true,
      counts = mapOf("demo:f0" to 3, "demo:f1" to 3),
      ships = ships,
      dead = listOf(Wreck("demo:wreck", "frigate", "demo:f1", 100)),
      sp = "titania~moon~9a9088~0~0~0",
    )
    Worlds(
      tick = 100,
      me = "demo:f0",
      factions = mapOf(
        "demo:f0" to FactionInfo("Outer Alliance", "#42a5f5"),
        "demo:f1" to FactionInfo("Solar Directorate", "#ff7043"),
      ),
      worlds = listOf(world),
      systems = emptyList(),
      state = "live",
    )
  }
}

  /** A faction worth showing: the Empire screen and tile, the Senate,
   *  the battle list and the complications, all with something in them. */
  val state: WearState by lazy {
    WearState(
      phase = "live",
      game = "The MEGA Zone",
      faction = "Outer Alliance",
      color = "#42a5f5",
      tick = 412,
      nextTickAt = System.currentTimeMillis() + 11 * 60_000L,
      serverNow = System.currentTimeMillis(),
      metal = 37_400,
      credits = 62_600,
      science = 150_200,
      perTick = PerTick(metal = 570.0, credits = 1036.0, science = 269.0, netMetal = 438.0, netCredits = 902.0, samples = 12),
      attention = Attention(fighting = 1, inbound = 5, bills = 1, unread = 2, offers = 1),
      battles = listOf(
        Battle(
          body = "Titania",
          bodyId = BODY,
          sides = listOf(
            Side("Outer Alliance", "#42a5f5", true, 3, 48, listOf(100.0, 78.0, 30.0)),
            Side("Solar Directorate", "#ff7043", false, 3, 39, listOf(64.0, 92.0, 22.0)),
          ),
          kills = 2,
          lost = 1,
          known = true,
        ),
      ),
      threats = listOf(Threat("Oberon", 5, 2)),
      senate = listOf(
        Bill(
          id = "demo:bill",
          kind = "sanction",
          title = "Sanction the Solar Directorate",
          summary = "Cut their trade for six ticks.",
          closesIn = 2,
          myVote = null,
          yea = 3,
          nay = 2,
        ),
      ),
      ships = 140,
      building = 3,
      inCombat = 12,
      research = Research("sensors", "Sensors", 4, 148, 240),
      domination = Domination(owned = 25, total = 60, need = 37),
      situation = SituationBadge(count = 6, now = true, at = System.currentTimeMillis() - 120_000L),
    )
  }

  /** The board the Territory screen and tile draw. */
  val board: Board by lazy {
    Board(
      state = "live",
      tick = 412,
      me = "demo:f0",
      total = 60,
      claimed = 47,
      unclaimed = 13,
      systemsTotal = 11,
      need = 37,
      factions = listOf(
        Standing("demo:f1", "Solar Directorate", "#ff7043", false, false, 25, 5, 6, 96, null, null, null),
        Standing("demo:f0", "Outer Alliance", "#42a5f5", true, false, 16, 3, 4, 140, 37_400, 62_600, 150_200),
        Standing("demo:f2", "Hanseatic Reach", "#ab47bc", false, false, 6, 2, 3, null, null, null, null),
        Standing("demo:f3", "Tycho Compact", "#66bb6a", false, true, 0, 0, 0, null, null, null, null),
      ),
    )
  }
