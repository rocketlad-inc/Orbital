package com.orbitalempire.wear

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.RadialGradient
import android.graphics.Shader
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.BlendMode
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ColorFilter
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.withTransform
import androidx.compose.ui.graphics.toArgb
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.roundToInt
import kotlin.math.sin

/**
 * THE FIGHT, IN THE GAME'S NEW LANGUAGE.
 *
 * The map's effects were rebuilt for the new hull art (src/render/fxArt.ts
 * and combatFx.ts), and this is that vocabulary at watch size:
 *
 *   KINETIC   a burst of 1 / 2 / 3 rounds by hull (corvette / frigate /
 *             destroyer), each round with its own muzzle flash
 *             (a tongue of light down the barrel), an amber streak with
 *             a hot head, and a white flash and sparks where it lands.
 *   ENERGY    the emitter charges -- a bead swelling, motes spiralling
 *             in -- then a beam of haze, glow and white core burns across
 *             with pulses running down it, scorching the hull it hits.
 *   SHIELDS   a round on a shielded hull lights the struck arc of its
 *             bubble, the hexagon cells flaring as the ripple runs out.
 *   ARMOUR    a beam on armour scatters: a dim flare and cyan sparks
 *             glancing off, so "my shots are bouncing" reads on sight.
 *   FLAK      air-bursts thrown into the space round the enemy, and a
 *             haze of shrapnel hanging round every hull it has slowed.
 *   DAMAGE    a hull hit last turn, or under a third, burns: flames on
 *             the hull itself and smoke streaming one way off it, each
 *             hull catching on its own beat.
 *   A KILL    a white flash, a fireball cooling from white to deep red,
 *             a soft shockwave and smoke -- and the hull coming apart in
 *             pieces of ITS OWN icon, glowing at the breaks, cooling to
 *             char, drifting where it died.
 *
 * LIGHT IS ADDITIVE, MATTER IS NOT: glows, beams and sparks add (Plus);
 * smoke and wreckage are drawn over in the normal blend. The weapon
 * colours the shot, not the faction -- the hull already carries that.
 *
 * EVERY COLOUR AND TIMING COMES FROM THE SERVER (FxTuning.current, the
 * game's own src/render/fxTuning.ts), so the fire rate the map uses is
 * the fire rate the wrist uses, and a change to it is a deploy.
 *
 * All of it is drawn from the feed's own numbers on a local clock, so a
 * battle animates continuously between polls without ever claiming a
 * shot the server did not stamp.
 */

// The engine plume's own palette (it is not a weapon).
private val SMOKE_CORE = Color(0xFF3A3532)
private val SMOKE_EDGE = Color(0xFF24201E)
private val FIRE = Color(0xFFFF9632)
private val EMBER = Color(0xFFFFF0BE)

// ---- the building blocks --------------------------------------------

/** A seeded 0..1 stream (mulberry32, the map's own), so every burst,
 *  spark and shard is the same each frame of its life. */
private class Rng(seed: Int) {
  private var a = seed
  fun next(): Float {
    a += 0x6D2B79F5
    var t = a
    t = (t xor (t ushr 15)) * (t or 1)
    t = t xor (t + (t xor (t ushr 7)) * (t or 61))
    return ((t xor (t ushr 14)).toLong() and 0xFFFFFFFFL).toFloat() / 4294967296f
  }
}

private fun idHash(id: String): Int = id.hashCode() and 0x7FFFFFFF

private fun easeOut(k: Float): Float {
  val u = 1f - k
  return 1f - u * u * u
}

private const val GLOW_PX = 64

/** Radial glows baked once per colour pair and stretched: a battle costs
 *  blits, not gradients (the map's own measurement). */
private object Glows {
  private val cache = HashMap<Long, ImageBitmap>()

  fun of(core: Color, glow: Color): ImageBitmap {
    val key = (core.toArgb().toLong() shl 32) or (glow.toArgb().toLong() and 0xFFFFFFFFL)
    return cache.getOrPut(key) {
      val bmp = Bitmap.createBitmap(GLOW_PX, GLOW_PX, Bitmap.Config.ARGB_8888)
      val r = GLOW_PX / 2f
      val p = Paint(Paint.ANTI_ALIAS_FLAG)
      p.shader = RadialGradient(
        r, r, r,
        intArrayOf(
          core.copy(alpha = 1f).toArgb(),
          core.copy(alpha = 0.85f).toArgb(),
          glow.copy(alpha = 0.55f).toArgb(),
          glow.copy(alpha = 0.16f).toArgb(),
          glow.copy(alpha = 0f).toArgb(),
        ),
        floatArrayOf(0f, 0.16f, 0.34f, 0.62f, 1f),
        Shader.TileMode.CLAMP,
      )
      Canvas(bmp).drawCircle(r, r, r, p)
      bmp.asImageBitmap()
    }
  }
}

/** A glow of radius [r] at (x, y). Light by default; pass SrcOver for
 *  smoke, which is matter. */
