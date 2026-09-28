package com.orbitalempire.wear

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.focusable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.pager.VerticalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.rotary.onRotaryScrollEvent
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.wear.compose.material.Text
import kotlinx.coroutines.launch
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.sin

/**
 * DECISIONS: everything that needs you, one to a screen, each with the
 * button that answers it.
 *
 * The old watch split this across Battles, Senate, Comms and Yards, so
 * "is anything waiting on me" took four swipes and a read of each. Here
 * it is one stack, most urgent first -- a fight, a vote about to close,
 * an offer, idle science, an idle yard, a fleet that just arrived -- and
 * the bezel steps through it. Answer a card and it leaves the stack.
 *
 * AN ALERT OPENS ITS OWN CARD: a battle, bill or trade alert names its
 * subject (worker/wearAlerts.js), and [focus] scrolls there.
 */
@Composable
fun DecisionsScreen(
  ui: WearViewModel.UiState,
  vm: WearViewModel,
  nav: Nav,
  focus: String?,
  focusNonce: Int,
  active: Boolean,
) {
  val list = remember(ui.state, ui.command) { decisionsOf(ui.state, ui.command) }
  if (list.isEmpty()) {
    AllQuiet(ui)
    return
  }
  val pager = rememberPagerState { list.size }
  val scope = rememberCoroutineScope()
  val ctx = LocalContext.current
  LaunchedEffect(focus, focusNonce, list.size) {
    val i = list.indexOfFirst { it.key == focus }
    if (i >= 0) pager.scrollToPage(i)
  }
  val requester = remember { FocusRequester() }
  LaunchedEffect(active) { if (active) try { requester.requestFocus() } catch (_: Throwable) { } }
  var acc by remember { mutableFloatStateOf(0f) }
  Box(
    Modifier
      .fillMaxSize()
      .onRotaryScrollEvent { e ->
        acc += e.verticalScrollPixels
        if (abs(acc) >= ROTARY_STEP_PX) {
          val next = (pager.currentPage + if (acc > 0) 1 else -1).coerceIn(0, list.lastIndex)
          if (next != pager.currentPage) {
            Haptics.detent(ctx)
            scope.launch { pager.animateScrollToPage(next) }
          }
          acc = 0f
        }
        true
      }
      .focusRequester(requester)
      .focusable(),
  ) {
    VerticalPager(state = pager, modifier = Modifier.fillMaxSize()) { i ->
      val d = list[i]
      val top = "${i + 1} OF ${list.size} · ${kindLabel(d)}"
      when (d) {
        is Decision.Fight -> FightCard(d, top, ui, vm, nav)
        is Decision.Vote -> VoteCard(d, top, ui, vm)
        is Decision.Trade -> TradeCard(d, top, ui, vm)
        is Decision.Peace -> PeaceCard(d, top, ui, vm, nav)
        is Decision.Research -> ResearchCard(top, ui, nav)
        is Decision.IdleYard -> YardCard(d, top, ui, vm)
        is Decision.Idle -> IdleCard(d, top, ui, nav)
      }
    }
    // Where you are in the stack, down the right-hand rim.
    Canvas(Modifier.fillMaxSize()) {
      val n = list.size.coerceAtMost(9)
      val r = size.minDimension / 2f - size.minDimension * 0.035f
      val span = (n - 1) * 5f
      for (k in 0 until n) {
        val deg = -span / 2f + k * 5f
        val a = Math.toRadians(deg.toDouble())
        val p = Offset(center.x + r * cos(a).toFloat(), center.y + r * sin(a).toFloat())
        val on = k == pager.currentPage.coerceAtMost(n - 1)
        drawCircle(if (on) tierInk(list[k].tier) else Label.copy(alpha = 0.5f), radius = size.minDimension * (if (on) 0.011f else 0.007f), center = p)
      }
    }
  }
}

private fun kindLabel(d: Decision): String = when (d) {
  is Decision.Fight -> "UNDER FIRE"
  is Decision.Vote -> if (d.bill.closesIn <= 0) "CLOSING NOW" else "CLOSES IN ${d.bill.closesIn} TICK${if (d.bill.closesIn == 1) "" else "S"}"
  is Decision.Trade -> "TRADE OFFER"
  is Decision.Peace -> "PEACE OFFERED"
  is Decision.Research -> "SCIENCE IDLE"
  is Decision.IdleYard -> "IDLE YARD"
  is Decision.Idle -> if (d.arrived) "ARRIVED" else "IDLE"
}

