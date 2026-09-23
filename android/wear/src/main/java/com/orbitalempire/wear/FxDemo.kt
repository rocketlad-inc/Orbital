package com.orbitalempire.wear

/**
 * A STAGED BATTLE, so the effects can be looked at.
 *
 * Two fleets in one orbit, every kind of shot and every kind of hull
 * present: pure kinetic, pure energy, a mixed loadout, a shielded target
 * (a slug splashes on it), an armoured target (a lance throws spall), a
 * hull at a third of its health (sparks and smoke) and a wreck (flash,
 * shockwave, debris).
 *
 * Reached ONLY through `am start --ez fxdemo true`, which the wear smoke
 * run uses to photograph the effects. A real two-sided fight in the
 * probe game is systems apart and an hour of ticks away, and effects
 * nobody can photograph are effects nobody can check.
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
