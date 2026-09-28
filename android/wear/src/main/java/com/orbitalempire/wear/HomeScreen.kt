package com.orbitalempire.wear

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.requiredSize
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.wear.compose.material.Text
import kotlinx.coroutines.delay
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.roundToLong
import kotlin.math.sin

/**
 * HOME, THE COMMAND DIAL: the empire itself, not numbers about it.
 *
 *   rim        how far through this tick the game is
 *   top arc    the tick, and how long until the next
 *   centre     your capital, as the map paints it, with research as a ring
 *              round it and the hulls parked there in orbit
 *   below      metal, credits, science: what you hold, where it has been
 *              (the last ten readings), what a tick adds
 *   the pill   how many things need you, in their colours: one tap to them
 */
@Composable
fun HomeScreen(ui: WearViewModel.UiState, nav: Nav, need: List<Decision>) {
  val st = ui.state
  var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
  LaunchedEffect(st.nextTickAt) {
    while (true) {
      now = System.currentTimeMillis()
      delay(1_000)
    }
  }
  val until = untilTick(st, now)
  val top = when {
    st.phase == "none" -> "ORBITAL"
    until.isEmpty() -> "TICK ${st.tick}"
    until == "ANY MOMENT" -> "TICK ${st.tick} · NEXT ANY MOMENT"
    else -> "TICK ${st.tick} · NEXT IN $until"
  }
  Frame(top = top, ring = if (st.isLive || st.phase == "eliminated") tickFraction(st, now) else null) { s ->
    Box(Modifier.size(s).align(Alignment.Center)) {
      // THE EMPIRE, in its own flag and colour.
      Row(
        Modifier.align(Alignment.TopCenter).offset(y = u(s, 86f)).width(u(s, 250f)),
        horizontalArrangement = Arrangement.Center,
        verticalAlignment = Alignment.CenterVertically,
      ) {
        val me = ui.worlds?.me
        FlagArt(me?.let { ui.worlds?.emblemOf(it) }, factionColor(st.color), u(s, 18f))
        Text(
          " " + st.faction.ifEmpty { "ORBITAL" }.uppercase(),
          color = factionColor(st.color), fontSize = tp(s, 13f), fontWeight = FontWeight.Bold,
          maxLines = 1, overflow = TextOverflow.Ellipsis,
        )
      }
      CapitalDial(ui, s, nav, Modifier.align(Alignment.TopCenter).offset(y = u(s, 104f)))
      Resources(st, s, nav, Modifier.align(Alignment.TopCenter).offset(y = u(s, 238f)))
      NeedPill(need, s, nav, Modifier.align(Alignment.TopCenter).offset(y = u(s, 330f)))
      LookUpChip(st.capital, s, nav, Modifier.align(Alignment.TopCenter).offset(y = u(s, 386f)))
    }
  }
}

/** The capital, its research ring, and the hulls parked round it. */
@Composable
private fun CapitalDial(ui: WearViewModel.UiState, s: Dp, nav: Nav, modifier: Modifier) {
  val st = ui.state
  val cap = st.capital
  val r = st.research
  val parked = ui.command?.ships?.filter { cap != null && it.at == cap.id && !it.moving }?.take(6) ?: emptyList()
  Column(modifier.clickable { nav.research() }, horizontalAlignment = Alignment.CenterHorizontally) {
    Box(Modifier.size(u(s, 110f)), contentAlignment = Alignment.Center) {
      // The orbit the parked hulls ride, tilted like the map's.
      Canvas(Modifier.requiredSize(u(s, 176f), u(s, 50f)).rotate(-12f)) {
        drawOval(Color(0xFF1E2A36), style = Stroke(1.5.dp.toPx()))
      }
      Canvas(Modifier.size(u(s, 106f))) {
        val w = size.minDimension * 0.034f
        val rad = size.minDimension / 2f - w
        val tl = Offset(center.x - rad, center.y - rad)
        val sz = Size(rad * 2, rad * 2)
        drawArc(Color(0xFF12303E), 0f, 360f, false, tl, sz, style = Stroke(w))
        if (r != null && r.fraction > 0f) {
          drawArc(ScienceInk, -90f, 360f * r.fraction, false, tl, sz, style = Stroke(w, cap = StrokeCap.Round))
        }
      }
      PlanetArt(cap?.sp, u(s, 76f), fallback = factionColor(st.color))
      parked.forEachIndexed { i, sh ->
        // Seats on the tilted ellipse, front and back of the world.
        val deg = 200f + i * (360f / parked.size.coerceAtLeast(1))
        val a = Math.toRadians(deg.toDouble())
        val x = u(s, 88f) * cos(a).toFloat()
        val y = u(s, 25f) * sin(a).toFloat()
        val tilt = Math.toRadians(-12.0)
        val xr = x * cos(tilt).toFloat() - y * sin(tilt).toFloat()
        val yr = x * sin(tilt).toFloat() + y * cos(tilt).toFloat()
        Box(Modifier.offset(xr, yr)) { HullArt(sh.key, u(s, 24f), rotation = deg + 90f) }
      }
    }
    val researchLine = when {
      r != null -> "${r.name.uppercase()} ${r.level} · ${(r.fraction * 100).toInt()}%"
      st.isLive && st.researchOptions.isNotEmpty() -> "NO RESEARCH"
      else -> null
    }
    Text(
      listOfNotNull(cap?.name?.uppercase(), researchLine).joinToString(" · "),
      color = if (r == null && st.isLive) Warn else ScienceInk,
      fontSize = tp(s, 12f), fontWeight = FontWeight.Bold, maxLines = 1, overflow = TextOverflow.Ellipsis,
      modifier = Modifier.padding(top = 1.dp).width(u(s, 260f)),
      textAlign = androidx.compose.ui.text.style.TextAlign.Center,
    )
  }
}