private fun DrawScope.glowAt(
  x: Float, y: Float, r: Float, core: Color, glow: Color, alpha: Float,
  blend: BlendMode = BlendMode.Plus,
) {
  if (alpha <= 0.004f || r <= 0.2f) return
  val img = Glows.of(core, glow)
  val s = 2f * r / GLOW_PX
  withTransform({
    translate(x - r, y - r)
    scale(s, s, pivot = Offset.Zero)
  }) {
    drawImage(img, alpha = min(1f, alpha), blendMode = blend)
  }
}

/** One round in flight, tail to head: a soft glow and a hot core that
 *  both brighten toward the head, and a glint on the head. */
private fun DrawScope.shotRound(tail: Offset, head: Offset, width: Float, pal: FxPalette) {
  drawLine(
    Brush.linearGradient(listOf(pal.glow.copy(alpha = 0f), pal.glow.copy(alpha = 0.55f)), tail, head),
    tail, head, strokeWidth = width * 2.4f, cap = StrokeCap.Round, blendMode = BlendMode.Plus,
  )
  drawLine(
    Brush.linearGradient(listOf(pal.core.copy(alpha = 0f), pal.core.copy(alpha = 0.95f)), tail, head),
    tail, head, strokeWidth = width * 0.8f, cap = StrokeCap.Round, blendMode = BlendMode.Plus,
  )
  glowAt(head.x, head.y, width * 3.4f, pal.core, pal.glow, 1f)
}

/** A tapered tongue of light from (x, y) along [ang] (radians). */
private fun DrawScope.petal(x: Float, y: Float, ang: Float, len: Float, half: Float, pal: FxPalette, alpha: Float) {
  if (alpha <= 0f || len <= 0.5f) return
  val w = len * half * 1.1f
  val path = Path().apply {
    moveTo(0f, 0f)
    quadraticTo(len * 0.35f, -w, len, 0f)
    quadraticTo(len * 0.35f, w, 0f, 0f)
    close()
  }
  withTransform({
    translate(x, y)
    rotate(Math.toDegrees(ang.toDouble()).toFloat(), pivot = Offset.Zero)
  }) {
    drawPath(
      path,
      Brush.horizontalGradient(
        0f to pal.core,
        0.35f to pal.glow.copy(alpha = 0.75f),
        1f to pal.glow.copy(alpha = 0f),
        startX = 0f,
        endX = len,
      ),
      alpha = min(1f, alpha),
      blendMode = BlendMode.Plus,
    )
  }
}

/** Gun flash: a long petal down the barrel, two short ones either side. */
private fun DrawScope.muzzle(x: Float, y: Float, ang: Float, len: Float, alpha: Float, pal: FxPalette) {
  if (alpha <= 0f) return
  petal(x, y, ang, len, 0.2f, pal, alpha)
  petal(x, y, ang + 1.75f, len * 0.36f, 0.32f, pal, alpha * 0.8f)
  petal(x, y, ang - 1.75f, len * 0.36f, 0.32f, pal, alpha * 0.8f)
  glowAt(x, y, len * 0.6f, pal.core, pal.glow, alpha)
}

/** A beam of haze, glow and white core, flickering as it burns, with
 *  pulses running down it and a bright cap at each end. */
private fun DrawScope.beam(from: Offset, to: Offset, width: Float, alpha: Float, t: Long, seed: Int, pal: FxPalette) {
  if (alpha <= 0f) return
  val ph = (seed % 997) / 997f * 6.2832f
  val f = 0.84f + 0.16f * sin(t / 29f + ph) * sin(t / 53f + ph * 1.7f)
  val w = width * f
  drawLine(pal.haze, from, to, strokeWidth = w * 4.4f, cap = StrokeCap.Round, alpha = 0.07f * alpha, blendMode = BlendMode.Plus)
  drawLine(pal.glow, from, to, strokeWidth = w * 2.2f, cap = StrokeCap.Round, alpha = 0.32f * alpha, blendMode = BlendMode.Plus)
  drawLine(pal.core, from, to, strokeWidth = w * 0.8f, cap = StrokeCap.Round, alpha = 0.95f * alpha, blendMode = BlendMode.Plus)
  for (i in 0 until 3) {
    val u = ((t / 170f) + i / 3f + ph) % 1f
    glowAt(from.x + (to.x - from.x) * u, from.y + (to.y - from.y) * u, w * 1.8f, pal.core, pal.glow, 0.6f * alpha)
  }
  glowAt(from.x, from.y, w * 3f, pal.core, pal.glow, alpha)
  glowAt(to.x, to.y, w * 4.2f, pal.core, pal.glow, alpha)
}

/** An emitter charging: a bead swelling with [k], motes spiralling in. */
private fun DrawScope.charge(x: Float, y: Float, r: Float, k: Float, t: Long, seed: Int, pal: FxPalette) {
  glowAt(x, y, r * (0.5f + 0.9f * k), pal.core, pal.glow, 0.35f + 0.65f * k)
  val ph = (seed % 997) / 997f * 6.2832f
  for (i in 0 until 4) {
    val u = ((t / 240f) + i / 4f) % 1f
    val a = ph + i * 1.571f + u * 2.2f
    val d = r * 2.4f * (1f - u)
    glowAt(x + cos(a) * d, y + sin(a) * d, max(1.2f, r * 0.28f), pal.core, pal.glow, 0.8f * k * u)
  }
}

