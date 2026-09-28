package com.orbitalempire.wear

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.wear.compose.foundation.lazy.ScalingLazyColumn
import androidx.wear.compose.foundation.lazy.items
import androidx.wear.compose.foundation.lazy.rememberScalingLazyListState
import androidx.wear.compose.material.Text
import kotlin.math.abs
import kotlin.math.ceil
import kotlin.math.cos
import kotlin.math.roundToLong
import kotlin.math.sin

/**
 * REALM: the empire over time, and the doors to its institutions.
 *
 *   the rim      THE RACE: every empire's share of the worlds, in its
 *                colour, round the bezel, with a mark where domination wins
 *   resources    each pool with its last ten readings and its rate
 *   research     the project as a ring; tap to choose research
 *   the doors    SENATE, DIPLOMACY, YARDS, TERRITORY, each with its count
 */
@Composable
fun RealmScreen(ui: WearViewModel.UiState, nav: Nav) {
  val st = ui.state
  val cmd = ui.command
  val board = ui.board
  Frame(
    top = "REALM · LAST 10 TICKS",
    rim = { raceRing(board, st) },
  ) { s ->
    ScalingLazyColumn(
      state = rememberScalingLazyListState(),
      modifier = Modifier.fillMaxSize(),
      contentPadding = PaddingValues(start = u(s, 58f), end = u(s, 58f), top = u(s, 58f), bottom = u(s, 60f)),
      verticalArrangement = Arrangement.spacedBy(u(s, 6f)),
    ) {
      item { ResRow("METAL", st.metal, st.perTick.metal, st.perTick.netMetal, st.perTick.metalHistory, MetalInk, st.isLive, s) }
      item { ResRow("CREDITS", st.credits, st.perTick.credits, st.perTick.netCredits, st.perTick.creditsHistory, CreditInk, st.isLive, s) }
      item { ResRow("SCIENCE", st.science, st.perTick.science, null, st.perTick.scienceHistory, ScienceInk, st.isLive, s) }
      item { ResearchCard(st, s) { nav.research() } }
      item {
        Column(verticalArrangement = Arrangement.spacedBy(u(s, 6f))) {
          Row(horizontalArrangement = Arrangement.spacedBy(u(s, 6f))) {
            val open = st.senate.count { !it.debating && it.myVote == null }
            Door("SENATE", if (st.senate.isEmpty()) null else "$open", if (open > 0) Warn else Dim, s, Modifier.weight(1f)) { nav.go(Dest.SENATE) }
            val talk = (cmd?.offers?.size ?: 0) + (cmd?.inbox?.count { !it.read } ?: 0)
            Door("DIPLOMACY", if (talk > 0) "$talk" else null, Warn, s, Modifier.weight(1f)) { nav.go(Dest.COMMS) }
          }
          Row(horizontalArrangement = Arrangement.spacedBy(u(s, 6f))) {
            val idle = cmd?.yards?.count { it.queue.isEmpty() } ?: 0
            Door("YARDS", if (idle > 0) "$idle idle" else cmd?.yards?.size?.takeIf { it > 0 }?.toString(), if (idle > 0) Dim else Dim, s, Modifier.weight(1f)) { nav.go(Dest.YARDS) }
            val d = st.domination
            Door("TERRITORY", d?.let { "${it.owned}/${it.total}" }, Teal, s, Modifier.weight(1f)) { nav.go(Dest.TERRITORY) }
          }
        }
      }
      item { AlertsOffRow() }
      item {
        Text(
          "Captain portraits: Naev (naev.org), CC-BY-SA 3.0",
          color = Label, fontSize = tp(s, 10f), textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth().padding(top = u(s, 6f)),
        )
      }
    }
  }
}

/**
 * THE RACE, round the rim: each empire's worlds as an arc in its colour,
 * yours first from twelve o'clock, the unclaimed rest as trough, and a
 * white mark at the share that wins. Without the board yet, your own
 * share alone.
 */
