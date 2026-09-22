package com.orbitalempire.wear

import android.view.HapticFeedbackConstants
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.focusable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.rotate
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.rotary.onRotaryScrollEvent
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.wear.compose.material.Text
import kotlinx.coroutines.delay
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.roundToInt
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * The Porthole: one world, and everything in orbit around it.
 *
 * "Make the player feel like they are looking into the game from their
 * wrist." The planet in the middle; every ship parked there going round
 * it -- yours and every rival's in the same orbit, because a shared orbit
 * has no fog; and when the world is a battlefield, the fight itself:
 * tracers from each ship to the one it is firing on, a flash where they
 * land.
 *
 * THE HULLS ARE THE GAME'S ShipIcon (ShipIcons, fetched as PNGs from the
 * server's own rasteriser), coloured by hull health exactly as the
 * situation log colours them, and flown nose-first along their orbit.
 * Empire identity is the short trail each ship draws behind it, in its
 * faction's colour -- the battle card's rule: identity on the livery,
 * never on the hull, which carries health.
 *
 * FORMATION. A fleet flies together: its members take consecutive
 * places on one ring with the flagship leading, and each faction starts
 * a ring of its own, yours innermost. Inner rings run faster than outer
 * ones (Kepler, roughly), so the picture is never still.
 *
 * THE MOTION IS THE WATCH'S, THE FACTS ARE THE GAME'S. Who is where, at
 * what health, shooting whom, comes from the server every 30 seconds;
 * the orbiting is drawn here, so it costs no network at all.
 *
 * BATTLES STAY UP. While this world is fighting the screen does not
 * time out -- the point of looking at a battle is to keep looking.
 */
@Composable
fun PortholeScreen(
  worlds: Worlds,
  bodyId: String,
  onStep: (Int) -> Unit,
  onClose: () -> Unit,
  /** A tap on one of YOUR ships: its orders. Rivals just show their name. */
  onShip: (String) -> Unit = {},
) {
  BackHandler(onBack = onClose)
  val world = worlds.world(bodyId)
  val body = remember(worlds, bodyId) { worlds.systems.flatMap { it.bodies }.firstOrNull { it.id == bodyId } }
  val name = world?.name ?: body?.name ?: "?"
  val color = factionColor(world?.color ?: body?.color ?: "#8899aa")
  val type = world?.type ?: body?.type ?: "terrestrial"
  val fighting = world?.battle == true

  val view = LocalView.current
  DisposableEffect(fighting) {
    view.keepScreenOn = fighting
    onDispose { view.keepScreenOn = false }
  }

  val focus = remember { FocusRequester() }
  var acc by remember { mutableFloatStateOf(0f) }
  LaunchedEffect(Unit) { focus.requestFocus() }

  // Icons, fetched once per key and then drawn every frame.
  val ctx = LocalContext.current
  val icons = remember { mutableStateMapOf<String, ImageBitmap>() }
  val keys = world?.ships?.map { it.key }?.distinct() ?: emptyList()
  LaunchedEffect(keys) {
    for (k in keys) {
      if (icons.containsKey(k)) continue
      ShipIcons.load(ctx, k)?.let { icons[k] = it }
    }
  }

  var selected by remember { mutableStateOf<OrbitShip?>(null) }
  LaunchedEffect(selected) { if (selected != null) { delay(3500); selected = null } }

  val clock = rememberClock()
  val density = LocalDensity.current.density
  val slots = remember(world, density) { if (world != null) formation(world, worlds.me) else emptyList() }
  val positions = remember { HashMap<String, Offset>() }

  Box(
    Modifier
      .fillMaxSize()
      .background(Ground)
      .onRotaryScrollEvent { e ->
        acc += e.verticalScrollPixels
        if (abs(acc) >= ROTARY_STEP_PX) {
          onStep(if (acc > 0) 1 else -1)
          view.performHapticFeedback(HapticFeedbackConstants.CLOCK_TICK)
          acc = 0f
        }
        true
      }
      .focusRequester(focus)
      .focusable(),
  ) {
    Canvas(
      Modifier
        .fillMaxSize()
        .pointerInput(slots) {
          detectTapGestures { p ->
            val near = slots.minByOrNull { s ->
              val q = positions[s.ship.id] ?: Offset(-1e6f, -1e6f)
              (q.x - p.x) * (q.x - p.x) + (q.y - p.y) * (q.y - p.y)
            }
            val q = near?.let { positions[it.ship.id] }
            val hit = if (near != null && q != null &&
              sqrt((q.x - p.x) * (q.x - p.x) + (q.y - p.y) * (q.y - p.y)) < 20 * density
            ) near.ship else null
            if (hit != null && hit.faction == worlds.me) onShip(hit.id) else selected = hit
          }
        },
    ) {
      val t = clock.longValue
      val c = Offset(size.width / 2f, size.height / 2f + 4 * density)
      val s = min(size.width, size.height)
      val planetR = s * when (type) {
        "gas-giant", "gas_giant", "ice-giant", "ice_giant" -> 0.17f
        "moon", "asteroid", "dwarf" -> 0.10f
        else -> 0.13f
      }
      drawPlanet(c, planetR, color)
      if (world == null) return@Canvas
      drawOrbits(world, worlds, slots, c, planetR, t, density, icons, positions)
      if (fighting) drawCombat(world, worlds, slots, positions, t, density, world.firing)
    }

    Column(
      Modifier.fillMaxWidth().padding(top = 22.dp),
      horizontalAlignment = Alignment.CenterHorizontally,
    ) {
      Text(name.uppercase(), color = Ink, fontSize = 12.sp, textAlign = TextAlign.Center)
      if (world != null) {
        val mineN = world.counts[worlds.me] ?: 0
        val rivalsN = world.counts.filterKeys { it != worlds.me }.values.sum()
        Text(
          if (rivalsN > 0) "★$mineN  ·  ★$rivalsN" else "★$mineN",
          color = if (rivalsN > 0) Warn else factionColor(worlds.colorOf(worlds.me)),
          fontSize = 9.sp,
        )
      }
      if (fighting) {
        Text(if (world?.firing == true) "FIRING" else "STANDOFF", color = Alarm, fontSize = 9.sp)
      }
    }

    val sel = selected
    Text(
      when {
        sel != null -> "${sel.name.uppercase()} · ${sel.hp?.let { "$it%" } ?: "?"}"
        world == null && body?.seen == false -> "OUT OF SENSOR RANGE"
        world == null -> "NO SHIPS IN ORBIT"
        else -> ""
      },
      color = if (sel != null) factionColor(worlds.colorOf(sel.faction)) else Dim,
      fontSize = 9.sp,
      textAlign = TextAlign.Center,
      modifier = Modifier.align(Alignment.BottomCenter).padding(bottom = 18.dp, start = 28.dp, end = 28.dp),
    )
  }
}

