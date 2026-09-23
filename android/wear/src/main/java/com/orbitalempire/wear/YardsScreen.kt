package com.orbitalempire.wear

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.wear.compose.foundation.lazy.ScalingLazyColumn
import androidx.wear.compose.foundation.lazy.rememberScalingLazyListState
import androidx.wear.compose.material.Text

/**
 * Yards: every shipyard you hold, what it is building and how long is
 * left, and ORDER A SHIP from the wrist.
 *
 * Each yard lists its queue: the hull, a bar of how far along it is, the
 * ticks left (or WAITING for a free slot). A building hull with more than
 * a tick to go can be RUSHED -- half the time left, the full price again,
 * and the game's 25% chance of a botched ship, so it is held.
 *
 * BUILD opens the five hulls with their price at your multiplier. The
 * game charges the real total (hull plus the active design's parts) and
 * refuses with its own message if you cannot pay or have not researched
 * the hull; the watch shows that message verbatim.
 */
@Composable
fun YardsScreen(ui: WearViewModel.UiState, vm: WearViewModel) {
  val cmd = ui.command
  var building by remember { mutableStateOf<String?>(null) }
  val allowed = cmd?.orders == true && !ui.ordering
  ScalingLazyColumn(
    state = rememberScalingLazyListState(),
    modifier = Modifier.fillMaxSize(),
    contentPadding = PaddingValues(horizontal = 14.dp, vertical = 26.dp),
  ) {
    item { Text("YARDS", color = Ink, fontSize = 12.sp, textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth()) }
    item { OrderStatus(ui) }
    if (cmd == null) {
      item { None("LOADING…") }
      return@ScalingLazyColumn
    }
    if (cmd.yards.isEmpty()) {
      item { None("No shipyards yet") }
      return@ScalingLazyColumn
    }
    if (!cmd.orders) {
      item { None("Getting this watch ready…") }
    }
    for (y in cmd.yards) {
      item { Section("${y.name.uppercase()} · YARD ${y.level}") }
      if (y.queue.isEmpty()) item { None("Idle") }
      for (b in y.queue) {
        item {
          Column(Modifier.fillMaxWidth().padding(vertical = 2.dp)) {
            Row(Modifier.fillMaxWidth()) {
              Text(
                (b.name ?: b.cls).uppercase(),
                color = Ink, fontSize = 9.sp, maxLines = 1, modifier = Modifier.weight(1f),
              )
              Text(
                when {
                  b.status == "waiting" -> "WAITING"
                  b.left == null -> ""
                  b.left <= 0 -> "DUE"
                  else -> "${b.left}T"
                },
                color = if (b.status == "waiting") Dim else Warn, fontSize = 9.sp,
              )
            }
            val frac = if (b.of != null && b.of > 0 && b.left != null) 1f - b.left.toFloat() / b.of else 0f
            Box(Modifier.fillMaxWidth().height(4.dp).clip(RoundedCornerShape(2.dp)).background(Trough)) {
              Box(Modifier.fillMaxWidth(frac.coerceIn(0f, 1f)).fillMaxHeight().background(Good))
            }
            if (b.status != "waiting" && (b.left ?: 0) > 1 && cmd.orders) {
              HoldButton("RUSH (25% BOTCH)", Warn, Modifier.padding(top = 3.dp), enabled = allowed) {
                vm.order(Orders.order("rush") { put("order_id", b.id) }, "Rushed")
              }
            }
          }
        }
      }
      if (cmd.orders) {
        if (building == y.body) {
          for ((cls, p) in cmd.prices) {
            item {
              HoldButton("${cls.uppercase()} · ${compact(p.metal.toLong())}M ${compact(p.credits.toLong())}C", Good, Modifier.padding(top = 3.dp), enabled = allowed) {
                vm.order(
                  Orders.order("build") { put("body_id", y.body); put("ship_class", cls) },
                  "${cls.uppercase()} ordered at ${y.name.uppercase()}",
                )
                building = null
              }
            }
          }
          item { TapButton("CLOSE", Dim, Modifier.padding(top = 3.dp)) { building = null } }
        } else {
          item { TapButton("BUILD HERE", Good, Modifier.padding(top = 4.dp)) { building = y.body } }
        }
      }
    }
    item {
      Text(
        "Prices are the hull at your multiplier; a fitted design costs more.",
        color = Dim, fontSize = 7.sp, textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth().padding(top = 6.dp),
      )
    }
  }
}
