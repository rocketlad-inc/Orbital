package com.orbitalempire.wear

import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.rotate
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.min
import kotlin.math.sin

/**
 * THE FIGHT, IN THE GAME'S OWN LANGUAGE.
 *
 * The map draws combat with a vocabulary a player learns to read at a
 * glance (src/render/combatFx.ts), and the Porthole now speaks it:
 *
 *   KINETIC   a muzzle bloom, a slug that crosses the gap with a hot
 *             head and a short tail, and an impact of ring plus shards.
 *   ENERGY    a charge that builds at the emitter, then a bright-cored
 *             lance across the whole gap, ending in a soft bloom rather
 *             than shrapnel.
 *   MIXED     a loadout alternates per volley at its real kinetic/energy
 *             ratio, seeded on shooter and volley, so the mix is steady
 *             but never a metronome. The same rule the map uses.
 *
 * WHAT STOPS A SHOT SHOWS TOO. Shields cut kinetic and armour cuts
 * energy (shipParts.defenseMitigation), so a slug landing on a shielded
 * hull splashes on a shield arc instead of throwing shards, and a lance
 * landing on armour throws hot spall instead of blooming. The watch is
 * reading the same two numbers the server mitigates by, so what you see
 * is what the arithmetic did.
 *
 * A DYING HULL SAYS SO: under two thirds it trails smoke, under a third
 * it sheds sparks. And a hull that was KILLED since the last poll gets
 * the map's wreck -- a flash, a shockwave and debris thrown outward --
 * rather than quietly ceasing to be there between two fetches.
 *
 * All of it is drawn from the feed's own numbers on a local clock, so a
 * battle animates continuously between 30-second polls without ever
 * claiming a shot the server did not stamp.
 */

// The map's palette for the two damage types.
private val ENERGY_GLOW = Color(0xFF39D7FF)
private val ENERGY_CORE = Color(0xFFE6FBFF)
private val KINETIC_HEAD = Color(0xFFFFF2C4)
private val MUZZLE = Color(0xFFFFC46B)
private val SHIELD = Color(0xFF6FC7FF)
private val SPALL = Color(0xFFFF9A3C)
private val SMOKE = Color(0xFF30363E)
private val FIRE = Color(0xFFFF9632)
private val EMBER = Color(0xFFFFF0BE)

/** The map shows a hull's damage for one tick after it takes it. */
private const val DAMAGE_SHOW_TICKS = 1

/** One volley, start to finish. */
private const val VOLLEY_MS = 560f
private const val MUZZLE_MS = 130f
private const val CHARGE_MS = 180f
private const val BEAM_MS = 200f
private const val TRAVEL_START = 60f
private const val TRAVEL_MS = 300f
private const val IMPACT_MS = 200f

/** Deterministic 0..1 from a shooter and its volley number. */
private fun roll(id: String, volley: Long): Float {
  var h = id.hashCode() xor (volley * 0x9E3779B1L).toInt()
  h = h xor (h ushr 15)
  h *= 0x85EBCA6B.toInt()
  h = h xor (h ushr 13)
  return (abs(h) % 10_000) / 10_000f
}

/**
 * Every shot in this orbit, this frame.
 *
 * [firing] is the server's word that the battle is exchanging fire this
 * tick; a battle that is open but quiet is a standoff and draws nothing.
 */
internal fun DrawScope.drawBattleFx(
  worlds: Worlds,
  slots: List<Slot>,
  positions: Map<String, Offset>,
  t: Long,
  density: Float,
  firing: Boolean,
  targets: Map<String, String>,
) {
  val byId = HashMap<String, OrbitShip>(slots.size)
  for (s in slots) byId[s.ship.id] = s.ship

  // Hurt hulls burn whether or not anyone is shooting right now.
  for (s in slots) {
    val p = positions[s.ship.id] ?: continue
    damageBurn(s.ship, p, t, worlds.tick, density, s.iconDp * density)
  }
  if (!firing) return

  for (s in slots) {
    val shooter = s.ship
    val targetId = targets[shooter.id] ?: continue
    val from = positions[shooter.id] ?: continue
    val to = positions[targetId] ?: continue
    val target = byId[targetId]
    // Each shooter keeps its own rhythm, so a big fight crackles rather
    // than blinking in unison.
    val beat = 1100 + (abs(shooter.id.hashCode()) % 900)
    val phase = abs(shooter.id.hashCode() / 7) % beat
    val since = (t + phase) % beat
    if (since > VOLLEY_MS) continue
    val volley = (t + phase) / beat
    val k = since.toFloat()
    // Which gun fires THIS volley, at the loadout's real ratio.
    val energyShot = shooter.energy > 0f && (shooter.energy >= 1f || roll(shooter.id, volley) < shooter.energy)
    val livery = factionColor(worlds.colorOf(shooter.faction))
    if (energyShot) energyVolley(from, to, k, livery, target, density)
    else kineticVolley(from, to, k, livery, target, density)
  }
}