/** Sparks flung from (x, y) along [ang] +- spread/2 over life [k]. */
private fun DrawScope.sparks(
  x: Float, y: Float, ang: Float, spread: Float, count: Int, reach: Float,
  k: Float, seed: Int, pal: FxPalette, width: Float,
) {
  if (k >= 1f || k < 0f) return
  val rng = Rng(seed)
  val e = easeOut(k)
  val a = (1f - k) * (1f - k)
  for (i in 0 until count) {
    val d = ang + (rng.next() - 0.5f) * spread
    val sp = 0.45f + rng.next() * 0.55f
    val head = reach * sp * e
    val tail = max(0f, head - reach * 0.22f * sp * (1f - k * 0.6f))
    val cx = cos(d)
    val cy = sin(d)
    val p0 = Offset(x + cx * tail, y + cy * tail)
    val p1 = Offset(x + cx * head, y + cy * head)
    drawLine(pal.glow, p0, p1, strokeWidth = width * 2.4f, cap = StrokeCap.Round, alpha = 0.45f * a, blendMode = BlendMode.Plus)
    drawLine(pal.core, p0, p1, strokeWidth = width, cap = StrokeCap.Round, alpha = 0.95f * a, blendMode = BlendMode.Plus)
  }
}

/** A round landing on a hull: a white flash and sparks fanned back
 *  toward the shooter ([back] is the angle from the hit toward it). */
private fun DrawScope.hullHit(x: Float, y: Float, back: Float, size: Float, k: Float, seed: Int, pal: FxPalette) {
  if (k >= 1f || k < 0f) return
  val fk = min(1f, k / 0.45f)
  glowAt(x, y, size * (0.5f + 0.7f * easeOut(fk)), pal.core, pal.glow, 1f - fk)
  sparks(x, y, back, 2.4f, 7, size * 2.2f, k, seed, pal, max(0.8f, size * 0.07f))
}

private fun hexagon(x: Float, y: Float, s: Float, rot: Float): Path = Path().apply {
  for (i in 0 until 6) {
    val a = rot + i * (PI / 3).toFloat()
    val px = x + cos(a) * s
    val py = y + sin(a) * s
    if (i == 0) moveTo(px, py) else lineTo(px, py)
  }
  close()
}

/** A shield taking a round: the struck arc lights, its hexagon cells
 *  flare as the ripple runs out, the round sparks off. [ang] points
 *  from the centre to the contact. */
private fun DrawScope.shieldHit(
  cx: Float, cy: Float, r: Float, ang: Float, k: Float, strength: Float, seed: Int,
  pal: FxPalette, spark: FxPalette,
) {
  if (k >= 1f || k < 0f) return
  val a = 1f - k
  val span = 0.55f + 0.6f * easeOut(k)
  val tl = Offset(cx - r, cy - r)
  val sz = Size(r * 2, r * 2)
  fun band(lw: Float, col: Color, al: Float, sp: Float) {
    val deg = Math.toDegrees(sp.toDouble()).toFloat()
    drawArc(
      col, Math.toDegrees(ang.toDouble()).toFloat() - deg, deg * 2, false, tl, sz,
      alpha = al * a, style = Stroke(width = lw, cap = StrokeCap.Round), blendMode = BlendMode.Plus,
    )
  }
  band(r * 0.26f, pal.haze, 0.14f * (0.7f + 0.3f * strength), span)
  band(r * 0.1f, pal.glow, 0.4f, span * 0.8f)
  band(max(1f, r * 0.035f), pal.core, 0.85f, span * 0.55f)
  val cell = r * 0.13f
  val lw = max(0.8f, r * 0.025f)
  for (i in -4..4) {
    val ca = ang + i * (cell * 1.75f / r)
    val ring = abs(i) / 4f
    val lit = max(0f, 1f - abs(ring - k * 1.5f) * 3f)
    if (lit <= 0.02f) continue
    drawPath(
      hexagon(cx + cos(ca) * r, cy + sin(ca) * r, cell, ca), pal.core,
      alpha = 0.75f * lit * a, style = Stroke(width = lw), blendMode = BlendMode.Plus,
    )
  }
  val px = cx + cos(ang) * r
  val py = cy + sin(ang) * r
  glowAt(px, py, r * 0.45f, pal.core, pal.glow, a)
  sparks(px, py, ang, 1.8f, 5, r * 0.9f, k, seed, spark, max(0.7f, r * 0.03f))
}

/** Energy burning into a hull: a molten spot that blooms white, then
 *  cools through orange, droplets thrown off. */
private fun DrawScope.scorch(x: Float, y: Float, size: Float, k: Float, back: Float, seed: Int, fire: FxPalette) {
  if (k >= 1f || k < 0f) return
  val (c0, c1) = when {
    k < 0.35f -> Color.White to Color(0xFF9FE6FF)
    k < 0.7f -> Color(0xFFFFF0C8) to Color(0xFFFF9A3C)
    else -> Color(0xFFFFB070) to Color(0xFFC2381A)
  }
  glowAt(x, y, size * (0.6f + 0.5f * easeOut(k)), c0, c1, 1f - k * 0.8f)
  sparks(x, y, back, 2.8f, 5, size * 1.8f, k, seed, fire, max(0.7f, size * 0.06f))
}