/** A ship's place in the picture: ring, starting angle, and speed. */
private class Slot(val ship: OrbitShip, val ring: Int, val angle0: Float, val iconDp: Float)

private const val RING_GAP_DP = 15f
private const val FIRST_RING_DP = 16f
private const val SPACING_DP = 21f
/** One lap of the innermost ring. */
private const val INNER_LAP_MS = 36_000f

private fun iconDp(cls: String): Float = when (cls.lowercase()) {
  "corvette", "scout" -> 15f
  "frigate", "freighter", "colony", "miner", "tanker" -> 17f
  "destroyer" -> 20f
  "cruiser" -> 23f
  "battleship", "dreadnought", "carrier", "capital" -> 26f
  else -> 17f
}

/**
 * Seat every ship: yours first on the innermost rings, then each rival
 * faction on rings of its own; within a faction, each fleet in
 * consecutive seats led by its flagship, then the loose hulls.
 */
private fun formation(world: World, me: String): List<Slot> {
  val byFaction = world.ships.groupBy { it.faction }
  val order = listOf(me) + byFaction.keys.filter { it != me }.sorted()
  val out = ArrayList<Slot>()
  var ring = 0
  for (fid in order) {
    val ships = byFaction[fid] ?: continue
    val fleets = ships.filter { it.fleet != null }.groupBy { it.fleet!! }.values
      .map { f -> f.sortedByDescending { it.lead } }
    val seated = fleets.flatten() + ships.filter { it.fleet == null }
    var k = 0
    while (k < seated.size) {
      val radiusDp = 60f + ring * RING_GAP_DP
      val capacity = max(4, floor(2 * PI * radiusDp / SPACING_DP).toInt())
      val here = seated.subList(k, min(seated.size, k + capacity))
      // Rival rings start on the far side, so the two forces begin
      // facing each other across the planet.
      val offset = if (fid == me) 0f else PI.toFloat()
      for ((i, sh) in here.withIndex()) {
        out += Slot(sh, ring, offset + (2 * PI * i / capacity).toFloat(), iconDp(sh.cls))
      }
      k += here.size
      ring++
    }
  }
  return out
}

private fun DrawScope.drawPlanet(c: Offset, r: Float, color: Color) {
  drawCircle(Brush.radialGradient(listOf(color.copy(alpha = 0.22f), Color.Transparent), c, r * 1.7f), radius = r * 1.7f, center = c)
  drawCircle(
    Brush.radialGradient(listOf(lighten(color, 0.35f), color, darken(color, 0.65f)), Offset(c.x - r * 0.4f, c.y - r * 0.4f), r * 1.7f),
    radius = r,
    center = c,
  )
}