internal fun tierInk(tier: Int): Color = when (tier) {
  0 -> Alarm
  1 -> Warn
  else -> Teal
}

/** A card's top arc and ring, in its tier's colour. */
@Composable
private fun Card(top: String, tier: Int, content: @Composable (Dp) -> Unit) {
  val ink = when (tier) {
    0 -> Color(0xFFFF8A82)
    1 -> Warn
    else -> Color(0xFF7FE6DE)
  }
  Frame(top = top, topInk = ink, rim = { rimRing(0f, ink, trough = ink.copy(alpha = 0.16f)) }) { s -> content(s) }
}

@Composable
private fun AllQuiet(ui: WearViewModel.UiState) {
  Frame(top = "DECISIONS", topInk = Sub) { s ->
    Column(Modifier.fillMaxSize(), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
      PlanetArt(ui.state.capital?.sp, u(s, 110f), alpha = 0.7f)
      Spacer(Modifier.height(u(s, 12f)))
      Text("ALL QUIET", color = Ink, fontSize = tp(s, 24f), fontFamily = GameFont)
      Text(
        if (ui.state.isLive) "Nothing needs you" else "No game in progress",
        color = Sub, fontSize = tp(s, 15f), textAlign = TextAlign.Center,
      )
    }
  }
}

/**
 * A FIGHT: the world, both sides' hulls in orbit, a shot crossing between
 * them, and the two answers -- RETREAT (held) or WATCH (the Porthole).
 */