// ---- the fight ----------------------------------------------------------

/**
 * Every shot in this orbit, this frame, and every hull's damage.
 *
 * [firing] is the server's word that the battle is exchanging fire this
 * tick; a battle that is open but quiet is a standoff and draws nothing
 * but its wounds. [targets] is who each hull is shooting at.
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
  val fx = FxTuning.current
  val byId = HashMap<String, Slot>(slots.size)
  for (s in slots) byId[s.ship.id] = s

  // Hurt hulls burn whether or not anyone is shooting right now.
  for (s in slots) {
    val p = positions[s.ship.id] ?: continue
    hullFire(s.ship, p, t, worlds.tick, s.iconDp * density * 0.5f, fx)
  }
  if (!firing) return

  // A crowded fight slows each hull's cadence rather than multiplying
  // shots on screen: the map's BATTLE_FIRE_REFERENCE.
  val engaged = targets.size
  val slotMs = (fx.boltMs + fx.beatMs) * max(1f, engaged / fx.fireReference)

  for (s in slots) {
    val shooter = s.ship
    val targetId = targets[shooter.id] ?: continue
    val fp = positions[shooter.id] ?: continue
    val tp = positions[targetId] ?: continue
    val target = byId[targetId]
    val h = idHash(shooter.id)
    val within = ((t + (h % slotMs.toLong())) % slotMs.toLong()).toFloat()
    val inBolt = within < fx.boltMs
    val impacting = !inBolt && within < fx.boltMs + fx.impactMs
    if (!inBolt && !impacting) continue
    // Which gun fires THIS volley, at the loadout's real ratio.
    val volley = (t + (h % slotMs.toLong())) / slotMs.toLong()
    val seed = h xor (volley * 0x9E3779B1L).toInt()
    val energyShot = shooter.energy > 0f && (shooter.energy >= 1f || Rng(seed).next() < shooter.energy)

    // Shots fit the art: they leave the bow side of the shooter and land
    // on the face of the target, not centre to centre.
    val sR = s.iconDp * density * 0.5f
    val tR = (target?.iconDp ?: s.iconDp) * density * 0.5f
    val hitAng = atan2(fp.y - tp.y, fp.x - tp.x)
    val face = Offset(tp.x + cos(hitAng) * tR * 0.3f, tp.y + sin(hitAng) * tR * 0.3f)
    val ang = atan2(tp.y - fp.y, tp.x - fp.x)
    val mz = Offset(fp.x + cos(ang) * sR * 0.45f, fp.y + sin(ang) * sR * 0.45f)

    if (inBolt && energyShot) {
      val bw = (sR * 0.11f).coerceIn(1.5f, 3.4f)
      if (within < fx.chargeMs) {
        charge(mz.x, mz.y, bw * 2.4f, within / fx.chargeMs, t, seed, fx.energy)
      } else {
        val bk = (within - fx.chargeMs) / (fx.boltMs - fx.chargeMs)
        val a = if (bk < 0.12f) bk / 0.12f else if (bk > 0.75f) 1f - (bk - 0.75f) / 0.25f else 1f
        beam(mz, face, bw, a, t, seed, fx.energy)
        scorch(face.x, face.y, tR * 0.35f, min(0.9f, bk * 0.5f), hitAng, seed xor 0x51, fx.fire)
      }
    } else if (inBolt) {
      // One round per corvette, two per frigate, three per destroyer,
      // staggered, each with its own muzzle flash. Fired from the LAST
      // rounds of a three-slot burst, so every round flies at the same
      // speed and the final one lands with the volley's big hit (the
      // map's burstSlots).
      val rw = (sR * 0.075f).coerceIn(1.1f, 2.4f)
      val rounds = max(1, fx.roundsFor(shooter.cls))
      val slots = max(3, rounds)
      val flight = fx.boltMs - (slots - 1) * fx.roundGapMs
      for (r in (slots - rounds) until slots) {
        val w2 = within - r * fx.roundGapMs
        if (w2 < 0f) continue
        val k = w2 / flight
        if (w2 < fx.muzzleMs) muzzle(mz.x, mz.y, ang, sR * 0.6f, 1f - w2 / fx.muzzleMs, fx.kinetic)
        if (k >= 1f) {
          // Landed: a small hit before the volley's big one.
          val lk = (k - 1f) / 0.35f
          if (lk < 1f) hullHit(face.x, face.y, hitAng, tR * 0.28f, lk, seed + r, fx.kinetic)
          continue
        }
        val head = Offset(mz.x + (face.x - mz.x) * k, mz.y + (face.y - mz.y) * k)
        val dist = hypot(face.x - mz.x, face.y - mz.y)
        val len = min(dist * k, (dist * 0.14f).coerceIn(10f, 30f) * max(0.7f, rw / 1.6f) * 0.6f)
        val ux = (face.x - mz.x) / (if (dist == 0f) 1f else dist)
        val uy = (face.y - mz.y) / (if (dist == 0f) 1f else dist)
        shotRound(Offset(head.x - ux * len, head.y - uy * len), head, rw, fx.kinetic)
      }
    } else {
      val ik = (within - fx.boltMs) / fx.impactMs
      val t2 = target?.ship
      if (energyShot) {
        // Armour is energy's counter: the beam scatters off it.
        if ((t2?.armor ?: 0) > 0) {
          glowAt(face.x, face.y, tR * 0.5f, fx.energy.core, fx.energy.glow, (1f - ik) * 0.6f)
          sparks(face.x, face.y, hitAng, 1.9f, 6, tR * 1.5f, ik, seed, fx.energy, max(0.8f, tR * 0.06f))
        } else {
          scorch(face.x, face.y, tR * 0.42f, 0.45f + ik * 0.55f, hitAng, seed xor 0x51, fx.fire)
        }
      } else {
        // Shields are kinetic's counter: the bubble lights where it lands.
        val shields = t2?.shields ?: 0
        if (shields > 0) {
          shieldHit(tp.x, tp.y, max(8f * density, tR + 3f * density), hitAng, ik, min(1f, shields / 3f), seed, fx.shield, fx.kinetic)
        } else {
          hullHit(face.x, face.y, hitAng, tR * 0.5f, ik, seed, fx.kinetic)
        }
      }
    }
  }

  drawFlak(slots, positions, t, density, fx)
}

/**
 * FLAK. A flak battery does no damage; it slows every enemy hull in its
 * orbit. Two things show it, as on the map: bursts thrown into the space
 * round the enemy fleet, a stream per mount (three a mount, capped), and
 * shrapnel hanging round every hull it has slowed, thicker the harder.
 */