/** A slug: muzzle bloom, a crossing round, shards or a shield splash. */
private fun DrawScope.kineticVolley(
  from: Offset,
  to: Offset,
  k: Float,
  livery: Color,
  target: OrbitShip?,
  density: Float,
) {
  if (k < MUZZLE_MS) {
    val f = 1f - k / MUZZLE_MS
    drawCircle(MUZZLE.copy(alpha = 0.75f * f), radius = (1.5f + 2.5f * f) * density, center = from)
  }
  val travel = ((k - TRAVEL_START) / TRAVEL_MS).coerceIn(0f, 1f)
  if (travel > 0f && travel < 1f) {
    val head = Offset(from.x + (to.x - from.x) * travel, from.y + (to.y - from.y) * travel)
    val tailAt = (travel - 0.16f).coerceAtLeast(0f)
    val tail = Offset(from.x + (to.x - from.x) * tailAt, from.y + (to.y - from.y) * tailAt)
    drawLine(livery.copy(alpha = 0.85f), tail, head, strokeWidth = 1.3f * density)
    drawCircle(KINETIC_HEAD, radius = 1.3f * density, center = head)
  }
  val land = k - (TRAVEL_START + TRAVEL_MS)
  if (land in 0f..IMPACT_MS) {
    val f = land / IMPACT_MS
    if ((target?.shields ?: 0) > 0) shieldSplash(to, from, f, density)
    else {
      // Ring and shards: the map's ballistic impact.
      drawCircle(
        KINETIC_HEAD.copy(alpha = 0.8f * (1f - f)),
        radius = (1.5f + 5f * f) * density,
        center = to,
        style = Stroke(width = 1f * density),
      )
      for (i in 0 until 4) {
        val a = (i * 1.9f) + f * 1.2f
        val r0 = (2f + 3f * f) * density
        val r1 = r0 + 2.5f * density
        drawLine(
          MUZZLE.copy(alpha = 0.7f * (1f - f)),
          Offset(to.x + cos(a) * r0, to.y + sin(a) * r0),
          Offset(to.x + cos(a) * r1, to.y + sin(a) * r1),
          strokeWidth = 0.9f * density,
        )
      }
    }
  }
}

/** A lance: a charge at the emitter, a cored beam, then a bloom. */
private fun DrawScope.energyVolley(
  from: Offset,
  to: Offset,
  k: Float,
  livery: Color,
  target: OrbitShip?,
  density: Float,
) {
  if (k < CHARGE_MS) {
    val f = k / CHARGE_MS
    drawCircle(ENERGY_GLOW.copy(alpha = 0.25f + 0.55f * f), radius = (0.8f + 2.2f * f) * density, center = from)
  }
  val b = k - CHARGE_MS
  if (b in 0f..BEAM_MS) {
    // Snap on, fade off -- the beam is brightest the moment it lands.
    val a = if (b < BEAM_MS * 0.2f) b / (BEAM_MS * 0.2f) else 1f - (b - BEAM_MS * 0.2f) / (BEAM_MS * 0.8f)
    drawLine(ENERGY_GLOW.copy(alpha = 0.35f * a), from, to, strokeWidth = 3.2f * density)
    drawLine(ENERGY_CORE.copy(alpha = 0.9f * a), from, to, strokeWidth = 1.1f * density)
    drawCircle(ENERGY_CORE.copy(alpha = 0.8f * a), radius = 1.4f * density, center = from)
    // Livery stays in the shot, so you can still tell whose lance it is.
    drawCircle(livery.copy(alpha = 0.5f * a), radius = 2.4f * density, center = from)
  }
  val land = k - (CHARGE_MS + BEAM_MS)
  if (land in 0f..IMPACT_MS) {
    val f = land / IMPACT_MS
    if ((target?.armor ?: 0) > 0) {
      // Armour throws hot spall rather than blooming.
      for (i in 0 until 5) {
        val a = i * 1.27f + f
        val r = (1.5f + 6f * f) * density
        drawCircle(SPALL.copy(alpha = 0.8f * (1f - f)), radius = 0.8f * density, center = Offset(to.x + cos(a) * r, to.y + sin(a) * r))
      }
    } else {
      drawCircle(ENERGY_GLOW.copy(alpha = 0.55f * (1f - f)), radius = (1.5f + 6f * f) * density, center = to)
      drawCircle(ENERGY_CORE.copy(alpha = 0.7f * (1f - f)), radius = (0.8f + 2f * f) * density, center = to)
    }
  }
}

