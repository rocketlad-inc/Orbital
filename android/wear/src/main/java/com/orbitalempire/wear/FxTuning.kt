package com.orbitalempire.wear

import androidx.compose.ui.graphics.Color
import org.json.JSONObject

/**
 * THE FIGHT'S COLOURS AND CLOCK, AS THE SERVER SENDS THEM.
 *
 * The game animates combat by one set of numbers (src/render/fxTuning.ts)
 * and worlds.json hands the same object to the watch as `fx`. The
 * Porthole reads every timing and colour from here, so a change in the
 * game -- "slow the fire rate" -- reaches the wrist with a deploy, no
 * release. Only a new KIND of effect needs the app to learn to draw it.
 *
 * The defaults are the game's numbers as of this build, used until the
 * first feed arrives and for any field an older server does not send.
 */
data class FxPalette(val core: Color, val glow: Color, val haze: Color)

data class FxTuning(
  val kinetic: FxPalette = FxPalette(hex("#fff4d8"), hex("#ffae4a"), hex("#ff7a1a")),
  val energy: FxPalette = FxPalette(hex("#f2fdff"), hex("#5cc8ff"), hex("#2f86ff")),
  val shield: FxPalette = FxPalette(hex("#eafffd"), hex("#4ee6d8"), hex("#1fa5c4")),
  val fire: FxPalette = FxPalette(hex("#fff6dc"), hex("#ff9a3c"), hex("#d2401a")),
  val boltMs: Float = 750f,
  val beatMs: Float = 2400f,
  val fireReference: Float = 6f,
  val muzzleMs: Float = 130f,
  val impactMs: Float = 380f,
  val roundGapMs: Float = 70f,
  val chargeMs: Float = 180f,
  val flakBurstMs: Float = 1000f,
  val flakCycleMs: Float = 750f,
  val flakMaxStreams: Int = 9,
  val damageShowTicks: Int = 1,
  val crippledBelow: Float = 0.34f,
  val igniteDelayMs: Float = 550f,
  val igniteRampMs: Float = 450f,
  val explosionMs: Float = 1600f,
  val breakupFlyMs: Float = 1800f,
  val breakupHeatMs: Float = 2600f,
) {
  companion object {
    /** What the Porthole draws by: the last feed's, or the defaults. */
    @Volatile
    var current = FxTuning()

    /** The tuning in a feed, every missing or malformed field falling
     *  back to this build's default rather than failing the whole feed. */
    fun parse(o: JSONObject?): FxTuning? {
      if (o == null) return null
      val d = FxTuning()
      fun f(k: String, def: Float): Float {
        val v = o.optDouble(k, Double.NaN)
        return if (v.isNaN() || v <= 0.0) def else v.toFloat()
      }
      fun pal(k: String, def: FxPalette): FxPalette {
        val p = o.optJSONObject(k) ?: return def
        return FxPalette(
          hexOr(p.optString("core"), def.core),
          hexOr(p.optString("glow"), def.glow),
          hexOr(p.optString("haze"), def.haze),
        )
      }
      return FxTuning(
        kinetic = pal("kinetic", d.kinetic),
        energy = pal("energy", d.energy),
        shield = pal("shield", d.shield),
        fire = pal("fire", d.fire),
        boltMs = f("boltMs", d.boltMs),
        beatMs = f("beatMs", d.beatMs),
        fireReference = f("fireReference", d.fireReference),
        muzzleMs = f("muzzleMs", d.muzzleMs),
        impactMs = f("impactMs", d.impactMs),
        roundGapMs = f("roundGapMs", d.roundGapMs),
        chargeMs = f("chargeMs", d.chargeMs),
        flakBurstMs = f("flakBurstMs", d.flakBurstMs),
        flakCycleMs = f("flakCycleMs", d.flakCycleMs),
        flakMaxStreams = f("flakMaxStreams", d.flakMaxStreams.toFloat()).toInt(),
        damageShowTicks = f("damageShowTicks", d.damageShowTicks.toFloat()).toInt(),
        crippledBelow = f("crippledBelow", d.crippledBelow),
        igniteDelayMs = f("igniteDelayMs", d.igniteDelayMs),
        igniteRampMs = f("igniteRampMs", d.igniteRampMs),
        explosionMs = f("explosionMs", d.explosionMs),
        breakupFlyMs = f("breakupFlyMs", d.breakupFlyMs),
        breakupHeatMs = f("breakupHeatMs", d.breakupHeatMs),
      )
    }
  }
}

private fun hex(s: String): Color = Color(android.graphics.Color.parseColor(s))

private fun hexOr(s: String?, def: Color): Color =
  if (s != null && Regex("^#[0-9a-fA-F]{6}$").matches(s)) hex(s) else def

/**
 * EACH CLASS'S DEFAULT HULL, as the server names it (worlds.json
 * `hulls`): what the yard, pickers and placeholders draw before a ship
 * of that class exists. The letter is the game's to change, so the watch
 * asks rather than writing one in; [classKey] falls back to its own
 * guess only until the first feed arrives.
 */
object ServerHulls {
  @Volatile
  var keys: Map<String, String> = emptyMap()

  fun parse(o: JSONObject?): Map<String, String>? {
    if (o == null) return null
    val out = HashMap<String, String>()
    for (k in o.keys()) o.optString(k).takeIf { it.isNotEmpty() }?.let { out[k] = it }
    return out
  }
}