private fun DrawScope.drawFlak(slots: List<Slot>, positions: Map<String, Offset>, t: Long, density: Float, fx: FxTuning) {
  // The shrapnel round every slowed hull (the server's own number).
  for (s in slots) {
    val drag = s.ship.flakDrag
    if (drag <= 0f) continue
    val p = positions[s.ship.id] ?: continue
    flakDrag(p.x, p.y, s.iconDp * density * 0.5f, drag, t, idHash(s.ship.id))
  }
  // Mounts per faction among the hulls in this fight.
  val mounts = HashMap<String, Int>()
  for (s in slots) {
    if (!s.ship.fighting || s.ship.flak <= 0) continue
    mounts[s.ship.faction] = (mounts[s.ship.faction] ?: 0) + s.ship.flak
  }
  if (mounts.isEmpty()) return
  val cycle = fx.flakCycleMs.toLong().coerceAtLeast(1L)
  for ((faction, n) in mounts) {
    val enemies = slots.filter { it.ship.faction != faction && positions.containsKey(it.ship.id) }
    if (enemies.isEmpty()) continue
    val streams = min(fx.flakMaxStreams, n * 3)
    val fh = idHash(faction)
    for (st in 0 until streams) {
      val tt = t + st * (cycle / streams) + (fh % cycle)
      val cyc = tt / cycle
      for (back in 0..1) {
        val cy = cyc - back
        val k = (tt - cy * cycle) / fx.flakBurstMs
        if (k < 0f || k >= 1f) continue
        val rng = Rng(fh xor (cy * 0x9E3779B1L).toInt() xor (st * 7919))
        val tgt = enemies[(rng.next() * enemies.size).toInt().coerceIn(0, enemies.size - 1)]
        val p = positions[tgt.ship.id] ?: continue
        val r = tgt.iconDp * density * 0.5f
        val a = rng.next() * 6.2832f
        val d = r * (0.5f + rng.next() * 1.3f)
        flakBurst(p.x + cos(a) * d, p.y + sin(a) * d, (r * 0.6f).coerceIn(4f * density, 11f * density), k, fh + (cy * 31).toInt() + st, fx)
      }
    }
  }
}

/** One flak air-burst: an orange flash, shrapnel flung all round, and a
 *  puff of smoke that lingers and spreads. */
private fun DrawScope.flakBurst(x: Float, y: Float, size: Float, k: Float, seed: Int, fx: FxTuning) {
  if (k >= 1f || size <= 0f) return
  val e = easeOut(k)
  glowAt(x, y, size * (0.6f + 0.9f * e), Color(0xFF7A7168), Color(0xFF3E3833), 0.6f * (1f - k) * min(1f, k / 0.08f), BlendMode.SrcOver)
  if (k < 0.28f) {
    val fk = k / 0.28f
    glowAt(x, y, size * (1f + 0.9f * fk), fx.fire.core, fx.fire.glow, 1f - fk)
    glowAt(x, y, size * 0.45f, Color.White, Color(0xFFFFD27A), (1f - fk) * 0.9f)
  }
  sparks(x, y, 0f, 6.2832f, 9, size * 2.1f, min(1f, k * 1.4f), seed, fx.kinetic, max(0.8f, size * 0.08f))
}

/** Shrapnel hanging round a slowed hull: a faint haze and glinting
 *  specks drifting about it, thicker the harder it is slowed. */
