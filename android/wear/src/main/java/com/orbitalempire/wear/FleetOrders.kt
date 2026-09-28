package com.orbitalempire.wear

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.focusable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.rotary.onRotaryScrollEvent
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.wear.compose.foundation.lazy.ScalingLazyColumn
import androidx.wear.compose.foundation.lazy.rememberScalingLazyListState
import androidx.wear.compose.material.Text
import kotlinx.coroutines.delay
import org.json.JSONObject
import kotlin.math.abs

/**
 * A FLEET'S ORDERS, on one screen.
 *
 * A FLEET TAKES ONE ORDER. The game applies an order given to any member
 * to every member (handleSetShipOrders), detonation included, so every
 * order here names the whole fleet.
 *
 *   the face     its captain, the flagship's hull as a badge
 *   stance       ATTACK / DEFENSIVE / HOLD, a tap each
 *   the rim      the auto-retreat threshold, as an arc up the right-hand
 *                edge; the bezel sets it five points a click, a detent
 *                each, so it can be set without looking
 *   SEND TO…     where it goes, nearest first
 *   RETREAT      held: out of the fight now
 *   TARGETS ›    who it shoots first
 *   DETONATE ›   the Detonator, where it carries one
 */
@Composable
fun FleetOrdersScreen(ui: WearViewModel.UiState, vm: WearViewModel, shipId: String, nav: Nav, onClose: () -> Unit) {
  var panel by remember { mutableStateOf<String?>(null) }
  BackHandler { if (panel != null) panel = null else onClose() }
  val cmd = ui.command
  val g = cmd?.let { groupOf(it, shipId) }
  Box(Modifier.fillMaxSize()) {
    StarfieldBackground(dim = 0.2f)
    if (cmd == null || g == null) {
      Text(if (cmd == null) "LOADING ORDERS…" else "SHIP NOT FOUND", color = Dim, fontSize = 11.sp, modifier = Modifier.align(Alignment.Center))
      return@Box
    }
    when (panel) {
      "targets" -> TargetsPanel(ui, vm, g)
      "detonate" -> DetonatePanel(ui, vm, g)
      else -> OrdersFace(ui, vm, g, nav, onPanel = { panel = it })
    }
  }
}

