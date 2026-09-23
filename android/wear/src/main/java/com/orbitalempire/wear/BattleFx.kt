package com.orbitalempire.wear

import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
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
private val SMOKE = Color(0xFF6B6259)

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
fun DrawScope.drawBattleFx(
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

  // Hurt hulls smoulder whether or not anyone is shooting right now.
  for (s in slots) {
    val p = positions[s.ship.id] ?: continue
    damageTrail(s.ship, p, t, density)
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

/** Smoke under two thirds, sparks under a third -- the map's damage states. */
private fun DrawScope.damageTrail(s: OrbitShip, p: Offset, t: Long, density: Float) {
  val hp = s.hp ?: return
  if (hp > 66) return
  val n = if (hp <= 33) 3 else 2
  for (i in 0 until n) {
    val period = 900L + (abs(s.id.hashCode() + i * 31) % 500)
    val f = ((t + i * 260L) % period) / period.toFloat()
    val drift = (4f + 6f * f) * density
    val a = (s.id.hashCode() + i * 97) * 0.017f
    val at = Offset(p.x + cos(a) * drift, p.y + sin(a) * drift)
    if (hp <= 33 && i == 0) {
      drawCircle(SPALL.copy(alpha = 0.75f * (1f - f)), radius = 0.9f * density, center = at)
    } else {
      drawCircle(SMOKE.copy(alpha = 0.4f * (1f - f)), radius = (1f + 2.5f * f) * density, center = at)
    }
  }
}

/**
 * A kill: a white flash, a shockwave, and debris thrown outward, once
 * per wreck. [startedAt] is when this watch first saw it, so a wreck
 * plays when it arrives rather than restarting on every poll.
 */
fun DrawScope.drawWreck(at: Offset, livery: Color, age: Long, density: Float) {
  val life = 2200f
  if (age > life) return
  val f = (age / life).coerceIn(0f, 1f)
  // The flash, and then the shockwave that outlives it.
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
  // Debris: shards thrown out and slowing, in the hull's own livery.
  for (i in 0 until 7) {
    val a = i * 0.92f + (at.x + at.y) * 0.01f
    val speed = 10f + (i % 3) * 5f
    val d = (speed * min(1f, f * 2.2f) + 6f * f) * density
    val p0 = Offset(at.x + cos(a) * d, at.y + sin(a) * d)
    val p1 = Offset(p0.x + cos(a) * 2.2f * density, p0.y + sin(a) * 2.2f * density)
    drawLine(livery.copy(alpha = 0.85f * (1f - f)), p0, p1, strokeWidth = 1f * density)
  }
}