private fun DrawScope.flakDrag(x: Float, y: Float, hullR: Float, slow: Float, t: Long, seed: Int) {
  glowAt(x, y, hullR * 1.25f, Color(0xFF3A3632), Color(0xFF22201E), 0.22f * slow, BlendMode.SrcOver)
  val rng = Rng(seed)
  val n = 3 + (6 * slow).roundToInt()
  for (i in 0 until n) {
    val a0 = rng.next() * 6.2832f
    val rr = hullR * (0.65f + rng.next() * 0.6f)
    val speed = 2600f + rng.next() * 1800f
    val dir = if (rng.next() < 0.5f) 1f else -1f
    val a = a0 + (t / speed) * dir
    val glint = 0.35f + 0.65f * max(0f, sin(t / (90f + rng.next() * 140f) + i * 1.9f))
    glowAt(x + cos(a) * rr, y + sin(a) * rr, max(1.1f, hullR * 0.06f), Color(0xFFFFF1D6), Color(0xFFFF9A3C), 0.75f * glint * (0.5f + 0.5f * slow))
  }
}

/** When each hull's current damage was first seen, so a damaged fleet
 *  catches fire ship by ship rather than all on one frame. */
private val damageSeen = HashMap<String, Pair<Int, Long>>()

/**
 * A HULL ON FIRE: hit within the last tick, or under a third. Flames at
 * seeded points ON the hull, flickering, with tongues streaming the same
 * way as the smoke; the severity scales with how hurt it is.
 */
private fun DrawScope.hullFire(s: OrbitShip, p: Offset, t: Long, tick: Int, hullR: Float, fx: FxTuning) {
  val hp = s.hp ?: return
  val frac = hp / 100f
  val dmg = s.damagedTick
  val recent = dmg != null && tick - dmg < 1 + fx.damageShowTicks
  val crippled = frac < fx.crippledBelow
  if (!recent && !crippled) return
  var sev = max(if (recent) 0.5f else 0.25f, 1f - frac)
  if (recent && dmg != null) {
    val seen = damageSeen[s.id]
    val since = if (seen == null || seen.first != dmg) {
      if (damageSeen.size > 400) damageSeen.clear()
      damageSeen[s.id] = dmg to t
      t
    } else seen.second
    val phase = (idHash(s.id) % 1000) / 1000f
    val ramp = ((t - (since + phase * fx.igniteDelayMs)) / fx.igniteRampMs).coerceIn(0f, 1f)
    if (ramp <= 0.01f && !crippled) return
    sev *= if (crippled) max(ramp, 0.5f) else ramp
  }
  val r0 = max(3f, hullR * 0.8f)
  val rng = Rng(idHash(s.id))
  val ph = rng.next() * 6.2832f
  val wind = ph + 1.1f
  val fires = 1 + (sev * 2.2f).roundToInt()
  val spots = ArrayList<Offset>(fires)
  for (i in 0 until fires) {
    val a = rng.next() * 6.2832f
    val d = r0 * (0.15f + rng.next() * 0.4f)
    spots += Offset(p.x + cos(a) * d, p.y + sin(a) * d)
  }
  // Smoke, matter: streaming off one way.
  for ((i, f) in spots.withIndex()) {
    for (j in 0 until 3) {
      val u = ((t / 1700f) + j / 3f + i * 0.29f) % 1f
      val d = r0 * (0.15f + 1.4f * u)
      glowAt(
        f.x + cos(wind) * d, f.y + sin(wind) * d, r0 * (0.18f + 0.4f * u) * (0.6f + sev * 0.6f),
        SMOKE_CORE, SMOKE_EDGE, 0.55f * (1f - u) * (0.4f + 0.6f * sev), BlendMode.SrcOver,
      )
    }
  }
  // Fire, light.
  for ((i, f) in spots.withIndex()) {
    val flick = 0.62f + 0.38f * sin(t / 85f + i * 2.1f + ph) * sin(t / 137f + i)
    val r = r0 * (0.16f + 0.16f * sev) * (0.75f + 0.5f * flick)
    glowAt(f.x, f.y, r * 2.1f, Color(0xFFFFD890), Color(0xFFFF6A1F), 0.55f * flick)
    glowAt(f.x, f.y, r * 0.8f, Color(0xFFFFFAF0), Color(0xFFFFC062), 0.9f * flick)
    petal(f.x, f.y, wind + sin(t / 160f + i) * 0.25f, r * 2.6f, 0.32f, fx.fire, 0.7f * flick)
  }
}