/** A shield holding: an arc facing the shot, flaring where it lands. */
private fun DrawScope.shieldSplash(at: Offset, from: Offset, f: Float, density: Float) {
  val r = 5.5f * density
  val facing = Math.toDegrees(kotlin.math.atan2((from.y - at.y).toDouble(), (from.x - at.x).toDouble())).toFloat()
  rotate(facing, pivot = at) {
    drawArc(
      color = SHIELD.copy(alpha = 0.75f * (1f - f)),
      startAngle = -55f,
      sweepAngle = 110f,
      useCenter = false,
      topLeft = Offset(at.x - r, at.y - r),
      size = Size(r * 2, r * 2),
      style = Stroke(width = (1.6f - 0.8f * f) * density),
    )
  }
  drawCircle(SHIELD.copy(alpha = 0.3f * (1f - f)), radius = (2f + 3f * f) * density, center = at)
}

/**
 * A HULL THAT WAS HIT LAST TURN BURNS, and a crippled one keeps burning.
 *
 * The map's own rule (combatFx drawBattleDamageStates): show it if the
 * ship took damage within DAMAGE_SHOW_TICKS -- one tick -- or if it is
 * under a third of its hull, and scale the severity by how hurt it is.
 * The drawing is fxPrimitives.drawBurn at watch size: smoke puffs
 * cycling outward and upward underneath, then a couple of flickering
 * fires with hot white cores over the top.
 *
 * [tick] is the game's tick, which is what "last turn" is measured in;
 * [t] is the local clock the flicker runs on.
 */
private fun DrawScope.damageBurn(s: OrbitShip, p: Offset, t: Long, tick: Int, density: Float, size: Float) {
  val hp = s.hp ?: return
  val frac = hp / 100f
  val recent = s.damagedTick != null && tick - s.damagedTick < 1 + DAMAGE_SHOW_TICKS
  val crippled = frac < 0.34f
  if (!recent && !crippled) return
  // Severity: the map's max(recent ? 0.5 : 0.25, 1 - frac).
  val sev = maxOf(if (recent) 0.5f else 0.25f, 1f - frac)
  val baseR = maxOf(3f * density, size * 0.4f)
  val ph = ((abs(s.id.hashCode()) % 1000) / 1000f) * 6.2832f

  // Smoke first, under the fire: puffs drifting out and up, fading.
  val puffs = 2 + sev.toInt()
  for (i in 0..puffs) {
    val drift = (((t / 1400f) + i.toFloat() / (puffs + 1) + ph) % 1f)
    val sx = p.x + cos(ph + i * 2.4f) * baseR * 0.3f + drift * baseR * 0.5f
    val sy = p.y - drift * baseR * 1.1f
    drawCircle(
      SMOKE.copy(alpha = (1f - drift) * 0.3f * sev),
      radius = baseR * (0.22f + drift * 0.3f),
      center = Offset(sx, sy),
    )
  }
  // Fires over it: a slow flicker with a hot core, per-hull phase so two
  // burning ships never pulse together.
  val fires = 1 + (sev * 2f).toInt()
  for (i in 0 until fires) {
    val a = ph + i * 2.3f
    val fx = p.x + cos(a) * baseR * 0.4f
    val fy = p.y + sin(a) * baseR * 0.4f
    val f = 0.55f + 0.45f * sin(t / 130f + i * 2f + ph)
    val r = baseR * (0.28f + 0.18f * sev) * (0.7f + 0.5f * f)
    drawCircle(FIRE.copy(alpha = 0.45f * f * sev), radius = r, center = Offset(fx, fy - r * 0.25f))
    drawCircle(EMBER.copy(alpha = 0.8f * f * sev), radius = r * 0.4f, center = Offset(fx, fy - r * 0.25f))
  }
}

/**
 * THE ENGINE, NOT A RIBBON. Every hull in orbit is under way, and the
 * map draws that as an exhaust cone at the bell -- a hot core fading out
 * through the faction's own tint to nothing (fxPrimitives
 * drawThrustExhaust). The Porthole drew a flat arc behind the ship
 * instead, which read as a trail left behind rather than a ship under
 * thrust.
 *
 * [heading] is the direction of travel; the plume goes the other way.
 */