@Composable
private fun OrdersFace(ui: WearViewModel.UiState, vm: WearViewModel, g: FleetGroup, nav: Nav, onPanel: (String) -> Unit) {
  val cmd = ui.command ?: return
  val ctx = LocalContext.current
  val allowed = cmd.orders && !ui.ordering
  val lead = g.lead
  val where = if (g.moving) "→ ${(placeOf(ui.worlds, g.dest)?.name ?: "?").uppercase()}" else "AT ${(placeOf(ui.worlds, g.at)?.name ?: "?").uppercase()}"
  val patch = { build: JSONObject.() -> Unit, done: String ->
    vm.order(Orders.order("orders") { put("ship_ids", Orders.ids(g.ids)); build() }, done)
  }
  // THE THRESHOLD, set on the bezel and sent once the bezel stops: a
  // click at a time would be an order per click.
  val server = lead.retreatPct ?: 0
  var dial by remember(lead.id, server) { mutableStateOf(server) }
  var touched by remember(lead.id) { mutableStateOf(false) }
  LaunchedEffect(dial, touched) {
    if (!touched || dial == server) return@LaunchedEffect
    delay(1_100)
    patch({ put("retreat_hp_pct", if (dial <= 0) JSONObject.NULL else dial) }, if (dial <= 0) "Auto-retreat off" else "Retreats at $dial%")
    touched = false
  }
  val focus = remember { FocusRequester() }
  LaunchedEffect(Unit) { try { focus.requestFocus() } catch (_: Throwable) { } }
  var acc by remember { mutableFloatStateOf(0f) }
  val armed = g.ships.mapNotNull { it.armedTick }.minOrNull()
  val anyDetonator = g.ships.any { it.detonator }
  // RETREAT MEANS "OUT OF THIS FIGHT", so it is offered in a fight and
  // nowhere else: on a hull parked at home or already under way it read as
  // a button with no clear meaning (the review, on real fleets).
  val fighting = !g.moving && g.at != null && ui.state.battles.any { it.bodyId == g.at }

  Frame(
    top = "${g.title} · $where",
    rim = {
      // Bottom of the arc is 0 (off), the top 90%.
      rimSlider(35f, -35f, dial / 90f, Warn, size.minDimension * 0.022f, size.minDimension * 0.012f)
    },
  ) { s ->
    Column(
      Modifier
        .fillMaxSize()
        .onRotaryScrollEvent { e ->
          if (!allowed) return@onRotaryScrollEvent true
          acc += e.verticalScrollPixels
          if (abs(acc) >= ROTARY_STEP_PX) {
            val next = (dial + if (acc > 0) 5 else -5).coerceIn(0, 90)
            if (next != dial) {
              dial = next
              touched = true
              Haptics.detent(ctx)
            }
            acc = 0f
          }
          true
        }
        .focusRequester(focus)
        .focusable()
        .padding(top = u(s, 70f), bottom = u(s, 40f)),
      horizontalAlignment = Alignment.CenterHorizontally,
      // Centred in the face: it sat against the top with the bottom third
      // of the screen empty.
      verticalArrangement = Arrangement.Center,
    ) {
      // STANCE
      Row(horizontalArrangement = Arrangement.spacedBy(u(s, 5f))) {
        for ((label, v) in listOf("ATTACK" to "attack", "DEFENSIVE" to "defensive", "HOLD" to "hold")) {
          val on = lead.stance == v
          Box(
            Modifier
              .height(u(s, 34f))
              .clip(RoundedCornerShape(u(s, 17f)))
              .background(if (on) Teal else Color(0xFF111821))
              .border(1.dp, if (on) Teal else Color(0xFF2A3644), RoundedCornerShape(u(s, 17f)))
              .clickable(enabled = allowed && !on) { patch({ put("stance", v) }, "Stance: ${label.lowercase()}") }
              .padding(horizontal = u(s, 11f)),
            contentAlignment = Alignment.Center,
          ) {
            Text(label, color = if (on) Color(0xFF042624) else Sub, fontSize = tp(s, 12f), fontWeight = FontWeight.Bold)
          }
        }
      }
      Box(Modifier.padding(top = u(s, 8f))) { CaptainBadge(g.captain, g.hullKey, u(s, 78f), ring = Teal) }
      Text(
        "FLAGSHIP ${lead.cls.replace('_', ' ').uppercase()}" + if (g.size > 1) " · ${g.size - 1} ESCORT${if (g.size == 2) "" else "S"}" else "",
        color = Sub, fontSize = tp(s, 11f), fontWeight = FontWeight.Bold, maxLines = 1,
      )
      g.route?.let { route ->
        // A route hull: sending it anywhere else is a real decision.
        Text("ON ROUTE · ${route.uppercase()}", color = Teal, fontSize = tp(s, 11f), fontWeight = FontWeight.Bold, maxLines = 1)
      }
      if (armed != null) {
        Text("DETONATES AT TICK $armed", color = Alarm, fontSize = tp(s, 14f), fontWeight = FontWeight.Bold, modifier = Modifier.padding(top = u(s, 4f)))
      } else {
        Text(
          if (dial <= 0) "AUTO-RETREAT OFF" else "AUTO-RETREAT AT $dial%",
          color = Warn, fontSize = tp(s, 13f), fontWeight = FontWeight.Bold, modifier = Modifier.padding(top = u(s, 4f)),
        )
        Text("turn the bezel to set · hulls now ${g.hp}%", color = Sub, fontSize = tp(s, 10f))
      }
      if (!cmd.orders) {
        Text("Getting this watch ready to give orders…", color = Dim, fontSize = tp(s, 11f), textAlign = TextAlign.Center)
      }
      OrderStatus(ui)
      Row(Modifier.width(u(s, if (fighting) 330f else 250f)).padding(top = u(s, 6f)), horizontalArrangement = Arrangement.spacedBy(u(s, 8f))) {
        if (armed != null) {
          TapButton("CANCEL BLAST", Good, Modifier.weight(1f), height = u(s, 48f), outline = true) {
            vm.order(Orders.order("cancel_detonate") { put("ship_ids", Orders.ids(g.ids)) }, "Detonation cancelled")
          }
        } else {
          // Under way, a new destination REPLACES the course in flight.
          TapButton(if (g.moving) "REDIRECT…" else "SEND TO…", Teal, Modifier.weight(1f), height = u(s, 48f), outline = true) { nav.send(g) }
        }
        if (fighting) {
          HoldButton("RETREAT", Warn, Modifier.weight(1f), height = u(s, 48f), enabled = allowed) {
            vm.order(Orders.order("retreat") { put("ship_ids", Orders.ids(g.ids)) }, "Retreating")
          }
        }
      }
      Row(Modifier.padding(top = u(s, 8f)), horizontalArrangement = Arrangement.spacedBy(u(s, 22f))) {
        Text("TARGETS ›", color = Sub, fontSize = tp(s, 13f), fontWeight = FontWeight.Bold, modifier = Modifier.clickable { onPanel("targets") })
        if (anyDetonator && armed == null) {
          Text("DETONATE ›", color = Color(0xFFFF8A82), fontSize = tp(s, 13f), fontWeight = FontWeight.Bold, modifier = Modifier.clickable { onPanel("detonate") })
        }
      }
    }
  }
}

