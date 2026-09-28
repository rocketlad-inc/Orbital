package com.orbitalempire.wear

import android.content.Context
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.wear.compose.material.Text
import kotlinx.coroutines.delay

/**
 * THE TICK LANDED. Everything in this game happens on a tick, so the
 * moment one lands while you are looking is worth a screen of its own:
 * the new tick's number, what it did to you (fleets in, worlds taken,
 * hulls launched, kills, losses) and how many new things need you -- and
 * the tick's buzz, followed by a kill's or a loss's, so you felt it before
 * you read it. A tap, or eight seconds, puts it away.
 */
object TickSeen {
  private const val PREFS = "orbital_wear_ui"
  private const val KEY = "tick_seen"

  /**
   * Whether [tick] is news. The first tick this watch ever sees is only
   * recorded -- a player opening the app for the first time has not
   * "just" had a tick land.
   */
  fun isNew(c: Context, tick: Int): Boolean {
    val p = c.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    val seen = p.getInt(KEY, 0)
    if (tick <= seen) return false
    p.edit().putInt(KEY, tick).apply()
    return seen > 0
  }
}

@Composable
fun TickLandsOverlay(st: WearState, newDecisions: Int, onDecisions: () -> Unit, onDismiss: () -> Unit) {
  val t = st.lastTick
  val ctx = LocalContext.current
  val pulse = remember { Animatable(0f) }
  LaunchedEffect(t?.tick) {
    Haptics.tickLanded(ctx, t)
    pulse.animateTo(1f, tween(1400, easing = LinearEasing))
  }
  LaunchedEffect(t?.tick) {
    delay(8_000)
    onDismiss()
  }
  Box(Modifier.fillMaxSize().background(Color(0xF2070B10)).clickable { onDismiss() }) {
    StarfieldBackground(dim = 0.35f)
    Frame(top = "THE TICK LANDED", topInk = Color(0xFFCFF5F1), rim = {
      val p = pulse.value
      rimRing(1f, Teal.copy(alpha = 0.8f * (1f - p) + 0.2f))
    }) { s ->
      Canvas(Modifier.fillMaxSize()) {
        val p = pulse.value
        drawCircle(Teal.copy(alpha = 0.35f * (1f - p)), radius = size.minDimension / 2f * (0.3f + 0.65f * p), style = Stroke(size.minDimension * 0.01f))
      }
      Column(Modifier.align(Alignment.Center), horizontalAlignment = Alignment.CenterHorizontally) {
        Text("${st.tick}", color = Ink, fontSize = tp(s, 60f), fontFamily = GameFont)
        val until = untilTick(st, System.currentTimeMillis())
        if (until.isNotEmpty()) Text("NEXT IN $until", color = Sub, fontSize = tp(s, 12f), fontWeight = FontWeight.Bold)
        Column(Modifier.padding(top = u(s, 10f)).width(u(s, 250f)), verticalArrangement = Arrangement.spacedBy(u(s, 3f))) {
          if (t == null || t.quiet) {
            Text("A QUIET TICK", color = Sub, fontSize = tp(s, 13f), fontWeight = FontWeight.Bold, modifier = Modifier.align(Alignment.CenterHorizontally))
          } else {
            Event(t.killed, "ENEMY SHIPS DESTROYED", Good, s)
            Event(t.lost, "OF YOURS LOST", Alarm, s)
            Event(t.gained, "WORLDS TAKEN", Good, s)
            Event(t.arrived, "FLEETS ARRIVED", Teal, s)
            Event(t.built, "HULLS LAUNCHED", Ink, s)
          }
        }
        if (newDecisions > 0) {
          Text(
            "$newDecisions NEED YOU ›", color = Warn, fontSize = tp(s, 14f), fontWeight = FontWeight.Bold,
            modifier = Modifier.padding(top = u(s, 10f)).clickable { onDecisions() },
          )
        }
      }
    }
  }
}

@Composable
private fun Event(n: Int, what: String, ink: Color, s: Dp) {
  if (n <= 0) return
  Row(verticalAlignment = Alignment.CenterVertically) {
    Text("$n", color = ink, fontSize = tp(s, 18f), fontFamily = GameFont, modifier = Modifier.width(u(s, 50f)))
    Text(what, color = Sub, fontSize = tp(s, 12f), fontWeight = FontWeight.Bold)
  }
}