private fun DrawScope.raceRing(board: Board?, st: WearState) {
  val w = size.minDimension * Rim.RING
  val r = size.minDimension / 2f - w / 2f
  val tl = Offset(center.x - r, center.y - r)
  val sz = Size(r * 2, r * 2)
  drawArc(Trough, 0f, 360f, false, tl, sz, style = Stroke(w))
  val total = (board?.total?.takeIf { it > 0 } ?: st.domination?.total ?: 0).coerceAtLeast(1)
  var at = -90f
  val rows = board?.factions?.filter { !it.out }?.sortedByDescending { it.mine } ?: emptyList()
  if (rows.isNotEmpty()) {
    for (row in rows) {
      val sweep = 360f * row.worlds / total
      if (sweep <= 0f) continue
      drawArc(factionColor(row.color), at, (sweep - 1.2f).coerceAtLeast(0.5f), false, tl, sz, style = Stroke(w, cap = StrokeCap.Butt))
      at += sweep
    }
  } else {
    val d = st.domination
    if (d != null) drawArc(factionColor(st.color), at, 360f * d.owned / total, false, tl, sz, style = Stroke(w))
  }
  val need = board?.need?.takeIf { it > 0 } ?: st.domination?.need
  if (need != null && need > 0) {
    val a = Math.toRadians((-90.0 + 360.0 * need / total))
    val inner = r - w * 1.4f
    val outer = r + w * 0.6f
    drawLine(
      Ink,
      Offset(center.x + inner * cos(a).toFloat(), center.y + inner * sin(a).toFloat()),
      Offset(center.x + outer * cos(a).toFloat(), center.y + outer * sin(a).toFloat()),
      strokeWidth = w * 0.5f,
    )
  }
}

@Composable
private fun ResRow(label: String, amount: Long, rate: Double?, net: Double?, hist: List<Double>, ink: Color, live: Boolean, s: Dp) {
  // THE NUMBERS TAKE WHAT THEY NEED and the sparkline gets the rest: the
  // design's fixed columns were drawn for design-sized text, and the
  // watch's larger text wrapped "+570/T" onto three lines in them.
  Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
    Column {
      Text(label, color = Sub, fontSize = tp(s, 10f), fontWeight = FontWeight.Bold, maxLines = 1, softWrap = false)
      Text(compact(amount), color = ink, fontSize = tp(s, 20f), fontFamily = GameFont, maxLines = 1, softWrap = false)
    }
    Sparkline(hist, ink, Modifier.weight(1f).height(u(s, 26f)).padding(horizontal = u(s, 8f)))
    Column(horizontalAlignment = Alignment.End) {
      Text(
        if (!live || rate == null) "—" else "${if (rate < 0) "−" else "+"}${compact(abs(rate).roundToLong())}/T",
        color = if (!live || rate == null) Dim else if (rate < 0) Alarm else Good,
        fontSize = tp(s, 13f), fontWeight = FontWeight.Bold, maxLines = 1, softWrap = false,
      )
      // After upkeep, where it differs: earning 40 a tick and still going
      // backwards is the one thing worth catching here.
      if (net != null && rate != null && abs(net - rate) >= 0.5) {
        Text(
          "net ${if (net < 0) "−" else "+"}${compact(abs(net).roundToLong())}",
          color = if (net < 0) Alarm else Sub, fontSize = tp(s, 10f), maxLines = 1, softWrap = false,
        )
      }
    }
  }
}

@Composable
private fun ResearchCard(st: WearState, s: Dp, onTap: () -> Unit) {
  val r = st.research
  Row(
    Modifier
      .fillMaxWidth()
      .clip(RoundedCornerShape(u(s, 16f)))
      .background(Color(0xFF0D1A22))
      .clickable(onClick = onTap)
      .padding(horizontal = u(s, 12f), vertical = u(s, 8f)),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    Box(Modifier.size(u(s, 50f)), contentAlignment = Alignment.Center) {
      Canvas(Modifier.fillMaxSize()) {
        val w = size.minDimension * 0.12f
        val rad = size.minDimension / 2f - w
        val tl = Offset(center.x - rad, center.y - rad)
        val sz = Size(rad * 2, rad * 2)
        drawArc(Trough, 0f, 360f, false, tl, sz, style = Stroke(w))
        if (r != null) drawArc(ScienceInk, -90f, 360f * r.fraction, false, tl, sz, style = Stroke(w, cap = StrokeCap.Round))
      }
      Text(if (r != null) "${(r.fraction * 100).toInt()}%" else "—", color = ScienceInk, fontSize = tp(s, 11f), fontFamily = GameFont)
    }
    Column(Modifier.weight(1f).padding(start = u(s, 12f))) {
      Text("RESEARCHING", color = Dim, fontSize = tp(s, 10f), fontWeight = FontWeight.Bold)
      if (r == null) {
        Text("NOTHING", color = Warn, fontSize = tp(s, 15f), fontFamily = GameFont)
        Text("Tap to choose", color = Sub, fontSize = tp(s, 11f))
      } else {
        Text("${r.name.uppercase()} ${r.level}", color = ScienceInk, fontSize = tp(s, 15f), fontFamily = GameFont, maxLines = 1, overflow = TextOverflow.Ellipsis)
        val rate = st.perTick.science ?: 0.0
        val left = (r.cost - r.progress).coerceAtLeast(0)
        Text(
          if (rate > 0) "${ceil(left / rate).toInt()} ticks to go" else "${r.progress}/${r.cost}",
          color = Sub, fontSize = tp(s, 11f),
        )
      }
    }
    Text("›", color = Label, fontSize = tp(s, 18f))
  }
}