/**
 * THE ENGINE, NOT A RIBBON. Every hull in orbit is under way, and the
 * map draws that as an exhaust cone at the bell -- a hot core fading out
 * through the faction's own tint to nothing (fxPrimitives
 * drawThrustExhaust).
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
  // SMALL AND HOT: about the hull's beam and a touch under its length.
  val flicker = 0.85f + 0.15f * sin(t / 90f + (abs(seed) % 628) / 100f)
  val len = size * 0.8f * flicker
  val wide = size * 0.17f
  val bell = Offset(at.x - dx * size * 0.42f, at.y - dy * size * 0.42f)
  val tail = Offset(bell.x - dx * len, bell.y - dy * len)
  val px = -dy
  val py = dx
  val cone = Path().apply {
    moveTo(bell.x + px * wide, bell.y + py * wide)
    lineTo(tail.x, tail.y)
    lineTo(bell.x - px * wide, bell.y - py * wide)
    close()
  }
  drawPath(
    cone,
    Brush.linearGradient(
      0f to EMBER.copy(alpha = 0.9f),
      0.25f to FIRE.copy(alpha = 0.5f),
      0.6f to livery.copy(alpha = 0.3f),
      1f to livery.copy(alpha = 0f),
      start = bell,
      end = tail,
    ),
  )
  drawCircle(EMBER.copy(alpha = 0.9f * flicker), radius = size * 0.07f, center = bell)
}

// ---- a kill -------------------------------------------------------------

/**
 * A KILL, AND WHAT IT LEAVES -- the map's two stages.
 *
 *   EXPLOSION  a white flash, a fireball cooling from white to deep red,
 *              a soft shockwave and smoke that outlives the fire, over
 *              the tuning's explosionMs. [age] is time since this
 *              Porthole first drew it, and the Porthole forgets when it
 *              closes, so OPENING a world replays the deaths there.
 *
 *   BREAKUP    the hull itself -- [hull], its own icon in its owner's
 *              livery -- cut into three or four pieces that fly apart and
 *              tumble, white-hot at the breaks, cooling to char, then
 *              drifting where it died for as long as the server reports
 *              the wreck. [fade] is how far through that window it is,
 *              0 fresh to 1 about to be forgotten. With no icon (an older
 *              server), charred plates instead.
 */
internal fun DrawScope.drawWreck(
  at: Offset,
  livery: Color,
  hull: ImageBitmap?,
  hullPx: Float,
  heading: Float,
  age: Long,
  fade: Float,
  seed: Int,
) {
  val fx = FxTuning.current
  val alpha = (1f - fade).coerceIn(0.15f, 1f)
  if (hull != null) breakup(hull, livery, at, hullPx, heading, age, seed, alpha, fx)
  else plates(at, hullPx, alpha, age, seed, fx)
  val k = age / fx.explosionMs
  if (k < 1f) explosion(at.x, at.y, hullPx * 0.65f, k, seed, fx)
}

private fun DrawScope.explosion(x: Float, y: Float, r: Float, k: Float, seed: Int, fx: FxTuning) {
  if (k >= 1f || r <= 0f) return
  val rng = Rng(seed)
  val e = easeOut(k)
  // Smoke, once the fire has room to show it.
  val smokeA = if (k < 0.25f) 0f else if (k < 0.45f) (k - 0.25f) / 0.2f else 1f - (k - 0.45f) / 0.55f
  for (i in 0 until 6) {
    val a = rng.next() * 6.2832f
    val d = r * (0.3f + 1.1f * e) * (0.5f + rng.next() * 0.5f)
    glowAt(
      x + cos(a) * d, y + sin(a) * d, r * (0.5f + e) * (0.7f + rng.next() * 0.4f),
      Color(0xFF2B2724), Color(0xFF1B1816), 0.42f * smokeA, BlendMode.SrcOver,
    )
  }
  // The shockwave: a soft band of light, never a line, never a disc.
  val sr = r * (1.3f + 4.4f * e)
  val sa = 0.18f * (1f - k) * (1f - k) * min(1f, k / 0.06f)
  if (sa > 0.01f) {
    val band = Color(0xFFFFD6AA)
    drawCircle(band, radius = sr, center = Offset(x, y), alpha = sa * 0.55f, style = Stroke(width = r), blendMode = BlendMode.Plus)
    drawCircle(band, radius = sr, center = Offset(x, y), alpha = sa, style = Stroke(width = r * 0.35f), blendMode = BlendMode.Plus)
  }
  // Fire, cooling as it runs.
  val (core, glow) = when {
    k < 0.14f -> Color.White to Color(0xFFFFE2A0)
    k < 0.42f -> Color(0xFFFFE6A8) to Color(0xFFFF7A1F)
    else -> Color(0xFFFF9A4A) to Color(0xFFA8240E)
  }
  val fireA = (1f - k).pow(1.5f)
  for (i in 0 until 7) {
    val a = rng.next() * 6.2832f
    val d = r * 0.6f * e * rng.next()
    glowAt(x + cos(a) * d, y + sin(a) * d, r * (0.55f + 0.45f * rng.next()) * (0.6f + 0.8f * e), core, glow, fireA)
  }
  if (k < 0.12f) glowAt(x, y, r * 2.6f, Color.White, Color(0xFFFFF0C8), 1f - k / 0.12f)
  sparks(x, y, 0f, 6.2832f, 12, r * 4.2f, min(1f, k * 1.6f), seed xor 0x9E3779B9.toInt(), fx.kinetic, max(0.9f, r * 0.07f))
}

private class Piece(val a0: Float, val a1: Float, val jx: Float, val jy: Float, val spin: Float, val push: Float)

private fun piecesOf(seed: Int): List<Piece> {
  val rng = Rng(seed)
  val n = 3 + (rng.next() * 2).toInt()
  val base = rng.next() * 6.2832f
  val cuts = FloatArray(n) { i -> base + (i + 0.25f + rng.next() * 0.5f) * (6.2832f / n) }
  return List(n) { i ->
    Piece(
      cuts[i], cuts[(i + 1) % n] + if (i == n - 1) 6.2832f else 0f,
      (rng.next() - 0.5f) * 0.12f, (rng.next() - 0.5f) * 0.12f,
      (rng.next() - 0.5f) * 1.6f, 0.7f + rng.next() * 0.6f,
    )
  }
}