@Composable
private fun FightCard(d: Decision.Fight, top: String, ui: WearViewModel.UiState, vm: WearViewModel, nav: Nav) {
  val b = d.battle
  val world = b.bodyId?.let { ui.worlds?.world(it) }
  val place = placeOf(ui.worlds, b.bodyId)
  val mine = b.sides.filter { it.mine }
  val theirs = b.sides.filter { !it.mine }
  val rival = theirs.maxByOrNull { it.alive }
  val rivalId = ui.worlds?.factions?.entries?.firstOrNull { it.value.name == rival?.name }?.key
  val myAlive = mine.sumOf { it.alive }
  val theirAlive = theirs.sumOf { it.alive }
  val myHp = mine.flatMap { it.hulls }.filterNotNull().let { if (it.isEmpty()) null else it.average().toInt() }
  // Hulls to draw: yours from the orders feed (with their health), theirs
  // from the orbit feed when the watch has it, in their livery.
  val myKeys = d.mine.take(5).map { it.key }
  val theirShips = world?.ships?.filter { it.faction != ui.worlds?.me }?.take(4)
  val clock = rememberClock()
  Card(top, 0) { s ->
    Box(Modifier.fillMaxSize().background(Color(0x1AFF3020)))
    Column(Modifier.fillMaxSize().padding(top = u(s, 52f)), horizontalAlignment = Alignment.CenterHorizontally) {
      Text((place?.name ?: b.body).uppercase(), color = Ink, fontSize = tp(s, 26f), fontFamily = GameFont, maxLines = 1)
      if (rival != null) {
        Row(verticalAlignment = Alignment.CenterVertically) {
          Text("vs ", color = Color(0xFFFF8F6B), fontSize = tp(s, 14f))
          FlagArt(rivalId?.let { ui.worlds?.emblemOf(it) }, factionColor(rival.color), u(s, 16f))
          Text(" ${rival.name.uppercase()}", color = Color(0xFFFF8F6B), fontSize = tp(s, 14f), fontWeight = FontWeight.Bold, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
      }
      // The orbit: the world, your hulls on the left, theirs on the right.
      Box(Modifier.size(u(s, 170f)), contentAlignment = Alignment.Center) {
        PlanetArt(place?.sp ?: world?.sp, u(s, 84f), fallback = factionColor(world?.color ?: "#8899aa"))
        val ring = u(s, 70f)
        myKeys.forEachIndexed { i, k ->
          val deg = 200f - 36f * (i - (myKeys.size - 1) / 2f)
          Seat(deg, ring) { HullArt(k, u(s, 26f), rotation = deg + 90f) }
        }
        val rivalInk = factionColor(rival?.color ?: "#FF7043")
        if (theirShips != null && theirShips.isNotEmpty()) {
          theirShips.forEachIndexed { i, sh ->
            val deg = -20f + 36f * (i - (theirShips.size - 1) / 2f)
            Seat(deg, ring) {
              HullArt(sh.key.substringBeforeLast(':') + ":green", u(s, 26f), rotation = deg + 90f, tint = liveryFilter(factionColor(ui.worlds?.colorOf(sh.faction) ?: "#FF7043")))
            }
          }
        } else {
          repeat(theirAlive.coerceAtMost(4)) { i ->
            val deg = -20f + 36f * (i - (theirAlive.coerceAtMost(4) - 1) / 2f)
            Seat(deg, ring) { HullArt("corvette:B:green", u(s, 24f), rotation = deg + 90f, tint = liveryFilter(rivalInk)) }
          }
        }
        // A shot across, flashing where it lands, once a second or so.
        Canvas(Modifier.fillMaxSize()) {
          val t = clock.longValue % 1400L
          if (t < 520L && myAlive > 0 && theirAlive > 0) {
            val k = t / 520f
            val r = size.minDimension * 70f / 170f
            val a0 = Math.toRadians(200.0)
            val a1 = Math.toRadians(-20.0)
            val p0 = Offset(center.x + r * cos(a0).toFloat(), center.y + r * sin(a0).toFloat())
            val p1 = Offset(center.x + r * cos(a1).toFloat(), center.y + r * sin(a1).toFloat())
            drawLine(Color(0xFF8FE3FF).copy(alpha = 1f - k), p0, p1, strokeWidth = size.minDimension * 0.012f)
            drawCircle(Warn.copy(alpha = (1f - k) * 0.8f), radius = size.minDimension * (0.04f + 0.06f * k), center = p1)
          }
        }
      }
      // The balance, by hulls still flying.
      Column(Modifier.width(u(s, 260f))) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
          Text("YOU $myAlive" + (myHp?.let { " · HULLS $it%" } ?: ""), color = Teal, fontSize = tp(s, 12f), fontWeight = FontWeight.Bold)
          Text(if (b.known) "THEM $theirAlive" else "THEM ?", color = Color(0xFFFF8F6B), fontSize = tp(s, 12f), fontWeight = FontWeight.Bold)
        }
        val share = if (myAlive + theirAlive == 0) 0.5f else myAlive.toFloat() / (myAlive + theirAlive)
        Row(Modifier.fillMaxWidth().height(u(s, 8f)).padding(top = 2.dp), horizontalArrangement = Arrangement.spacedBy(2.dp)) {
          if (share > 0f) Box(Modifier.weight(share.coerceAtLeast(0.02f)).fillMaxHeight().clip(RoundedCornerShape(4.dp)).background(Teal))
          if (share < 1f) Box(Modifier.weight((1f - share).coerceAtLeast(0.02f)).fillMaxHeight().clip(RoundedCornerShape(4.dp)).background(factionColor(rival?.color ?: "#FF7043")))
        }
      }
      Row(Modifier.width(u(s, 300f)).padding(top = u(s, 10f)), horizontalArrangement = Arrangement.spacedBy(u(s, 10f))) {
        HoldButton(
          "RETREAT", Alarm, Modifier.weight(1.4f), filled = true, height = u(s, 50f),
          enabled = d.mine.isNotEmpty() && ui.command?.orders == true && !ui.ordering,
        ) {
          vm.order(Orders.order("retreat") { put("ship_ids", Orders.ids(d.mine.map { it.id })) }, "Retreating from ${(place?.name ?: b.body).uppercase()}")
        }
        TapButton("WATCH", Ink, Modifier.weight(1f), height = u(s, 50f)) { b.bodyId?.let(nav.watch) }
      }
    }
  }
}

/** A child laid on a circle round the parent's centre at [deg]. */
@Composable
private fun Seat(deg: Float, r: Dp, content: @Composable () -> Unit) {
  val a = Math.toRadians(deg.toDouble())
  Box(Modifier.offset(r * cos(a).toFloat(), r * sin(a).toFloat())) { content() }
}

