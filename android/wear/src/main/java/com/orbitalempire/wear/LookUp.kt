package com.orbitalempire.wear

import android.content.Context
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.wear.compose.material.Text
import kotlin.math.cos
import kotlin.math.roundToInt
import kotlin.math.sin

/**
 * LOOK UP. The watch already knows where Mars really is (SkyEngine, the
 * Orbital Sky face). When your capital is a world you can see from Earth
 * -- or orbits one -- and it is above your horizon, the watch says where.
 * Earth itself, and the far systems, have no place in your sky.
 */
data class CapitalSky(val label: String, val body: SkyEngine.Body, val pos: SkyEngine.Position, val moonOf: Boolean)

fun capitalSky(c: Context, cap: Capital?): CapitalSky? {
  if (cap == null) return null
  val fix = SkyLocation.saved(c) ?: return null
  fun bodyFor(name: String?): SkyEngine.Body? = when (name?.trim()?.lowercase()) {
    "mercury" -> SkyEngine.Body.MERCURY
    "venus" -> SkyEngine.Body.VENUS
    "mars" -> SkyEngine.Body.MARS
    "jupiter" -> SkyEngine.Body.JUPITER
    "saturn" -> SkyEngine.Body.SATURN
    "uranus" -> SkyEngine.Body.URANUS
    "neptune" -> SkyEngine.Body.NEPTUNE
    "luna", "moon", "the moon" -> SkyEngine.Body.MOON
    else -> null
  }
  val own = bodyFor(cap.name)
  // A moon of a planet sits where its planet does, to the eye.
  val host = own ?: bodyFor(cap.parent?.substringAfterLast(':')?.replace('_', ' '))
  val body = host ?: return null
  val pos = try {
    SkyEngine.position(body, System.currentTimeMillis(), fix.lat, fix.lon)
  } catch (_: Throwable) {
    return null
  }
  return CapitalSky(if (own != null) cap.name else body.label, body, pos, own == null)
}

private val POINTS = listOf("N", "NE", "E", "SE", "S", "SW", "W", "NW")

fun compass(az: Double): String = POINTS[(((az % 360 + 360) % 360) / 45.0).roundToInt() % 8]

private val LONG_POINTS = listOf("north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west")

/**
 * The sky dome: your horizon is the rim, straight up is the centre, north
 * at the top. The capital is a dot where it stands; a dashed ring marks
 * thirty degrees up.
 */
@Composable
fun LookUpScreen(cap: Capital?, onClose: () -> Unit) {
  BackHandler(onBack = onClose)
  val ctx = LocalContext.current
  val sky = remember(cap?.id) { capitalSky(ctx, cap) }
  Box(Modifier.fillMaxSize()) {
    StarfieldBackground(dim = 0.25f)
    Frame(top = "LOOK UP", topInk = Color(0xFFCFE8FF)) { s ->
      Canvas(Modifier.fillMaxSize()) {
        val r = size.minDimension / 2f * 0.84f
        drawCircle(Color(0xFF2A3644), radius = r, center = center, style = Stroke(1.2.dp.toPx()))
        drawCircle(Color(0xFF1E2A36), radius = r * 2f / 3f, center = center, style = Stroke(1.dp.toPx(), pathEffect = PathEffect.dashPathEffect(floatArrayOf(6f, 8f))))
        drawLine(Color(0xFF1E2A36), Offset(center.x, center.y - r), Offset(center.x, center.y + r), 1.dp.toPx())
        drawLine(Color(0xFF1E2A36), Offset(center.x - r, center.y), Offset(center.x + r, center.y), 1.dp.toPx())
        val p = sky?.pos
        if (p != null && p.alt > 0) {
          val d = r * (1f - (p.alt / 90.0).toFloat())
          val a = Math.toRadians(p.az - 90.0)
          val at = Offset(center.x + d * cos(a).toFloat(), center.y + d * sin(a).toFloat())
          drawCircle(Color(0xFFFF8A5B).copy(alpha = 0.25f), radius = 14.dp.toPx(), center = at)
          drawCircle(Color(0xFFFF8A5B), radius = 5.dp.toPx(), center = at)
        }
      }
      for ((t, dx, dy) in listOf(Triple("N", 0f, -1f), Triple("E", 1f, 0f), Triple("S", 0f, 1f), Triple("W", -1f, 0f))) {
        Text(t, color = Label, fontSize = tp(s, 13f), modifier = Modifier.align(Alignment.Center).offset(s * 0.39f * dx, s * 0.39f * dy))
      }
      Column(Modifier.align(Alignment.Center).width(u(s, 250f)).offset(y = u(s, 70f)), horizontalAlignment = Alignment.CenterHorizontally) {
        val line = when {
          cap == null -> "No capital yet"
          sky == null && SkyLocation.saved(ctx) == null -> "Open the Orbital Sky once to share your location"
          sky == null -> "${cap.name} is not in Earth's sky"
          sky.pos.alt > 0 -> "${sky.label.uppercase()} IS UP"
          else -> "${sky.label.uppercase()} IS DOWN"
        }
        Text(line, color = Ink, fontSize = tp(s, 18f), fontFamily = GameFont, textAlign = TextAlign.Center)
        if (sky != null) {
          val dir = LONG_POINTS[(((sky.pos.az % 360 + 360) % 360) / 45.0).roundToInt() % 8]
          Text(
            if (sky.pos.alt > 0) "${sky.pos.alt.roundToInt()}° above the $dir horizon" else "Below the $dir horizon",
            color = Sub, fontSize = tp(s, 13f), textAlign = TextAlign.Center,
          )
          if (sky.moonOf) {
            Text("Your capital, ${cap?.name}, orbits it", color = Label, fontSize = tp(s, 11f), textAlign = TextAlign.Center, modifier = Modifier.padding(top = 2.dp))
          }
        }
      }
    }
  }
}