private fun DrawScope.drawOrbits(
  world: World,
  worlds: Worlds,
  slots: List<Slot>,
  c: Offset,
  planetR: Float,
  t: Long,
  density: Float,
  icons: Map<String, ImageBitmap>,
  positions: HashMap<String, Offset>,
) {
  val maxRing = slots.maxOfOrNull { it.ring } ?: 0
  val fit = min(size.width, size.height) / 2f * 0.86f
  val first = planetR + FIRST_RING_DP * density
  // Squeeze the rings to fit a crowded orbit rather than drawing off-screen.
  val gap = if (maxRing == 0) 0f else min(RING_GAP_DP * density, (fit - first) / maxRing)
  val shrink = if (slots.size > 24) 0.8f else 1f
  for (ring in 0..maxRing) {
    drawCircle(Trough.copy(alpha = 0.55f), radius = first + ring * gap, center = c, style = Stroke(width = 0.8f * density))
  }
  positions.clear()
  for (s in slots) {
    val r = first + s.ring * gap
    val w = (2 * PI / INNER_LAP_MS * (first / r).toDouble().pow(1.5)).toFloat()
    val a = s.angle0 + w * t
    val p = Offset(c.x + cos(a) * r, c.y + sin(a) * r)
    positions[s.ship.id] = p
    val faction = factionColor(worlds.colorOf(s.ship.faction))
    // The livery trail, behind the hull.
    drawArc(
      faction.copy(alpha = 0.45f),
      startAngle = Math.toDegrees((a - 0.34f).toDouble()).toFloat(),
      sweepAngle = Math.toDegrees(0.30).toFloat(),
      useCenter = false,
      topLeft = Offset(c.x - r, c.y - r),
      size = Size(r * 2, r * 2),
      style = Stroke(width = 2f * density),
    )
    val px = s.iconDp * density * shrink
    val heading = Math.toDegrees((a + PI / 2).toDouble()).toFloat()
    rotate(heading, pivot = p) {
      val img = icons[s.ship.key]
      if (img != null) {
        val h = px * img.height / img.width.toFloat()
        drawImage(
          img,
          srcOffset = IntOffset.Zero,
          srcSize = IntSize(img.width, img.height),
          dstOffset = IntOffset((p.x - px / 2).roundToInt(), (p.y - h / 2).roundToInt()),
          dstSize = IntSize(px.roundToInt(), h.roundToInt()),
        )
      } else {
        val tri = Path().apply {
          moveTo(p.x + px / 2, p.y)
          lineTo(p.x - px / 2, p.y - px / 4)
          lineTo(p.x - px / 2, p.y + px / 4)
          close()
        }
        drawPath(tri, healthColor(s.ship.hp))
      }
    }
    if (s.ship.lead) {
      drawCircle(faction, radius = 2f * density, center = Offset(p.x, p.y - px * 0.55f))
    }
  }
}

/**
 * Tracers from each shooter to the ship it last fired on, a flash where
 * each lands. Every shooter keeps its own rhythm (its id picks the beat),
 * so a big fight crackles rather than blinking in unison. A battle that
 * is open but not firing this tick is a standoff and draws no shots.
 */
private fun DrawScope.drawCombat(
  world: World,
  worlds: Worlds,
  slots: List<Slot>,
  positions: Map<String, Offset>,
  t: Long,
  density: Float,
  firing: Boolean,
) {
  if (!firing) return
  val pairs = ArrayList<Pair<OrbitShip, String>>()
  for (s in slots) {
    val target = s.ship.target
    if (target != null && positions.containsKey(target)) pairs += s.ship to target
  }
  // No targets on record (a fight a tick old): pair fighters across
  // sides so the fight still reads as a fight.
  if (pairs.isEmpty()) {
    val fighters = slots.map { it.ship }.filter { it.fighting }
    val mine = fighters.filter { it.faction == worlds.me }
    val theirs = fighters.filter { it.faction != worlds.me }
    if (mine.isNotEmpty() && theirs.isNotEmpty()) {
      for ((i, sh) in mine.withIndex()) pairs += sh to theirs[i % theirs.size].id
      for ((i, sh) in theirs.withIndex()) pairs += sh to mine[i % mine.size].id
    }
  }
  for ((shooter, targetId) in pairs) {
    val from = positions[shooter.id] ?: continue
    val to = positions[targetId] ?: continue
    val beat = 1100 + (abs(shooter.id.hashCode()) % 900)
    val phase = abs(shooter.id.hashCode() / 7) % beat
    val k = ((t + phase) % beat).toFloat()
    if (k > 180f) continue
    val f = k / 180f
    val color = lighten(factionColor(worlds.colorOf(shooter.faction)), 0.35f)
    drawLine(color.copy(alpha = 1f - f), from, to, strokeWidth = 1.4f * density)
    drawCircle(Color.White.copy(alpha = 0.9f * (1f - f)), radius = (2f + 5f * f) * density, center = to)
  }
}

private fun healthColor(hp: Int?): Color = when {
  hp == null -> Dim
  hp <= 33 -> Alarm
  hp <= 66 -> Warn
  else -> Good
}