internal fun DrawScope.enginePlume(
  at: Offset,
  heading: Float,
  size: Float,
  livery: Color,
  t: Long,
  seed: Int,
) {
  val dx = cos(heading)
  val dy = sin(heading)
  // Sized to the icon, as the map sizes it to the hull.
  val flicker = 0.85f + 0.15f * sin(t / 90f + (abs(seed) % 628) / 100f)
  val len = size * 1.25f * flicker
  val wide = size * 0.26f
  // The bell sits at the stern, not the centre of the sprite.
  val bell = Offset(at.x - dx * size * 0.42f, at.y - dy * size * 0.42f)
  val tail = Offset(bell.x - dx * len, bell.y - dy * len)
  val px = -dy
  val py = dx
  // Body of the cone: flared at the bell, gone by the tail.
  val cone = Path().apply {
    moveTo(bell.x + px * wide, bell.y + py * wide)
    lineTo(tail.x, tail.y)
    lineTo(bell.x - px * wide, bell.y - py * wide)
    close()
  }
  drawPath(
    cone,
    Brush.linearGradient(
      0f to EMBER.copy(alpha = 0.85f),
      0.3f to livery.copy(alpha = 0.55f),
      1f to FIRE.copy(alpha = 0f),
      start = bell,
      end = tail,
    ),
  )
  // The hot core at the nozzle: short, bright, and the only additive bit.
  drawCircle(EMBER.copy(alpha = 0.9f * flicker), radius = size * 0.09f, center = bell)
}

/**
 * A KILL, AND WHAT IT LEAVES.
 *
 * Two stages, because the map has two: the death, and the wreckage that
 * outlives it.
 *
 *   EXPLOSION  a white flash, a shockwave ring and burning debris
 *              thrown outward, over about two seconds. [age] is time
 *              since this Porthole first drew it -- and the Porthole
 *              forgets when it closes, so OPENING a world replays the
 *              deaths that happened there. That is the ask: you look in,
 *              and you see what happened.
 *
 *   DEBRIS     the shards stay where they were thrown, drifting slowly
 *              outward and cooling, for as long as the server still
 *              reports the wreck -- three ticks (wearWorlds
 *              WRECK_WINDOW_TICKS). An orbit that lost a destroyer an
 *              hour ago still looks like it.
 *
 * [fade] is how far through that three-tick life the wreck is, 0 fresh
 * to 1 about to be forgotten, so the debris thins out rather than
 * vanishing between two polls.
 */
internal fun DrawScope.drawWreck(at: Offset, livery: Color, age: Long, fade: Float, density: Float) {
  val life = 2200f
  val f = (age / life).coerceIn(0f, 1f)
  val cooling = (1f - fade).coerceIn(0f, 1f)

  if (f < 1f) {
    // The flash, and the shockwave that outlives it.
    if (f < 0.18f) {
      val k = 1f - f / 0.18f
      drawCircle(Color.White.copy(alpha = 0.9f * k), radius = (2f + 9f * (1f - k)) * density, center = at)
    }
    drawCircle(
      MUZZLE.copy(alpha = 0.55f * (1f - f)),
      radius = (3f + 22f * f) * density,
      center = at,
      style = Stroke(width = (1.8f - 1.2f * f) * density),
    )
  }

  // The debris itself: thrown out fast, then drifting. Each shard keeps
  // its own line, so the wreck reads as wreckage and not as a dot.
  for (i in 0 until 7) {
    val a = i * 0.92f + (at.x + at.y) * 0.01f
    val speed = 10f + (i % 3) * 5f
    // Thrown during the explosion, then a slow drift for the rest of it.
    val d = (speed * min(1f, f * 2.2f) + 6f * f + 7f * fade) * density
    val p0 = Offset(at.x + cos(a) * d, at.y + sin(a) * d)
    val p1 = Offset(p0.x + cos(a) * 2.2f * density, p0.y + sin(a) * 2.2f * density)
    drawLine(livery.copy(alpha = 0.2f + 0.65f * cooling), p0, p1, strokeWidth = 1f * density)
    // A shard still glowing, only while the blast is fresh.
    if (f < 1f && i % 3 == 0) {
      drawCircle(EMBER.copy(alpha = 0.7f * (1f - f)), radius = 0.8f * density, center = p1)
    }
  }
}
