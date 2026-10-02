package com.orbitalempire.wear

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.unit.dp
import androidx.wear.compose.material.Text
import kotlin.math.cos
import kotlin.math.sin

/**
 * ALWAYS-ON. When the watch dims with Orbital in front, the screen goes to
 * black and keeps the one thing worth keeping lit: a fight, as outlines --
 * the world's circle, each side's hulls as open chevrons round it in
 * their livery, the tally and the tick. No starfield, no fills, nothing
 * that holds a pixel on for long; the whole picture shifts a few pixels
 * each minute ([nudge]) so no line burns into the same place. With no
 * fight on, just the empire's name and the time to the next tick.
 */
@Composable
fun AmbientScreen(st: WearState, nudge: Int, lowBit: Boolean) {
  val dx = ((nudge * 7) % 9 - 4).dp
  val dy = ((nudge * 5) % 9 - 4).dp
  val ink = if (lowBit) Color.White else Color(0xFFB8C6D4)
  val battle = st.battles.maxByOrNull { b -> b.sides.sumOf { it.alive } }
  Box(Modifier.fillMaxSize().background(Color.Black)) {
    BoxWithConstraints(Modifier.fillMaxSize().offset(dx, dy)) {
      val s = if (maxWidth < maxHeight) maxWidth else maxHeight
      val until = untilTick(st, System.currentTimeMillis())
      if (battle == null) {
        Column(Modifier.align(Alignment.Center), horizontalAlignment = Alignment.CenterHorizontally) {
          Text(st.faction.uppercase(), color = ink, fontSize = tp(s, 16f))
          if (until.isNotEmpty()) Text("TICK ${st.tick + 1} IN $until", color = ink, fontSize = tp(s, 13f))
          val need = st.attention.bills + st.attention.offers
          if (need > 0) Text("$need AWAITING YOU", color = ink, fontSize = tp(s, 12f), modifier = Modifier.padding(top = 4.dp))
        }
        return@BoxWithConstraints
      }
      // Your side is you and any ally in the fight; theirs is whoever is at war with you.
      val mine = battle.sides.filter { !it.enemy }.sumOf { it.alive }
      val theirs = battle.sides.filter { it.enemy }
      val theirN = theirs.sumOf { it.alive }
      val myInk = if (lowBit) Color.White else factionColor(battle.sides.firstOrNull { it.mine }?.color ?: "#4ecdc4")
      val theirInk = if (lowBit) Color.White else factionColor(theirs.maxByOrNull { it.alive }?.color ?: "#ff7043")
      Canvas(Modifier.fillMaxSize()) {
        val w = 1.2.dp.toPx()
        val c = Offset(center.x, center.y - size.minDimension * 0.06f)
        val pr = size.minDimension * 0.13f
        drawCircle(ink, radius = pr, center = c, style = Stroke(w))
        val ring = size.minDimension * 0.25f
        fun chevron(deg: Float, col: Color) {
          val a = Math.toRadians(deg.toDouble())
          val p = Offset(c.x + ring * cos(a).toFloat(), c.y + ring * sin(a).toFloat())
          // Nose along the orbit.
          val h = Math.toRadians(deg + 90.0)
          val k = size.minDimension * 0.035f
          val nose = Offset(p.x + k * cos(h).toFloat(), p.y + k * sin(h).toFloat())
          val l = Math.toRadians(deg + 90.0 + 150.0)
          val r = Math.toRadians(deg + 90.0 - 150.0)
          drawLine(col, nose, Offset(p.x + k * cos(l).toFloat(), p.y + k * sin(l).toFloat()), w)
          drawLine(col, nose, Offset(p.x + k * cos(r).toFloat(), p.y + k * sin(r).toFloat()), w)
        }
        val m = mine.coerceAtMost(6)
        for (i in 0 until m) chevron(200f - 26f * (i - (m - 1) / 2f), myInk)
        val t = theirN.coerceAtMost(6)
        for (i in 0 until t) chevron(-20f + 26f * (i - (t - 1) / 2f), theirInk)
        // The tick ring, as a hairline.
        val rr = size.minDimension / 2f - 3.dp.toPx()
        drawArc(ink.copy(alpha = 0.6f), -90f, 360f * tickFraction(st, System.currentTimeMillis()), false, Offset(center.x - rr, center.y - rr), androidx.compose.ui.geometry.Size(rr * 2, rr * 2), style = Stroke(w))
      }
      Column(Modifier.align(Alignment.TopCenter).padding(top = s * 0.14f), horizontalAlignment = Alignment.CenterHorizontally) {
        Text(battle.body.uppercase(), color = ink, fontSize = tp(s, 20f))
      }
      Column(Modifier.align(Alignment.BottomCenter).padding(bottom = s * 0.13f), horizontalAlignment = Alignment.CenterHorizontally) {
        Row {
          Text("$mine", color = myInk, fontSize = tp(s, 22f))
          Text("  v  ", color = ink, fontSize = tp(s, 16f))
          Text("$theirN", color = theirInk, fontSize = tp(s, 22f))
        }
        if (until.isNotEmpty()) Text("TICK ${st.tick + 1} IN $until", color = ink, fontSize = tp(s, 12f))
      }
    }
  }
}
