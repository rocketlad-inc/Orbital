package com.orbitalempire.wear

import android.graphics.Paint
import android.view.HapticFeedbackConstants
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.focusable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.MutableLongState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameMillis
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.drawIntoCanvas
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.rotary.onRotaryScrollEvent
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.wear.compose.material.Text
import kotlin.math.abs
import kotlin.math.ceil
import kotlin.math.cos
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * The game's systems, one at a time, turned through on the bezel.
 *
 * LORNE'S LAYOUT: "the watch scroll shuffles between systems, and shows
 * them laid out for the player to click on a world and get the whole
 * view. Where possible, systems should be laid out along their orbits.
 * But for larger systems, like the kuiper belt, Asteroid belt, plutinos,
 * can be laid out as a grid. At the system level, show the number of
 * ships as an icon, when scrolled out in the game."
 *
 * So: a planetary system is its planet in the middle and its moons on
 * their rings at their angle this tick; The Core is the Sun with Mercury
 * and Venus on theirs; a belt is a grid. Every world wears the game's
 * zoomed-out badge -- a star and your ship count -- in your colour, with
 * a red one beside it where rivals share that orbit. A battle is a red
 * ring that pulses, faster when shots are being fired. Tap a world and
 * the Porthole opens on it.
 *
 * THE BEZEL, NOT A LIST. The Watch6 Classic has a physical ring, and
 * turning it one detent per system -- with a haptic tick on each -- is
 * the whole reason this feels like a watch app rather than a phone
 * screen made small. It starts on the system that is burning, else the
 * one where most of your fleet is.
 */
@Composable
fun SystemsScreen(worlds: Worlds?, active: Boolean, onOpen: (String) -> Unit) {
  if (worlds == null || worlds.systems.isEmpty()) {
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
      Text(
        when {
          worlds == null -> "SCANNING…"
          worlds.state == "ended" -> "GAME OVER"
          worlds.state == "none" -> "NOT IN A GAME"
          else -> "NO SYSTEMS"
        },
        color = Dim, fontSize = 12.sp,
      )
    }
    return
  }
  val systems = worlds.systems
  var index by remember(systems.size) {
    mutableIntStateOf(
      systems.indexOfFirst { it.battle == "firing" }.takeIf { it >= 0 }
        ?: systems.indexOfFirst { it.battle != null }.takeIf { it >= 0 }
        ?: systems.indices.maxByOrNull { systems[it].mine }?.takeIf { systems[it].mine > 0 }
        ?: 0,
    )
  }
  index = index.coerceIn(0, systems.lastIndex)
  val sys = systems[index]
  val view = LocalView.current
  val focus = remember { FocusRequester() }
  var acc by remember { mutableFloatStateOf(0f) }
  LaunchedEffect(active) { if (active) focus.requestFocus() }
  val clock = rememberClock()

  Box(
    Modifier
      .fillMaxSize()
      .onRotaryScrollEvent { e ->
        acc += e.verticalScrollPixels
        if (abs(acc) >= ROTARY_STEP_PX) {
          val next = (index + if (acc > 0) 1 else -1).coerceIn(0, systems.lastIndex)
          if (next != index) {
            index = next
            view.performHapticFeedback(HapticFeedbackConstants.CLOCK_TICK)
          }
          acc = 0f
        }
        true
      }
      .focusRequester(focus)
      .focusable(),
  ) {
    SystemCanvas(worlds, sys, clock, onOpen)
    Column(
      Modifier.fillMaxWidth().padding(top = 26.dp),
      horizontalAlignment = Alignment.CenterHorizontally,
    ) {
      Text(sys.label.uppercase(), color = Ink, fontSize = 11.sp, textAlign = TextAlign.Center)
      // Where the bezel is, in the header: at the bottom of a round
      // screen it sat on top of the outermost world's name.
      Text(
        if (sys.mine > 0) "★${sys.mine}  ·  ${index + 1}/${systems.size}" else "${index + 1}/${systems.size}",
        color = if (sys.mine > 0) factionColor(worlds.colorOf(worlds.me)) else Dim,
        fontSize = 8.sp,
      )
    }
  }
}