/** Charred: the livery hull with char laid over its own silhouette. */
private val CHAR = ColorFilter.tint(Color(0xFF1A1512), BlendMode.SrcIn)

private fun DrawScope.breakup(
  img: ImageBitmap, livery: Color, at: Offset, size: Float, heading: Float,
  ageMs: Long, seed: Int, alpha: Float, fx: FxTuning,
) {
  val fly = easeOut(min(1f, ageMs / fx.breakupFlyMs))
  val drift = min(ageMs, 120_000L) / 1000f
  val heat = max(0f, 1f - ageMs / fx.breakupHeatMs)
  val h = size * img.height / img.width.toFloat()
  val reach = max(size, h) * 0.78f
  val tint = liveryFilter(livery)
  for (p in piecesOf(seed)) {
    val mid = (p.a0 + p.a1) / 2f
    val dir = heading + mid
    val d = size * (0.06f + 0.42f * fly * p.push) + size * 0.012f * drift * p.push
    val px = at.x + cos(dir) * d
    val py = at.y + sin(dir) * d
    val rot = heading + p.spin * (0.5f * fly + 0.04f * drift)
    val ox = p.jx * size
    val oy = p.jy * size
    val wedge = Path().apply {
      moveTo(ox, oy)
      for (i in 0..6) {
        val a = p.a0 + (p.a1 - p.a0) * (i / 6f)
        lineTo(cos(a) * reach, sin(a) * reach)
      }
      close()
    }
    withTransform({
      translate(px, py)
      rotate(Math.toDegrees(rot.toDouble()).toFloat(), pivot = Offset.Zero)
      clipPath(wedge)
    }) {
      val topLeft = Offset(-size / 2f, -h / 2f)
      drawHull(img, topLeft, size, h, alpha, tint)
      // The hull itself for a moment, then char.
      val charA = alpha * 0.62f * min(1f, ageMs / 500f)
      drawHull(img, topLeft, size, h, charA, CHAR)
    }
    if (heat > 0f) {
      withTransform({
        translate(px, py)
        rotate(Math.toDegrees(rot.toDouble()).toFloat(), pivot = Offset.Zero)
      }) {
        val edge = if (heat > 0.5f) Color(0xFFFFD27A) else Color(0xFFFF6A2A)
        val lw = max(1f, size * 0.035f)
        for (a in floatArrayOf(p.a0, p.a1)) {
          drawLine(
            edge, Offset(ox, oy), Offset(cos(a) * reach * 0.62f, sin(a) * reach * 0.62f),
            strokeWidth = lw, cap = StrokeCap.Round, alpha = 0.85f * heat * alpha, blendMode = BlendMode.Plus,
          )
        }
        glowAt(ox, oy, size * 0.22f, Color(0xFFFFF0C8), Color(0xFFFF7A1F), heat * alpha)
      }
    }
  }
}

private fun DrawScope.drawHull(img: ImageBitmap, topLeft: Offset, w: Float, h: Float, alpha: Float, filter: ColorFilter) {
  if (alpha <= 0.004f) return
  withTransform({
    translate(topLeft.x, topLeft.y)
    scale(w / img.width, h / img.height, pivot = Offset.Zero)
  }) {
    drawImage(img, alpha = min(1f, alpha), colorFilter = filter)
  }
}

/** Plates of a hull whose look this watch never had: charred slabs with
 *  a glint, thrown out and tumbling. */
private fun DrawScope.plates(at: Offset, size: Float, alpha: Float, ageMs: Long, seed: Int, fx: FxTuning) {
  val rng = Rng(seed)
  val fly = easeOut(min(1f, ageMs / fx.breakupFlyMs))
  val tumble = ageMs / 5000f
  for (i in 0 until 4) {
    val a = rng.next() * 6.2832f
    val d = size * (0.12f + 0.5f * fly) * (0.5f + rng.next() * 0.6f)
    val s = size * (0.22f + rng.next() * 0.2f)
    val r1 = 0.3f + rng.next() * 0.2f
    val r2 = 0.2f + rng.next() * 0.2f
    val spin = (rng.next() - 0.5f) * 2f
    val slab = Path().apply {
      moveTo(-s * 0.5f, -s * 0.2f)
      lineTo(s * r1, -s * 0.32f)
      lineTo(s * 0.5f, s * 0.18f)
      lineTo(-s * r2, s * 0.3f)
      close()
    }
    withTransform({
      translate(at.x + cos(a) * d, at.y + sin(a) * d)
      rotate(Math.toDegrees((a * 1.7f + tumble * spin).toDouble()).toFloat(), pivot = Offset.Zero)
    }) {
      drawPath(slab, Color(0xFF3A3634), alpha = 0.9f * alpha)
      drawPath(slab, Color(0xFF968E84), alpha = 0.5f * alpha, style = Stroke(width = max(0.6f, s * 0.06f)))
    }
  }
}

/** For callers that place a wreck without a remembered seat. */
internal fun wreckHeading(id: String): Float = (idHash(id) % 628) / 100f - PI.toFloat()