@Composable
private fun Door(label: String, count: String?, ink: Color, s: Dp, modifier: Modifier, onTap: () -> Unit) {
  Row(
    modifier
      .clip(RoundedCornerShape(u(s, 12f)))
      .background(Color(0xFF111821))
      .clickable(onClick = onTap)
      .padding(horizontal = u(s, 10f), vertical = u(s, 8f)),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    Text(label, color = Ink, fontSize = tp(s, 12f), fontWeight = FontWeight.Bold, maxLines = 1)
    if (count != null) Text(" · $count", color = ink, fontSize = tp(s, 12f), fontWeight = FontWeight.Bold, maxLines = 1)
  }
}

/**
 * CHOOSE RESEARCH: every track, the level it would buy next and what it
 * costs, in the game's own words. Hold to start one; the game refuses
 * with its own message if it cannot.
 */
@Composable
fun ResearchPicker(ui: WearViewModel.UiState, vm: WearViewModel, onClose: () -> Unit) {
  BackHandler(onBack = onClose)
  val st = ui.state
  var pick by remember { mutableStateOf<String?>(null) }
  Box(Modifier.fillMaxSize()) {
    StarfieldBackground(dim = 0.25f)
    Frame(top = "CHOOSE RESEARCH", topInk = ScienceInk) { s ->
      ScalingLazyColumn(
        state = rememberScalingLazyListState(),
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(start = u(s, 50f), end = u(s, 50f), top = u(s, 58f), bottom = u(s, 60f)),
        verticalArrangement = Arrangement.spacedBy(u(s, 5f)),
      ) {
        st.research?.let { r ->
          item {
            Text(
              "Now: ${r.name} ${r.level}, ${(r.fraction * 100).toInt()}%. Choosing another switches to it.",
              color = Sub, fontSize = tp(s, 11f), textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth(),
            )
          }
        }
        item { OrderStatus(ui) }
        items(st.researchOptions) { o ->
          val on = pick == o.tech
          val current = st.research?.tech == o.tech
          Column(
            Modifier
              .fillMaxWidth()
              .clip(RoundedCornerShape(u(s, 16f)))
              .background(if (on) Color(0xFF0D2230) else Color(0xE0111821))
              .border(if (on) 2.dp else 1.dp, if (on) ScienceInk else Color(0xFF1B2430), RoundedCornerShape(u(s, 16f)))
              .clickable(enabled = !o.maxed) { pick = o.tech }
              .padding(horizontal = u(s, 12f), vertical = u(s, 7f)),
          ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
              Text(
                if (o.maxed) "${o.name.uppercase()} · MAX" else "${o.name.uppercase()} ${o.level}",
                color = if (o.maxed) Dim else if (current) ScienceInk else Ink,
                fontSize = tp(s, 14f), fontWeight = FontWeight.Bold, modifier = Modifier.weight(1f), maxLines = 1,
              )
              if (!o.maxed) Text("${compact(o.cost.toLong())} SCI", color = ScienceInk, fontSize = tp(s, 11f), fontFamily = GameFont)
            }
            Text(o.tagline, color = Sub, fontSize = tp(s, 11f), maxLines = 2, overflow = TextOverflow.Ellipsis)
            if (on) {
              HoldButton(
                "RESEARCH ${o.name.uppercase()}", ScienceInk, Modifier.padding(top = u(s, 6f)), filled = true, height = u(s, 42f),
                enabled = ui.command?.orders == true && !ui.ordering,
              ) {
                vm.order(Orders.order("research") { put("tech_id", o.tech) }, "Researching ${o.name} ${o.level}")
                onClose()
              }
            }
          }
        }
      }
    }
  }
}