@Composable
private fun Resources(st: WearState, s: Dp, nav: Nav, modifier: Modifier) {
  Row(modifier.width(u(s, 330f)).clickable { nav.go(Dest.REALM) }, horizontalArrangement = Arrangement.SpaceEvenly) {
    Res("METAL", st.metal, st.perTick.metal, st.perTick.metalHistory, MetalInk, st.isLive, s)
    Res("CREDITS", st.credits, st.perTick.credits, st.perTick.creditsHistory, CreditInk, st.isLive, s)
    Res("SCIENCE", st.science, st.perTick.science, st.perTick.scienceHistory, ScienceInk, st.isLive, s)
  }
}

@Composable
private fun Res(label: String, amount: Long, rate: Double?, hist: List<Double>, ink: Color, live: Boolean, s: Dp) {
  Column(Modifier.width(u(s, 104f)), horizontalAlignment = Alignment.CenterHorizontally) {
    Text(label, color = Sub, fontSize = tp(s, 10f), fontWeight = FontWeight.Bold)
    Text(compact(amount), color = ink, fontSize = tp(s, 22f), fontFamily = GameFont, maxLines = 1)
    Sparkline(hist, ink, Modifier.width(u(s, 64f)).height(u(s, 13f)))
    Text(
      when {
        !live || rate == null -> "—"
        else -> "${if (rate < 0) "−" else "+"}${compact(abs(rate).roundToLong())}/T"
      },
      color = when {
        !live || rate == null -> Dim
        rate < 0 -> Alarm
        else -> Good
      },
      fontSize = tp(s, 12f), fontWeight = FontWeight.Bold,
    )
  }
}

/** "3 NEED YOU", with a dot per thing in its tier's colour. */
@Composable
private fun NeedPill(need: List<Decision>, s: Dp, nav: Nav, modifier: Modifier) {
  val urgent = need.any { it.tier == 0 }
  val ink = if (need.isEmpty()) Label else if (urgent) Alarm else Warn
  Row(
    modifier
      .width(u(s, 236f))
      .height(u(s, 50f))
      .clip(RoundedCornerShape(u(s, 25f)))
      .background(if (need.isEmpty()) Color(0x8C111821) else if (urgent) Color(0xFF2A1210) else Color(0xFF2A2208))
      .border(1.5.dp, ink, RoundedCornerShape(u(s, 25f)))
      .clickable { nav.go(Dest.DECISIONS) },
    horizontalArrangement = Arrangement.Center,
    verticalAlignment = Alignment.CenterVertically,
  ) {
    Text(
      if (need.isEmpty()) "ALL QUIET" else "${need.size} NEED YOU",
      color = if (need.isEmpty()) Sub else Color(0xFFFFE3E0), fontSize = tp(s, 16f), fontFamily = GameFont,
    )
    if (need.isNotEmpty()) {
      Spacer(Modifier.width(u(s, 10f)))
      for (d in need.take(4)) {
        Box(Modifier.padding(horizontal = u(s, 2.5f)).size(u(s, 9f)).clip(CircleShape).background(tierInk(d.tier)))
      }
    }
  }
}

/** "MARS IS UP · SE": only when your capital is in the real sky above you. */
@Composable
private fun LookUpChip(cap: Capital?, s: Dp, nav: Nav, modifier: Modifier) {
  val ctx = LocalContext.current
  val sky = remember(cap?.id, System.currentTimeMillis() / 300_000L) { capitalSky(ctx, cap) }
  if (sky == null || sky.pos.alt <= 0.0) return
  Text(
    "↑ ${sky.label.uppercase()} IS UP · ${compassPoint(sky.pos.az)}",
    color = Color(0xFFCFE8FF), fontSize = tp(s, 11f), fontWeight = FontWeight.Bold,
    modifier = modifier.clip(RoundedCornerShape(10.dp)).clickable { nav.lookUp() }.padding(horizontal = 6.dp, vertical = 2.dp),
  )
}