/** A VOTE: the bill, the tally by weight, and three taps. */
@Composable
private fun VoteCard(d: Decision.Vote, top: String, ui: WearViewModel.UiState, vm: WearViewModel) {
  val bill = d.bill
  Card(top, d.tier) { s ->
    Column(Modifier.fillMaxSize().padding(horizontal = u(s, 56f)).padding(top = u(s, 62f)), horizontalAlignment = Alignment.CenterHorizontally) {
      Text(bill.title.uppercase(), color = Ink, fontSize = tp(s, 19f), fontFamily = GameFont, textAlign = TextAlign.Center, maxLines = 3, overflow = TextOverflow.Ellipsis)
      Text(bill.summary, color = Sub, fontSize = tp(s, 13f), textAlign = TextAlign.Center, maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 2.dp))
      Row(verticalAlignment = Alignment.Bottom, modifier = Modifier.padding(top = u(s, 8f))) {
        Text("${bill.yea}", color = Good, fontSize = tp(s, 34f), fontFamily = GameFont)
        Text(" : ", color = Label, fontSize = tp(s, 26f), fontFamily = GameFont)
        Text("${bill.nay}", color = Alarm, fontSize = tp(s, 34f), fontFamily = GameFont)
      }
      Text("YEA : NAY · BY SENATE WEIGHT", color = Label, fontSize = tp(s, 11f))
      if (ui.voting == bill.id) {
        Text("VOTING…", color = Dim, fontSize = tp(s, 14f), modifier = Modifier.padding(top = u(s, 12f)))
      } else {
        Row(Modifier.fillMaxWidth().padding(top = u(s, 10f)), horizontalArrangement = Arrangement.spacedBy(u(s, 6f))) {
          TapButton("YEA", Good, Modifier.weight(1f), height = u(s, 46f), outline = true) { vm.vote(bill, "yea") }
          TapButton("NAY", Alarm, Modifier.weight(1f), height = u(s, 46f), outline = true) { vm.vote(bill, "nay") }
          TapButton("ABSTAIN", Sub, Modifier.weight(1.3f), height = u(s, 46f)) { vm.vote(bill, "abstain") }
        }
      }
      Text("One tap votes · change it until it closes", color = Label, fontSize = tp(s, 11f), textAlign = TextAlign.Center, modifier = Modifier.padding(top = 3.dp))
    }
  }
}

/** A TRADE: who, what you give, what you get; ACCEPT held, DECLINE tapped. */
@Composable
private fun TradeCard(d: Decision.Trade, top: String, ui: WearViewModel.UiState, vm: WearViewModel) {
  val t = d.offer
  val cmd = ui.command ?: return
  val ink = factionColor(cmd.color(t.from))
  val allowed = cmd.orders && !ui.ordering
  Card(top, d.tier) { s ->
    Column(Modifier.fillMaxSize().padding(horizontal = u(s, 60f)).padding(top = u(s, 62f)), horizontalAlignment = Alignment.CenterHorizontally) {
      Row(verticalAlignment = Alignment.CenterVertically) {
        FlagArt(ui.worlds?.emblemOf(t.from), ink, u(s, 22f))
        Text(" ${cmd.name(t.from).uppercase()}", color = ink, fontSize = tp(s, 16f), fontWeight = FontWeight.Bold, maxLines = 1, overflow = TextOverflow.Ellipsis)
      }
      Row(Modifier.fillMaxWidth().padding(top = u(s, 12f)), horizontalArrangement = Arrangement.SpaceEvenly, verticalAlignment = Alignment.CenterVertically) {
        Column(horizontalAlignment = Alignment.CenterHorizontally, modifier = Modifier.weight(1f)) {
          Text("YOU GIVE", color = Label, fontSize = tp(s, 11f), fontWeight = FontWeight.Bold)
          Text(t.get.ifEmpty { "NOTHING" }, color = Warn, fontSize = tp(s, 17f), fontFamily = GameFont, textAlign = TextAlign.Center, maxLines = 2)
        }
        Text("→", color = Label, fontSize = tp(s, 18f))
        Column(horizontalAlignment = Alignment.CenterHorizontally, modifier = Modifier.weight(1f)) {
          Text("YOU GET", color = Label, fontSize = tp(s, 11f), fontWeight = FontWeight.Bold)
          Text(t.give.ifEmpty { "NOTHING" }, color = Good, fontSize = tp(s, 17f), fontFamily = GameFont, textAlign = TextAlign.Center, maxLines = 2)
        }
      }
      if (t.pacts.isNotEmpty()) Text(t.pacts.joinToString(" · "), color = Ink, fontSize = tp(s, 12f), textAlign = TextAlign.Center, modifier = Modifier.padding(top = 4.dp))
      t.note?.let { Text("“$it”", color = Sub, fontSize = tp(s, 12f), maxLines = 2, overflow = TextOverflow.Ellipsis, textAlign = TextAlign.Center, modifier = Modifier.padding(top = 2.dp)) }
      OrderStatus(ui)
      Row(Modifier.fillMaxWidth().padding(top = u(s, 6f)), horizontalArrangement = Arrangement.spacedBy(u(s, 10f))) {
        HoldButton("ACCEPT", Good, Modifier.weight(1.3f), filled = true, height = u(s, 48f), enabled = allowed) {
          vm.order(Orders.order("trade_accept") { put("trade_id", t.id) }, "Accepted")
        }
        TapButton("DECLINE", Alarm, Modifier.weight(1f), height = u(s, 48f)) {
          if (allowed) vm.order(Orders.order("trade_decline") { put("trade_id", t.id) }, "Declined")
        }
      }
    }
  }
}

