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
import androidx.compose.ui.graphics.ColorFilter
import androidx.compose.ui.graphics.ColorMatrix
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
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.draw.clip

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
  // WHEN THIS WATCH FIRST SAW EACH KILL, so a wreck plays once as it
  // arrives instead of restarting on every 30s poll. Forgotten when the
  // Porthole closes, which is what replays the deaths when you look in.
  val wreckSeen = remember { HashMap<String, Long>() }
  // WHERE EACH HULL WAS SITTING, kept from poll to poll. A ship that
  // dies is gone from the next document entirely, so without this the
  // explosion had nowhere to be but a seat picked from its id -- the
  // hull vanished from one place and blew up in another.
  val lastSeat = remember { HashMap<String, Seat>() }
  // WHEN THIS PORTHOLE FIRST SAW EACH MOVEMENT, on the same rule as the
  // wrecks: forgotten when it closes, so opening a world replays the
  // tick's arrivals and departures, and a tick that lands while you are
  // watching plays as it happens.
  val moveSeen = remember { HashMap<String, Long>() }
  // The world itself, as the game paints it (PlanetSprites).
  val spriteKey = world?.sp ?: body?.sp
  val ctxSprite = LocalContext.current
  val spriteScale = spriteKey?.let { PlanetSprites.scale(it) } ?: 1
  var sprite by remember(spriteKey) { mutableStateOf(spriteKey?.let { PlanetSprites.cached(it, PORTHOLE_SPRITE_PX * spriteScale) }) }
  LaunchedEffect(spriteKey) {
    if (spriteKey != null && sprite == null) sprite = PlanetSprites.load(ctxSprite, spriteKey, PORTHOLE_SPRITE_PX * spriteScale)
  }
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
  // A departing hull is no longer in the ships list, so its icon has to
  // be asked for alongside the ones still in orbit.
  val keys = ((world?.ships?.map { it.key } ?: emptyList()) + (world?.moves?.map { it.key } ?: emptyList()))
    .map { hullKey(it) }.distinct()
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
      drawPlanet(c, planetR, color, sprite, spriteScale)
      if (world == null) return@Canvas
      // How far through its flight each movement is, 0..1, or absent
      // once it is over. Arrivals bend the hull's own position; the
      // departures are drawn afterwards, since those hulls are gone.
      val flights = HashMap<String, Float>(world.moves.size)
      for (m in world.moves) {
        val born = moveSeen.getOrPut(m.id) { t }
        val k = (t - born) / FLIGHT_MS
        if (k in 0f..1f) flights[m.id] = k
      }
      drawOrbits(world, worlds, slots, c, planetR, t, density, icons, positions, lastSeat, flights)
      drawDepartures(world, worlds, c, planetR, t, density, icons, flights, lastSeat)
      drawBattleFx(worlds, slots, positions, t, density, fighting && world.firing, targetsIn(world, worlds, positions))
      // The dead, thrown outward where they died.
      for (w in world.dead) {
        val born = wreckSeen.getOrPut(w.id) { t }
        // How far through its three ticks this wreck is: the debris
        // thins out over the whole window rather than vanishing when
        // the server stops reporting it.
        val ticksOld = (worlds.tick - w.atTick).coerceAtLeast(0)
        drawWreck(
          // Where it actually was, if this Porthole saw it alive.
          lastSeat[w.id]?.at(c, t) ?: wreckSeat(w, c, planetR, density, t),
          factionColor(worlds.colorOf(w.faction)),
          t - born,
          (ticksOld / 3f).coerceIn(0f, 1f),
          density,
        )
      }
    }

    Column(
      Modifier.fillMaxWidth().padding(top = 22.dp),
      horizontalAlignment = Alignment.CenterHorizontally,
    ) {
      Text(name.uppercase(), color = Ink, fontSize = 12.sp, textAlign = TextAlign.Center)
      if (world != null) {
        // WHOSE SHIPS, IN WHOSE COLOURS. This was two identical stars --
        // yours then everyone else's -- which said nothing about who was
        // here, and read as "0" at every world for a player with no
        // fleet left. Each empire in the orbit now gets its own count in
        // its own livery, the way the Systems page counts them, and an
        // empire with nothing here is simply not mentioned.
        val counts = world.counts.entries
          .filter { it.value > 0 }
          .sortedWith(compareByDescending<Map.Entry<String, Int>> { it.key == worlds.me }.thenByDescending { it.value })
        if (counts.isEmpty()) {
          Text("NO SHIPS", color = Dim, fontSize = 9.sp)
        } else {
          Row(horizontalArrangement = Arrangement.Center, verticalAlignment = Alignment.CenterVertically) {
            for ((i, e) in counts.withIndex()) {
              if (i > 0) Text("   ", color = Dim, fontSize = 9.sp)
              FactionMark(worlds, e.key)
              Text(
                " ${e.value}",
                color = factionColor(worlds.colorOf(e.key)),
                fontSize = 10.sp,
              )
            }
          }
        }
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
internal class Slot(val ship: OrbitShip, val ring: Int, val angle0: Float, val iconDp: Float)

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

private fun DrawScope.drawPlanet(c: Offset, r: Float, color: Color, sprite: ImageBitmap?, scale: Int = 1) {
  drawCircle(Brush.radialGradient(listOf(color.copy(alpha = 0.22f), Color.Transparent), c, r * 1.7f), radius = r * 1.7f, center = c)
  if (sprite != null) {
    val half = r * scale
    val d = (half * 2).roundToInt()
    drawImage(
      sprite,
      srcOffset = IntOffset.Zero,
      srcSize = IntSize(sprite.width, sprite.height),
      dstOffset = IntOffset((c.x - half).roundToInt(), (c.y - half).roundToInt()),
      dstSize = IntSize(d, d),
    )
    return
  }
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
  lastSeat: HashMap<String, Seat>,
  flights: Map<String, Float>,
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
    // Kept for the wreck, if this hull is dead by the next poll.
    lastSeat[s.ship.id] = Seat(r, s.angle0, w)
    val seat = Offset(c.x + cos(a) * r, c.y + sin(a) * r)
    // ARRIVING: still out there, decelerating onto its station. The
    // recap's easing -- 1-(1-k)^2 -- so it comes in fast and settles.
    val flight = flights[s.ship.id]
    val far = Offset(c.x + cos(a) * size.minDimension, c.y + sin(a) * size.minDimension)
    val p = if (flight == null) seat else {
      val u = 1f - (1f - flight) * (1f - flight)
      Offset(far.x + (seat.x - far.x) * u, far.y + (seat.y - far.y) * u)
    }
    positions[s.ship.id] = p
    val faction = factionColor(worlds.colorOf(s.ship.faction))
    val px = s.iconDp * density * shrink
    // THE ENGINE IS BURNING, and the plume says so: a cone at the bell
    // pointing back along the orbit, not a ribbon laid behind the hull.
    // A hull braking onto station points the other way: it is burning
    // AGAINST its approach, which is what the recap draws too.
    val travel = if (flight == null) (a + PI / 2).toFloat() else (a + PI).toFloat()
    enginePlume(p, travel, px, faction, t, s.ship.id.hashCode())
    val heading = Math.toDegrees(travel.toDouble()).toFloat()
    rotate(heading, pivot = p) {
      val img = icons[hullKey(s.ship.key)]
      if (img != null) {
        val h = px * img.height / img.width.toFloat()
        drawImage(
          img,
          srcOffset = IntOffset.Zero,
          srcSize = IntSize(img.width, img.height),
          dstOffset = IntOffset((p.x - px / 2).roundToInt(), (p.y - h / 2).roundToInt()),
          dstSize = IntSize(px.roundToInt(), h.roundToInt()),
          colorFilter = liveryFilter(faction),
        )
      } else {
        val tri = Path().apply {
          moveTo(p.x + px / 2, p.y)
          lineTo(p.x - px / 2, p.y - px / 4)
          lineTo(p.x - px / 2, p.y + px / 4)
          close()
        }
        drawPath(tri, faction)
      }
    }
    // Hurt hulls say so with a pip under them: the hull itself now wears
    // its owner's colour, so health can no longer be its colour too.
    val hp = s.ship.hp
    if (hp != null && hp <= 66) {
      drawCircle(healthColor(hp), radius = 1.8f * density, center = Offset(p.x, p.y + px * 0.55f))
    }
    if (s.ship.lead) {
      drawCircle(faction, radius = 2f * density, center = Offset(p.x, p.y - px * 0.55f))
    }
  }
}

/**
 * WHO IS SHOOTING AT WHOM. The server stamps each hull's last target,
 * which is the true pairing; a fight one tick old may have no stamps
 * left, and then fighters are paired across the sides so the battle
 * still reads as a battle rather than as a staring contest.
 */
private fun targetsIn(world: World, worlds: Worlds, positions: Map<String, Offset>): Map<String, String> {
  val out = HashMap<String, String>()
  for (sh in world.ships) {
    val t = sh.target
    if (t != null && positions.containsKey(t)) out[sh.id] = t
  }
  if (out.isEmpty()) {
    val fighters = world.ships.filter { it.fighting && positions.containsKey(it.id) }
    val mine = fighters.filter { it.faction == worlds.me }
    val theirs = fighters.filter { it.faction != worlds.me }
    if (mine.isNotEmpty() && theirs.isNotEmpty()) {
      for ((i, sh) in mine.withIndex()) out[sh.id] = theirs[i % theirs.size].id
      for ((i, sh) in theirs.withIndex()) out[sh.id] = mine[i % mine.size].id
    }
  }
  return out
}

/**
 * THE ONES THAT LEFT, burning out of the system.
 *
 * A departing hull is in transit, which means it is in no ships list
 * anywhere -- so it is drawn here from the movement alone: out along the
 * radius it left on, accelerating (the recap's k^2), plume rising, the
 * hull shrinking away and fading as it goes. If this Porthole saw it
 * alive it leaves from exactly where it was sitting; otherwise from a
 * seat picked off its id, which is the same compromise the wrecks make.
 */
private fun DrawScope.drawDepartures(
  world: World,
  worlds: Worlds,
  c: Offset,
  planetR: Float,
  t: Long,
  density: Float,
  icons: Map<String, ImageBitmap>,
  flights: Map<String, Float>,
  lastSeat: HashMap<String, Seat>,
) {
  for (m in world.moves) {
    if (m.into) continue
    val k = flights[m.id] ?: continue
    val from = lastSeat[m.id]?.at(c, t)
      ?: run {
        val a0 = (abs(m.id.hashCode()) % 628) / 100f
        val r = planetR + (FIRST_RING_DP + RING_GAP_DP * 0.5f) * density
        Offset(c.x + cos(a0) * r, c.y + sin(a0) * r)
      }
    val out = kotlin.math.atan2(from.y - c.y, from.x - c.x)
    val far = Offset(c.x + cos(out) * size.minDimension, c.y + sin(out) * size.minDimension)
    val u = k * k
    val p = Offset(from.x + (far.x - from.x) * u, from.y + (far.y - from.y) * u)
    val faction = factionColor(worlds.colorOf(m.faction))
    val px = iconDp(m.cls) * density * (1f - 0.25f * k)
    // Burning harder the further it gets: it is under acceleration, and
    // the recap ramps the plume the same way.
    enginePlume(p, out, px * (0.9f + 0.9f * k), faction, t, m.id.hashCode())
    val fade = 1f - k * k
    rotate(Math.toDegrees(out.toDouble()).toFloat(), pivot = p) {
      val img = icons[hullKey(m.key)]
      if (img != null) {
        val h = px * img.height / img.width.toFloat()
        drawImage(
          img,
          srcOffset = IntOffset.Zero,
          srcSize = IntSize(img.width, img.height),
          dstOffset = IntOffset((p.x - px / 2).roundToInt(), (p.y - h / 2).roundToInt()),
          dstSize = IntSize(px.roundToInt(), h.roundToInt()),
          alpha = fade,
          colorFilter = liveryFilter(faction),
        )
      } else {
        drawCircle(faction.copy(alpha = fade), radius = px * 0.3f, center = p)
      }
    }
  }
}

/** How long an arrival or a departure takes to play, in milliseconds. */
private const val FLIGHT_MS = 2600f

/**
 * A hull's place in the orbit, kept after the hull is gone.
 *
 * Its debris keeps orbiting at the radius and rate the ship had, which
 * is what makes a kill read as happening WHERE the ship was rather than
 * at some seat picked out of its id.
 */
internal class Seat(val radius: Float, val angle0: Float, val rate: Float) {
  fun at(c: Offset, t: Long): Offset {
    val a = angle0 + rate * t
    return Offset(c.x + cos(a) * radius, c.y + sin(a) * radius)
  }
}

/** Where a wreck hangs when this Porthole never saw the hull alive --
 *  opened after the kill, or a ship that died before the first poll. */
private fun wreckSeat(w: Wreck, c: Offset, planetR: Float, density: Float, t: Long): Offset {
  val r = planetR + (FIRST_RING_DP + RING_GAP_DP * 0.5f) * density
  val a0 = (abs(w.id.hashCode()) % 628) / 100f
  val a = a0 + (2f * Math.PI.toFloat() / INNER_LAP_MS) * t
  return Offset(c.x + cos(a) * r, c.y + sin(a) * r)
}

private fun healthColor(hp: Int?): Color = when {
  hp == null -> Dim
  hp <= 33 -> Alarm
  hp <= 66 -> Warn
  else -> Good
}

/**
 * EVERY HULL IN ITS OWNER'S COLOUR. The game's icons come coloured by
 * health (green/amber/red); on the watch the hull wears its empire's
 * livery instead, as the map draws it. Always the green drawing, so
 * every hull starts from the same shading, then its brightness is
 * carried onto the faction colour -- light and shadow kept, hue replaced.
 */
private fun hullKey(key: String): String = key.substringBeforeLast(':') + ":green"

private val LIVERY = HashMap<Color, ColorFilter>()

private fun liveryFilter(c: Color): ColorFilter = LIVERY.getOrPut(c) {
  // Luma of the green drawing, lifted so its midtones land near the
  // faction colour itself rather than a darker shade of it.
  val k = 1.7f
  val (r, g, b) = Triple(c.red * k, c.green * k, c.blue * k)
  ColorFilter.colorMatrix(
    ColorMatrix(
      floatArrayOf(
        0.299f * r, 0.587f * r, 0.114f * r, 0f, 0f,
        0.299f * g, 0.587f * g, 0.114f * g, 0f, 0f,
        0.299f * b, 0.587f * b, 0.114f * b, 0f, 0f,
        0f, 0f, 0f, 1f, 0f,
      ),
    ),
  )
}

/** The Porthole's planet is the biggest thing on the watch; fetched sharp. */
private const val PORTHOLE_SPRITE_PX = 192

/**
 * WHOSE SHIPS THESE ARE, in the empire's own flag.
 *
 * The emblem is the game's own artwork, stamped from the Herald's masks
 * and served white so it can be tinted here -- so an empire reads the
 * same on the wrist as it does on the map, rather than as a colour the
 * player has to remember. An empire that never picked an emblem, or one
 * this watch has not fetched yet, is a dot in its colour: the thing it
 * was before, and never a gap.
 */
@Composable
internal fun FactionMark(worlds: Worlds, factionId: String, size: Dp = 11.dp) {
  val tint = factionColor(worlds.colorOf(factionId))
  val id = worlds.emblemOf(factionId)
  val ctx = LocalContext.current
  val px = with(LocalDensity.current) { size.toPx().roundToInt() }.coerceIn(16, 128)
  var flag by remember(id, px) { mutableStateOf(id?.let { FlagIcons.cached(it, px) }) }
  LaunchedEffect(id, px) {
    if (id != null && flag == null) flag = FlagIcons.load(ctx, id, px)
  }
  val img = flag
  if (img == null) {
    Box(Modifier.size(size * 0.55f).clip(CircleShape).background(tint))
  } else {
    Image(
      bitmap = img,
      contentDescription = null,
      modifier = Modifier.size(size),
      colorFilter = ColorFilter.tint(tint),
    )
  }
}