/** Where a body landed on screen, for the tap test. */
private class Placed(val body: SysBody, val x: Float, val y: Float, val r: Float)

@Composable
private fun SystemCanvas(worlds: Worlds, sys: SystemView, clock: MutableLongState, onOpen: (String) -> Unit) {
  val density = LocalDensity.current.density
  val ctx = LocalContext.current
  val mine = factionColor(worlds.colorOf(worlds.me))
  val placed = remember(sys) { ArrayList<Placed>() }
  val label = remember { Paint(Paint.ANTI_ALIAS_FLAG).apply { typeface = TileKit.audiowide(ctx) } }

  Canvas(
    Modifier
      .fillMaxSize()
      .pointerInput(sys) {
        detectTapGestures { p ->
          val hit = placed.minByOrNull { (it.x - p.x) * (it.x - p.x) + (it.y - p.y) * (it.y - p.y) }
          if (hit != null) {
            val d = sqrt((hit.x - p.x) * (hit.x - p.x) + (hit.y - p.y) * (hit.y - p.y))
            if (d <= hit.r + 16 * density) onOpen(hit.body.id)
          }
        }
      },
  ) {
    val t = clock.longValue
    placed.clear()
    val cx = size.width / 2f
    val cy = size.height / 2f + 6 * density
    // 0.72, not more: the outermost ring passes the page dots and the
    // curve of the bezel at the bottom of a round screen.
    val outer = min(size.width, size.height) / 2f * 0.72f
    if (sys.grid) layoutGrid(sys, cx, cy, outer, density, placed)
    else layoutOrbits(sys, cx, cy, outer, density, placed, this)
    val showNames = placed.size <= 9
    for (p in placed) drawBody(p, t, density, mine, label, showNames)
  }
}

private fun bodySize(type: String, density: Float): Float = density * when (type) {
  "gas-giant", "gas_giant" -> 12f
  "ice-giant", "ice_giant" -> 11f
  "terrestrial" -> 9f
  "dwarf" -> 7f
  "moon" -> 6f
  else -> 5f
}

private fun layoutOrbits(
  sys: SystemView,
  cx: Float,
  cy: Float,
  outer: Float,
  density: Float,
  placed: MutableList<Placed>,
  scope: DrawScope,
) {
  val roots = sys.bodies.filter { it.parent == null }
  // The system's planet sits at the centre: the biggest body with
  // nothing above it (a co-orbital rock filed under the planet, like
  // Black Sky under Uranus, is also parentless, and must not bump the
  // planet out to a ring). Only The Core has no planet of its own --
  // Mercury and Venus orbit the Sun, which is drawn there instead.
  val center = if (sys.id == "core") null else roots.maxByOrNull { it.radius }
  val ringed = (if (center != null) sys.bodies - center else sys.bodies).sortedBy { it.orbit }
  val centerR = if (center != null) bodySize(center.type, density) * 1.6f else 9f * density
  if (center == null) {
    scope.drawCircle(
      Brush.radialGradient(listOf(Color(0xFFFFF1B0), Color(0xFFFFB347), Color(0x00FF8A00)), Offset(cx, cy), centerR * 1.8f),
      radius = centerR * 1.8f,
      center = Offset(cx, cy),
    )
  } else {
    placed += Placed(center, cx, cy, centerR)
  }
  if (ringed.isEmpty()) return
  val inner = centerR + 14 * density
  val n = ringed.size
  for ((i, b) in ringed.withIndex()) {
    val r = if (n == 1) (inner + outer) / 2f else inner + (outer - inner) * i / (n - 1).toFloat()
    scope.drawCircle(Trough, radius = r, center = Offset(cx, cy), style = Stroke(width = 1f * density))
    val a = b.angle.toFloat()
    placed += Placed(b, cx + cos(a) * r, cy + sin(a) * r, bodySize(b.type, density))
  }
}