/** PEACE OFFERED: both sides must agree, and they have. */
@Composable
private fun PeaceCard(d: Decision.Peace, top: String, ui: WearViewModel.UiState, vm: WearViewModel, nav: Nav) {
  val cmd = ui.command ?: return
  val w = d.war
  val ink = factionColor(cmd.color(w.with))
  Card(top, d.tier) { s ->
    Column(Modifier.fillMaxSize().padding(horizontal = u(s, 60f)), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
      FlagArt(ui.worlds?.emblemOf(w.with), ink, u(s, 56f))
      Text(cmd.name(w.with).uppercase(), color = ink, fontSize = tp(s, 18f), fontFamily = GameFont, textAlign = TextAlign.Center, maxLines = 2)
      Text("OFFERS A CEASEFIRE", color = Ink, fontSize = tp(s, 14f), fontWeight = FontWeight.Bold)
      Text("At war since tick ${w.since}", color = Sub, fontSize = tp(s, 12f))
      OrderStatus(ui)
      Row(Modifier.fillMaxWidth().padding(top = u(s, 10f)), horizontalArrangement = Arrangement.spacedBy(u(s, 10f))) {
        HoldButton("MAKE PEACE", Good, Modifier.weight(1.4f), filled = true, height = u(s, 48f), enabled = cmd.orders && !ui.ordering) {
          vm.order(Orders.order("ceasefire") { put("faction_id", w.with) }, "Peace made")
        }
        TapButton("LATER", Sub, Modifier.weight(1f), height = u(s, 48f)) { nav.go(Dest.COMMS) }
      }
    }
  }
}

/** SCIENCE WITH NOTHING TO BUY. */
@Composable
private fun ResearchCard(top: String, ui: WearViewModel.UiState, nav: Nav) {
  val rate = ui.state.perTick.science
  Card(top, 1) { s ->
    Column(Modifier.fillMaxSize().padding(horizontal = u(s, 60f)), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
      Canvas(Modifier.size(u(s, 96f))) {
        val w = size.minDimension * 0.08f
        drawCircle(ScienceInk.copy(alpha = 0.18f), radius = size.minDimension / 2f - w, style = androidx.compose.ui.graphics.drawscope.Stroke(w))
        drawCircle(ScienceInk.copy(alpha = 0.5f), radius = size.minDimension * 0.08f)
      }
      Text("NO RESEARCH", color = ScienceInk, fontSize = tp(s, 20f), fontFamily = GameFont, modifier = Modifier.padding(top = u(s, 8f)))
      Text(
        if (rate != null && rate > 0) "+${rate.toInt()} science a tick, going nowhere" else "Science is piling up unspent",
        color = Sub, fontSize = tp(s, 13f), textAlign = TextAlign.Center,
      )
      TapButton("CHOOSE RESEARCH", ScienceInk, Modifier.padding(top = u(s, 12f)), height = u(s, 48f), outline = true) { nav.research() }
    }
  }
}

/**
 * AN IDLE YARD: the world, and the hulls it could lay down, as the game
 * draws them. Tap a hull, hold BUILD. The price is the hull at your
 * multiplier; the game adds the active design's parts and says so if you
 * cannot pay.
 */
@Composable
private fun YardCard(d: Decision.IdleYard, top: String, ui: WearViewModel.UiState, vm: WearViewModel) {
  val cmd = ui.command ?: return
  val y = d.yard
  val place = placeOf(ui.worlds, y.body)
  Card(top, d.tier) { s ->
    Box(Modifier.offset(u(s, 300f), u(s, -10f))) { PlanetArt(place?.sp, u(s, 170f), alpha = 0.85f) }
    YardPicker(ui, vm, cmd, y, s, Modifier.padding(top = u(s, 62f)))
  }
}

