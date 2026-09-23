package com.orbitalempire.wear

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.wear.compose.foundation.lazy.ScalingLazyColumn
import androidx.wear.compose.foundation.lazy.rememberScalingLazyListState
import androidx.wear.compose.material.Text

/**
 * TERRITORY: the game's own chart, on the wrist.
 *
 * The bar is the FACTION panel's bar -- every empire's share of the map
 * in its own colour, the unclaimed remainder in grey, and a mark at the
 * smallest number of worlds that wins. Underneath, the standings: worlds
 * held, systems, senate weight, fleet.
 *
 * WHAT A LOCK MEANS. Worlds and systems are public in this game (the map
 * paints borders for everyone, and domination is a win condition -- a
 * hidden race is an unreadable one). A rival's FLEET needs Fleet Census
 * (Sensors 3) and its STOCKPILES need Economic Intel (Sensors 4). The
 * server sends null for what you have not researched, and a null draws
 * as a lock, never as a zero: a zero would be a claim about a rival, and
 * this is the absence of one.
 */
@Composable
fun TerritoryScreen(board: Board?) {
  if (board == null || !board.hasBar) {
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
      Text(if (board == null) "SCANNING…" else "NO TERRITORY", color = Dim, fontSize = 12.sp)
    }
    return
  }
  ScalingLazyColumn(
    state = rememberScalingLazyListState(),
    modifier = Modifier.fillMaxSize(),
    contentPadding = PaddingValues(horizontal = 12.dp, vertical = 26.dp),
  ) {
    item { Text("TERRITORY", color = Ink, fontSize = 12.sp, textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth()) }
    item {
      Text(
        "${board.total} WORLDS · ${board.systemsTotal} SYSTEMS",
        color = Dim, fontSize = 8.sp, textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth(),
      )
    }
    item { TerritoryBar(board, Modifier.padding(top = 5.dp)) }
    item {
      Row(Modifier.fillMaxWidth().padding(top = 3.dp)) {
        Text("${board.claimed}/${board.total} HELD", color = Dim, fontSize = 8.sp, modifier = Modifier.weight(1f))
        Text("${board.need} WINS", color = Warn, fontSize = 8.sp)
      }
    }
    item { Section("STANDINGS") }
    for (f in board.factions) {
      item { StandingRow(f, board) }
    }
    item {
      Text(
        "★ = senate weight. A lock is intel you have not researched.",
        color = Dim, fontSize = 7.sp, textAlign = TextAlign.Center,
        modifier = Modifier.fillMaxWidth().padding(top = 6.dp),
      )
    }
  }
}

/** Every empire's share of the map, and the mark that ends the game. */
@Composable
private fun TerritoryBar(board: Board, modifier: Modifier = Modifier) {
  val held = board.factions.filter { it.worlds > 0 }
  Canvas(modifier.fillMaxWidth().height(16.dp).clip(RoundedCornerShape(8.dp))) {
    val w = size.width
    val h = size.height
    var x = 0f
    for (f in held) {
      val seg = w * f.worlds / board.total.toFloat()
      drawRect(factionColor(f.color), topLeft = Offset(x, 0f), size = Size(seg, h))
      x += seg
    }
    // The unclaimed remainder: the same trough the tiles use.
    if (x < w) drawRect(Trough, topLeft = Offset(x, 0f), size = Size(w - x, h))
    // The domination mark. Drawn last so no segment covers it.
    if (board.need in 1..board.total) {
      val tick = w * board.need / board.total.toFloat()
      drawRect(Warn, topLeft = Offset(tick - 0.75f, -2f), size = Size(1.5f * 2, h + 4f))
    }
  }
}

/** One empire: who, how much, and what you are allowed to know. */
@Composable
private fun StandingRow(f: Standing, board: Board) {
  val tint = factionColor(f.color)
  Column(Modifier.fillMaxWidth().padding(vertical = 3.dp)) {
    Row(verticalAlignment = Alignment.CenterVertically) {
      Box(
        Modifier
          .size(8.dp)
          .clip(RoundedCornerShape(2.dp))
          .background(if (f.out) darken(tint, 0.55f) else tint),
      )
      Text(
        "  " + f.name.uppercase(),
        color = if (f.out) Dim else Ink,
        fontSize = 10.sp,
        maxLines = 1,
        modifier = Modifier.weight(1f),
      )
      Text(
        when {
          f.out -> "OUT"
          f.mine -> "YOU"
          else -> "${f.worlds}"
        },
        color = if (f.out) Dim else if (f.mine) tint else Ink,
        fontSize = 10.sp,
      )
    }
    Row(Modifier.fillMaxWidth().padding(start = 8.dp)) {
      Text(
        "${f.worlds}W · ${f.systems}/${board.systemsTotal}S · ★${f.weight}",
        color = Dim, fontSize = 8.sp, modifier = Modifier.weight(1f),
      )
      Text(
        if (f.ships == null) "FLEET 🔒" else "FLEET ${f.ships}",
        color = if (f.ships == null) Dim else Ink, fontSize = 8.sp,
      )
    }
    if (f.metal != null) {
      Text(
        "${compact(f.metal)}M · ${compact(f.credits ?: 0)}C · ${compact(f.science ?: 0)}S",
        color = Dim, fontSize = 8.sp, modifier = Modifier.padding(start = 8.dp),
      )
    }
  }
}