@Composable
private fun TargetsPanel(ui: WearViewModel.UiState, vm: WearViewModel, g: FleetGroup) {
  val allowed = ui.command?.orders == true && !ui.ordering
  Frame(top = "${g.title} · TARGETS") { s ->
    Column(Modifier.fillMaxSize().padding(horizontal = u(s, 50f)), verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally) {
      Text("SHOOT FIRST AT", color = Sub, fontSize = tp(s, 12f), fontWeight = FontWeight.Bold)
      for ((label, v, why) in listOf(
        Triple("AUTO", "auto", "The game's pick"),
        Triple("SMALL", "small", "Escorts and corvettes"),
        Triple("BIG", "big", "Capital hulls"),
        Triple("CIVIL", "civilian", "Freighters and colony ships"),
      )) {
        val on = g.lead.priority == v
        Row(
          Modifier
            .fillMaxWidth()
            .padding(top = u(s, 5f))
            .clip(RoundedCornerShape(u(s, 18f)))
            .background(if (on) Teal.copy(alpha = 0.18f) else Color(0xE0111821))
            .border(1.dp, if (on) Teal else Color(0xFF1B2430), RoundedCornerShape(u(s, 18f)))
            .clickable(enabled = allowed && !on) {
              vm.order(Orders.order("orders") { put("ship_ids", Orders.ids(g.ids)); put("priority", v) }, "Targets: ${label.lowercase()}")
            }
            .padding(horizontal = u(s, 14f), vertical = u(s, 6f)),
          verticalAlignment = Alignment.CenterVertically,
        ) {
          Text(label, color = if (on) Teal else Ink, fontSize = tp(s, 13f), fontWeight = FontWeight.Bold, modifier = Modifier.width(u(s, 70f)))
          Text(why, color = Sub, fontSize = tp(s, 11f), maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
      }
      OrderStatus(ui)
    }
  }
}

@Composable
private fun DetonatePanel(ui: WearViewModel.UiState, vm: WearViewModel, g: FleetGroup) {
  val allowed = ui.command?.orders == true && !ui.ordering
  Frame(top = "${g.title} · DETONATOR", topInk = Color(0xFFFF8A82)) { s ->
    ScalingLazyColumn(
      state = rememberScalingLazyListState(),
      modifier = Modifier.fillMaxSize(),
      contentPadding = PaddingValues(horizontal = u(s, 44f), vertical = u(s, 56f)),
    ) {
      item {
        Text(
          "Armed for the next tick, and cancellable until it lands. Every ship in the fleet that carries a Detonator goes.",
          color = Sub, fontSize = tp(s, 12f), textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth(),
        )
      }
      item { OrderStatus(ui) }
      item {
        HoldButton("DETONATE ${if (g.size > 1) "FLEET" else "SHIP"}", Alarm, Modifier.padding(top = 4.dp), filled = true, height = u(s, 48f), holdMs = 1400, enabled = allowed) {
          vm.order(Orders.order("detonate") { put("ship_ids", Orders.ids(g.ids)) }, "Armed: detonates next tick")
        }
      }
      item {
        Column {
          ChoiceRow(
            "AUTO-DETONATE AT HULL",
            listOf("OFF" to null, "25%" to 25, "50%" to 50),
            g.lead.detonatePct, allowed,
          ) { v ->
            vm.order(Orders.order("orders") { put("ship_ids", Orders.ids(g.ids)); put("detonate_hp_pct", v ?: JSONObject.NULL) }, "Auto-detonate set")
          }
        }
      }
    }
  }
}

