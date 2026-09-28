package com.orbitalempire.wear

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.wear.compose.foundation.lazy.ScalingLazyColumn
import androidx.wear.compose.foundation.lazy.items
import androidx.wear.compose.foundation.lazy.rememberScalingLazyListState
import androidx.wear.compose.material.Text

/**
 * FLEETS: every fleet you have, in the three states that decide what you
 * do with it -- FIGHTING (red), MOVING, and IDLE, which needs orders. Each
 * row is its captain's face with the flagship's hull as a badge (or the
 * hull alone, where there is no captain), where it is with that world's
 * sprite, and its health as a bar in the game's own ramp. A tap opens its
 * orders.
 */
@Composable
fun FleetsScreen(ui: WearViewModel.UiState, nav: Nav) {
  val cmd = ui.command
  val groups = remember(cmd) { cmd?.let { groupsOf(it) } ?: emptyList() }
  val fightingAt = remember(ui.state) { ui.state.battles.mapNotNull { it.bodyId }.toSet() }
  val fighting = groups.filter { !it.moving && it.at in fightingAt }
  // THE ROUTE HULLS ARE BUSY. Six of one real empire's sixteen hulls were
  // freighters (and a guard) on standing trade routes, listed as loose
  // ships -- "IDLE · NEEDS ORDERS", "DEPARTS" -- and burying the fleets
  // that actually wanted a decision. They get a section of their own, last.
  val onRoute = groups.filter { it.route != null && it !in fighting }.sortedBy { it.route }
  val moving = groups.filter { it.route == null && (it.moving || it.pending) && it !in fighting }.sortedBy { it.eta ?: 99 }
  val idle = groups.filter { it.route == null && it !in fighting && it !in moving }.sortedByDescending { it.size }
  val hulls = groups.sumOf { it.size }
  Frame(top = if (cmd == null) "FLEETS" else "FLEETS · $hulls SHIP${if (hulls == 1) "" else "S"}") { s ->
    ScalingLazyColumn(
      state = rememberScalingLazyListState(),
      modifier = Modifier.fillMaxSize(),
      contentPadding = PaddingValues(start = u(s, 44f), end = u(s, 44f), top = u(s, 56f), bottom = u(s, 70f)),
      verticalArrangement = Arrangement.spacedBy(u(s, 5f)),
    ) {
      item {
        // SPEAK AN ORDER: "send Vanguard to Oberon", heard, matched to your
        // own fleets and worlds, shown back, held to send.
        TapButton("SPEAK AN ORDER", Teal, height = u(s, 38f), outline = true) { nav.voice() }
      }
      if (cmd == null) {
        item { None("LOADING…") }
        return@ScalingLazyColumn
      }
      if (groups.isEmpty()) {
        item { None("No ships. Build one from a yard.") }
      }
      section("FIGHTING", Color(0xFFFF8A82), fighting, s, ui, nav) { "UNDER FIRE" to Color(0xFFFF8A82) }
      // Idle first: those are the ones asking for an order.
      section("IDLE · NEEDS ORDERS", Warn, idle, s, ui, nav) { "IDLE" to Warn }
      section("MOVING", Sub, moving, s, ui, nav) { g ->
        (if (g.moving) g.eta?.let { "IN ${it}T" } ?: "UNDER WAY" else "LEAVING") to Sub
      }
      section("ON TRADE ROUTES", Teal, onRoute, s, ui, nav) { g ->
        (if (g.moving) g.eta?.let { "IN ${it}T" } ?: "UNDER WAY" else "IN PORT") to Teal
      }
      item {
        Text(
          "Captain portraits from Naev, CC-BY-SA 3.0",
          color = Label, fontSize = tp(s, 10f), textAlign = TextAlign.Center,
          modifier = Modifier.fillMaxWidth().padding(top = u(s, 8f)),
        )
      }
    }
  }
}

private fun androidx.wear.compose.foundation.lazy.ScalingLazyListScope.section(
  label: String,
  ink: Color,
  rows: List<FleetGroup>,
  s: Dp,
  ui: WearViewModel.UiState,
  nav: Nav,
  status: (FleetGroup) -> Pair<String, Color>,
) {
  if (rows.isEmpty()) return
  item {
    Text(label, color = ink, fontSize = tp(s, 11f), fontWeight = FontWeight.Bold, modifier = Modifier.fillMaxWidth().padding(start = 8.dp, top = u(s, 4f)))
  }
  items(rows) { g -> FleetRow(g, s, ui, nav, status(g)) }
}

@Composable
private fun FleetRow(g: FleetGroup, s: Dp, ui: WearViewModel.UiState, nav: Nav, status: Pair<String, Color>) {
  val there = if (g.moving) placeOf(ui.worlds, g.dest) else placeOf(ui.worlds, g.at)
  val edge = when (status.second) {
    Warn -> Color(0xFF3A2F10)
    Sub -> Color(0xFF1B2430)
    Teal -> Color(0xFF123A38)
    else -> Color(0xFF4A1E1B)
  }
  Row(
    Modifier
      .fillMaxWidth()
      .clip(RoundedCornerShape(u(s, 26f)))
      .background(Color(0xE0111821))
      .border(1.dp, edge, RoundedCornerShape(u(s, 26f)))
      .clickable { nav.orders(g.lead.id) }
      .padding(start = u(s, 6f), end = u(s, 12f), top = u(s, 5f), bottom = u(s, 5f)),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    CaptainBadge(g.captain, g.hullKey, u(s, 42f), ring = Color(0xFF2A3644))
    Column(Modifier.weight(1f).padding(start = u(s, 10f))) {
      Text(g.title, color = Ink, fontSize = tp(s, 14f), fontWeight = FontWeight.Bold, maxLines = 1, overflow = TextOverflow.Ellipsis)
      Row(verticalAlignment = Alignment.CenterVertically) {
        PlanetArt(there?.sp, u(s, 15f))
        Text(
          " " + (if (g.moving) "→ " else "") + (there?.name ?: "In transit") + (g.route?.let { " · $it" } ?: ""),
          color = Sub, fontSize = tp(s, 11f), maxLines = 1, overflow = TextOverflow.Ellipsis,
        )
      }
    }
    Column(horizontalAlignment = Alignment.End) {
      Text(status.first, color = status.second, fontSize = tp(s, 11f), fontWeight = FontWeight.Bold, maxLines = 1)
      Box(Modifier.padding(top = 3.dp).width(u(s, 52f)).height(u(s, 5f)).clip(RoundedCornerShape(3.dp)).background(Color(0xFF1E2631))) {
        Box(Modifier.fillMaxWidth((g.hp / 100f).coerceIn(0.03f, 1f)).fillMaxHeight().background(healthColor(g.hp.toDouble())))
      }
    }
  }
}
