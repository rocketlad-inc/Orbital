package com.orbitalempire.wear

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.wear.compose.foundation.lazy.ScalingLazyColumn
import androidx.wear.compose.foundation.lazy.items
import androidx.wear.compose.foundation.lazy.rememberScalingLazyListState
import androidx.wear.compose.material.Text

/**
 * THE MAP'S SHORTCUTS: hold a world on the Systems map and it offers
 * what you can do there -- SEND A FLEET HERE (pick the fleet, hold to
 * send), BUILD HERE where you have a yard, or LOOK (the Porthole).
 */
@Composable
fun MapActionsSheet(ui: WearViewModel.UiState, vm: WearViewModel, bodyId: String, nav: Nav, onClose: () -> Unit) {
  var mode by remember(bodyId) { mutableStateOf("menu") }
  var fleet by remember(bodyId) { mutableStateOf<FleetGroup?>(null) }
  val place = placeOf(ui.worlds, bodyId) ?: return
  val cmd = ui.command
  val yard = cmd?.yards?.firstOrNull { it.body == bodyId }
  val chosen = fleet
  if (mode == "send" && chosen != null) {
    SendConfirm(ui, vm, chosen, place, heard = null, onDone = onClose, onBack = { fleet = null })
    return
  }
  BackHandler { if (mode == "menu") onClose() else mode = "menu" }
  Box(Modifier.fillMaxSize()) {
    StarfieldBackground(dim = 0.25f)
    Frame(top = place.name.uppercase()) { s ->
      if (mode == "build" && cmd != null && yard != null) {
        Box(Modifier.fillMaxSize()) { YardPicker(ui, vm, cmd, yard, s, Modifier.padding(top = u(s, 60f)), onDone = onClose) }
        return@Frame
      }
      ScalingLazyColumn(
        state = rememberScalingLazyListState(),
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(start = u(s, 50f), end = u(s, 50f), top = u(s, 56f), bottom = u(s, 60f)),
        verticalArrangement = Arrangement.spacedBy(u(s, 6f)),
      ) {
        item { Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) { PlanetArt(place.sp, u(s, 70f)) } }
        if (mode == "menu") {
          item { TapButton("SEND A FLEET HERE", Teal, height = u(s, 44f), outline = true) { mode = "send" } }
          if (yard != null) item { TapButton("BUILD HERE", Good, height = u(s, 44f), outline = true) { mode = "build" } }
          item { TapButton("VIEW ORBIT", Sub, height = u(s, 44f)) { onClose(); nav.watch(bodyId) } }
        } else if (mode == "send") {
          val groups = cmd?.let { groupsOf(it) }?.filter { !it.moving && it.at != bodyId } ?: emptyList()
          item { Text("WHICH FLEET?", color = Sub, fontSize = tp(s, 11f), fontWeight = FontWeight.Bold, textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth()) }
          if (groups.isEmpty()) item { None("No fleets free to send") }
          items(groups) { g ->
            Row(
              Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(u(s, 22f)))
                .background(Color(0xE0111821))
                .clickable { fleet = g }
                .padding(horizontal = u(s, 8f), vertical = u(s, 5f)),
              verticalAlignment = Alignment.CenterVertically,
            ) {
              CaptainBadge(g.captain, g.hullKey, u(s, 36f))
              Column(Modifier.padding(start = u(s, 8f))) {
                Text(g.title, color = Ink, fontSize = tp(s, 13f), fontWeight = FontWeight.Bold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text("at ${placeOf(ui.worlds, g.at)?.name ?: "?"}", color = Sub, fontSize = tp(s, 10f), maxLines = 1)
              }
            }
          }
        }
      }
    }
  }
}
