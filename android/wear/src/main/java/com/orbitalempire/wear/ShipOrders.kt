package com.orbitalempire.wear

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.wear.compose.foundation.lazy.ScalingLazyColumn
import androidx.wear.compose.foundation.lazy.rememberScalingLazyListState
import androidx.wear.compose.material.Text
import org.json.JSONObject

/**
 * Orders for one of your ships -- or its whole fleet.
 *
 * A FLEET TAKES ONE ORDER. The game applies an order given to any fleet
 * member to every member (handleSetShipOrders expands it), detonation
 * included, so the sheet says so in every label -- "DETONATE FLEET (5)"
 * -- rather than letting a tap on one hull surprise the player with five
 * explosions. Retreat and send move the whole fleet together for the
 * same reason: a fleet that stays a fleet.
 *
 * Retreat, detonate and send are HELD (HoldButton); stance, thresholds
 * and targets are taps, because the next tap undoes them. A detonation is
 * armed for the next tick, not fired, and stays CANCELLABLE until then.
 */
@Composable
fun ShipOrdersScreen(
  ui: WearViewModel.UiState,
  vm: WearViewModel,
  shipId: String,
  onSend: (List<String>) -> Unit,
  onClose: () -> Unit,
) {
  BackHandler(onBack = onClose)
  val cmd = ui.command
  val ship = cmd?.ship(shipId)
  Box(Modifier.fillMaxSize().background(Ground)) {
    if (cmd == null || ship == null) {
      Text(
        if (cmd == null) "LOADING ORDERS…" else "SHIP NOT FOUND",
        color = Dim, fontSize = 11.sp, modifier = Modifier.align(Alignment.Center),
      )
      return@Box
    }
    val fleet = cmd.fleetOf(ship)
    val ids = fleet.map { it.id }
    val who = if (fleet.size > 1) "FLEET (${fleet.size})" else "SHIP"
    val allowed = cmd.orders && !ui.ordering
    val patch = { build: JSONObject.() -> Unit, done: String ->
      vm.order(Orders.order("orders") { put("ship_ids", Orders.ids(ids)); build() }, done)
    }
    val armed = fleet.mapNotNull { it.armedTick }.minOrNull()
    val anyDetonator = fleet.any { it.detonator }

    ScalingLazyColumn(
      state = rememberScalingLazyListState(),
      modifier = Modifier.fillMaxSize(),
      contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 14.dp, vertical = 26.dp),
    ) {
      item {
        Text(ship.name.uppercase(), color = Ink, fontSize = 12.sp, textAlign = TextAlign.Center, maxLines = 2, modifier = Modifier.fillMaxWidth())
      }
      item {
        Text(
          (if (fleet.size > 1) "FLEET · ${fleet.size} SHIPS" else ship.cls.uppercase()) + if (ship.moving) " · UNDER WAY" else "",
          color = Dim, fontSize = 8.sp, textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth(),
        )
      }
      item { OrderStatus(ui) }
      if (!cmd.orders) {
        item {
          Text(
            "Getting this watch ready to give orders…",
            color = Dim, fontSize = 9.sp, textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp),
          )
        }
        return@ScalingLazyColumn
      }
      if (armed != null) {
        item {
          Text("DETONATES AT TICK $armed", color = Alarm, fontSize = 10.sp, textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth())
        }
        item {
          TapButton("CANCEL DETONATION", Good) {
            vm.order(Orders.order("cancel_detonate") { put("ship_ids", Orders.ids(ids)) }, "Detonation cancelled")
          }
        }
      }
      item {
        HoldButton("RETREAT $who", Warn, Modifier.padding(top = 4.dp), enabled = allowed) {
          vm.order(Orders.order("retreat") { put("ship_ids", Orders.ids(ids)) }, "Retreating")
        }
      }
      if (anyDetonator && armed == null) {
        item {
          HoldButton("DETONATE $who", Alarm, Modifier.padding(top = 4.dp), enabled = allowed, holdMs = 1400) {
            vm.order(Orders.order("detonate") { put("ship_ids", Orders.ids(ids)) }, "Armed: detonates next tick")
          }
        }
      }
      item {
        TapButton("SEND $who TO…", Ink, Modifier.padding(top = 4.dp)) { onSend(ids) }
      }
      item {
        androidx.compose.foundation.layout.Column {
          ChoiceRow(
            "STANCE",
            listOf("ATTACK" to "attack", "DEFEND" to "defensive", "HOLD" to "hold"),
            ship.stance, allowed,
          ) { v -> patch({ put("stance", v) }, "Stance set") }
        }
      }
      item {
        androidx.compose.foundation.layout.Column {
          ChoiceRow(
            "AUTO-RETREAT AT HULL",
            listOf("OFF" to null, "25%" to 25, "50%" to 50, "75%" to 75),
            ship.retreatPct, allowed,
          ) { v -> patch({ put("retreat_hp_pct", v ?: JSONObject.NULL) }, "Auto-retreat set") }
        }
      }
      if (anyDetonator) {
        item {
          androidx.compose.foundation.layout.Column {
            ChoiceRow(
              "AUTO-DETONATE AT HULL",
              listOf("OFF" to null, "25%" to 25, "50%" to 50),
              ship.detonatePct, allowed,
            ) { v -> patch({ put("detonate_hp_pct", v ?: JSONObject.NULL) }, "Auto-detonate set") }
          }
        }
      }
      item {
        androidx.compose.foundation.layout.Column {
          ChoiceRow(
            "TARGETS FIRST",
            listOf("AUTO" to "auto", "SMALL" to "small", "BIG" to "big", "CIVIL" to "civilian"),
            ship.priority, allowed,
          ) { v -> patch({ put("priority", v) }, "Targets set") }
        }
      }
    }
  }
}

/** The last step of SEND: which world, how many ships, hold to go. */
@Composable
fun SendConfirmScreen(
  ui: WearViewModel.UiState,
  vm: WearViewModel,
  shipIds: List<String>,
  bodyId: String,
  onDone: () -> Unit,
  onBack: () -> Unit,
) {
  BackHandler(onBack = onBack)
  val name = ui.worlds?.systems?.flatMap { it.bodies }?.firstOrNull { it.id == bodyId }?.name ?: "?"
  Box(Modifier.fillMaxSize().background(Ground), contentAlignment = Alignment.Center) {
    androidx.compose.foundation.layout.Column(
      Modifier.fillMaxWidth().padding(horizontal = 24.dp),
      horizontalAlignment = Alignment.CenterHorizontally,
    ) {
      Text("SEND ${shipIds.size} ${if (shipIds.size == 1) "SHIP" else "SHIPS"}", color = Dim, fontSize = 9.sp)
      Text("TO ${name.uppercase()}", color = Ink, fontSize = 14.sp, textAlign = TextAlign.Center)
      Text("Leaves this tick; any course in flight is replaced", color = Dim, fontSize = 8.sp, textAlign = TextAlign.Center, modifier = Modifier.padding(vertical = 6.dp))
      OrderStatus(ui)
      HoldButton("SEND", Good, enabled = !ui.ordering && ui.command?.orders == true) {
        vm.order(
          Orders.order("send") { put("ship_ids", Orders.ids(shipIds)); put("body_id", bodyId) },
          "Under way to ${name.uppercase()}",
        )
        onDone()
      }
      TapButton("CANCEL", Dim, Modifier.padding(top = 4.dp)) { onBack() }
    }
  }
}