/** The hull grid and BUILD, shared with the map's BUILD HERE. */
@Composable
internal fun YardPicker(ui: WearViewModel.UiState, vm: WearViewModel, cmd: Command, y: Yard, s: Dp, modifier: Modifier = Modifier, onDone: () -> Unit = {}) {
  val order = listOf("corvette", "frigate", "destroyer", "freighter", "colony")
  val hulls = order.filter { cmd.prices.containsKey(it) } + cmd.prices.keys.filter { it !in order }
  var pick by remember(y.body) { mutableStateOf(hulls.firstOrNull()) }
  Column(modifier.fillMaxWidth().padding(horizontal = u(s, 50f)), horizontalAlignment = Alignment.CenterHorizontally) {
    Text(y.name.uppercase(), color = Ink, fontSize = tp(s, 22f), fontFamily = GameFont)
    Text(
      "Yard ${y.level} · " + if (y.queue.isEmpty()) "nothing being built" else "${y.queue.size} in the queue",
      color = Sub, fontSize = tp(s, 13f),
    )
    for (row in hulls.chunked(3)) {
      Row(Modifier.fillMaxWidth().padding(top = u(s, 5f)), horizontalArrangement = Arrangement.spacedBy(u(s, 6f), Alignment.CenterHorizontally)) {
        for (cls in row) {
          val p = cmd.prices[cls] ?: continue
          val on = pick == cls
          val afford = ui.state.metal >= p.metal && ui.state.credits >= p.credits
          Column(
            Modifier
              .width(u(s, 100f))
              .clip(RoundedCornerShape(u(s, 14f)))
              .background(if (on) Color(0xFF0F2A22) else Color(0xE6111821))
              .border(1.5.dp, if (on) Good else Color(0xFF1B2430), RoundedCornerShape(u(s, 14f)))
              .clickable { pick = cls }
              .padding(vertical = u(s, 4f)),
            horizontalAlignment = Alignment.CenterHorizontally,
          ) {
            HullArt(classKey(cls), u(s, 34f))
            Text(cls.uppercase(), color = if (on) Good else Ink, fontSize = tp(s, 10f), fontWeight = FontWeight.Bold, maxLines = 1)
            Text("${compact(p.metal.toLong())}M·${compact(p.credits.toLong())}C", color = if (afford) Sub else Alarm, fontSize = tp(s, 9f), maxLines = 1)
          }
        }
      }
    }
    OrderStatus(ui)
    val cls = pick
    HoldButton(
      if (cls == null) "BUILD" else "BUILD ${cls.uppercase()}", Good, Modifier.padding(top = u(s, 4f)).width(u(s, 250f)),
      filled = true, height = u(s, 46f), enabled = cls != null && cmd.orders && !ui.ordering,
    ) {
      if (cls != null) {
        vm.order(Orders.order("build") { put("body_id", y.body); put("ship_class", cls) }, "${cls.uppercase()} ordered at ${y.name.uppercase()}")
        onDone()
      }
    }
  }
}

/** A FLEET WAITING: its captain, where it is, and SEND. */
@Composable
private fun IdleCard(d: Decision.Idle, top: String, ui: WearViewModel.UiState, nav: Nav) {
  val g = d.group
  val place = placeOf(ui.worlds, g.at)
  Card(top, d.tier) { s ->
    Column(Modifier.fillMaxSize().padding(horizontal = u(s, 60f)), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
      CaptainBadge(g.captain, g.hullKey, u(s, 92f), ring = Teal)
      Text(g.title, color = Ink, fontSize = tp(s, 18f), fontFamily = GameFont, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = u(s, 8f)))
      g.captain?.let { Text("Captain ${it.name}", color = Sub, fontSize = tp(s, 12f), maxLines = 1) }
      Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(top = 2.dp)) {
        PlanetArt(place?.sp, u(s, 20f))
        Text(
          " " + if (d.arrived) "ARRIVED AT ${(place?.name ?: "?").uppercase()}" else "IDLE AT ${(place?.name ?: "?").uppercase()} · ${d.idleTicks}T",
          color = if (d.arrived) Teal else Warn, fontSize = tp(s, 12f), fontWeight = FontWeight.Bold, maxLines = 1,
        )
      }
      Row(Modifier.fillMaxWidth().padding(top = u(s, 12f)), horizontalArrangement = Arrangement.spacedBy(u(s, 10f))) {
        TapButton("SEND TO…", Teal, Modifier.weight(1.2f), height = u(s, 48f), outline = true) { nav.send(g) }
        TapButton("ORDERS", Sub, Modifier.weight(1f), height = u(s, 48f)) { nav.orders(g.lead.id) }
      }
    }
  }
}