private fun layoutGrid(
  sys: SystemView,
  cx: Float,
  cy: Float,
  outer: Float,
  density: Float,
  placed: MutableList<Placed>,
) {
  val bodies = sys.bodies.sortedBy { it.orbit }
  val n = bodies.size
  val cols = when {
    n <= 2 -> max(1, n)
    n <= 4 -> 2
    n <= 9 -> 3
    else -> 4
  }
  val rows = ceil(n / cols.toFloat()).toInt()
  // The square inscribed in the round screen, less the header.
  val side = outer * 1.35f
  val cell = side / max(cols, rows)
  val x0 = cx - cell * cols / 2f + cell / 2f
  val y0 = cy - cell * rows / 2f + cell / 2f
  for ((i, b) in bodies.withIndex()) {
    val col = i % cols
    val row = i / cols
    // A short last row is centred, not left-aligned.
    val inRow = if (row == rows - 1) n - row * cols else cols
    val shift = (cols - inRow) * cell / 2f
    placed += Placed(b, x0 + col * cell + shift, y0 + row * cell, bodySize(b.type, density))
  }
}

private fun DrawScope.drawBody(p: Placed, t: Long, density: Float, mine: Color, label: Paint, showName: Boolean) {
  val c = Offset(p.x, p.y)
  // Out of sensor range: the world is still drawn (geometry is never a
  // secret) but dimmed, so the eye goes to what can actually be looked at.
  val base = factionColor(p.body.color).let { if (p.body.seen) it else darken(it, 0.55f) }
  if (p.body.battle != null) {
    val period = if (p.body.battle == "firing") 700f else 1600f
    val k = ((t % period.toLong()) / period)
    drawCircle(
      Alarm.copy(alpha = 0.85f * (1f - k)),
      radius = p.r + (3f + 7f * k) * density,
      center = c,
      style = Stroke(width = 1.6f * density),
    )
  }
  drawCircle(
    Brush.radialGradient(listOf(lighten(base, 0.35f), base, darken(base, 0.55f)), Offset(p.x - p.r * 0.35f, p.y - p.r * 0.35f), p.r * 1.6f),
    radius = p.r,
    center = c,
  )
  if (p.body.owner != null && p.body.mine > 0) {
    drawCircle(mine.copy(alpha = 0.7f), radius = p.r + 1.8f * density, center = c, style = Stroke(width = 1f * density))
  }
  drawIntoCanvas { cv ->
    val nc = cv.nativeCanvas
    if (p.body.mine > 0) {
      label.textSize = 9f * density
      label.color = mine.toArgb()
      label.textAlign = Paint.Align.LEFT
      nc.drawText("★${p.body.mine}", p.x + p.r + 2 * density, p.y - p.r * 0.2f, label)
    }
    if (p.body.rivals > 0) {
      label.textSize = 8f * density
      label.color = Alarm.toArgb()
      label.textAlign = Paint.Align.LEFT
      nc.drawText("★${p.body.rivals}", p.x + p.r + 2 * density, p.y + p.r * 0.2f + 8 * density, label)
    }
    if (showName) {
      label.textSize = 7f * density
      label.color = Dim.toArgb()
      label.textAlign = Paint.Align.CENTER
      nc.drawText(p.body.name.uppercase(), p.x, p.y + p.r + 9 * density, label)
    }
  }
}

internal fun lighten(c: Color, k: Float) = Color(c.red + (1 - c.red) * k, c.green + (1 - c.green) * k, c.blue + (1 - c.blue) * k, c.alpha)
internal fun darken(c: Color, k: Float) = Color(c.red * (1 - k), c.green * (1 - k), c.blue * (1 - k), c.alpha)

/** Milliseconds since this composable appeared, advanced every frame. */
@Composable
internal fun rememberClock(): MutableLongState {
  val t = remember { mutableLongStateOf(0L) }
  LaunchedEffect(Unit) {
    val start = withFrameMillis { it }
    while (true) withFrameMillis { t.longValue = it - start }
  }
  return t
}

/** One bezel detent, give or take: a notch per system, not a flick. */
internal const val ROTARY_STEP_PX = 48f
