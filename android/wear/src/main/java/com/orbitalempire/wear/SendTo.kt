package com.orbitalempire.wear

import androidx.activity.compose.BackHandler
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
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontStyle
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
 * SEND TO…: the places this fleet can go, NEAREST FIRST by the game's own
 * route maths (worker/wearOrders.js destinations.json), each with its
 * sprite and what is there -- yours, a rival's, unclaimed, a fight. Tap
 * one, hold to send; the rim fills as you hold. PICK ON THE MAP opens the
 * Systems map for anywhere else.
 */
@Composable
fun SendToScreen(
  ui: WearViewModel.UiState,
  vm: WearViewModel,
  g: FleetGroup,
  onPickMap: () -> Unit,
  onDone: () -> Unit,
  onClose: () -> Unit,
) {
  BackHandler(onBack = onClose)
  val ctx = LocalContext.current
  var dests by remember(g.lead.id) { mutableStateOf<List<Destination>?>(null) }
  var failed by remember(g.lead.id) { mutableStateOf(false) }
  var pick by remember(g.lead.id) { mutableStateOf<Destination?>(null) }
  LaunchedEffect(g.lead.id) {
    val d = Orders.destinations(ctx, g.lead.id)
    dests = d
    failed = d == null
  }
  Box(Modifier.fillMaxSize()) {
    StarfieldBackground(dim = 0.2f)
    Frame(top = "SEND ${g.title}") { s ->
      ScalingLazyColumn(
        state = rememberScalingLazyListState(initialCenterItemIndex = 0),
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(start = u(s, 50f), end = u(s, 50f), top = u(s, 60f), bottom = u(s, if (pick != null) 130f else 60f)),
        verticalArrangement = Arrangement.spacedBy(u(s, 6f)),
      ) {
        item { Text("NEAREST FIRST", color = Sub, fontSize = tp(s, 11f), fontWeight = FontWeight.Bold, modifier = Modifier.fillMaxWidth().padding(start = 6.dp)) }
        val list = dests
        when {
          list == null && !failed -> item { None("PLOTTING COURSES…") }
          list == null -> item { None("Could not plot courses") }
          list.isEmpty() -> item { None("Nowhere in reach") }
          else -> items(list) { d ->
            DestRow(d, pick?.id == d.id, s, ui) { pick = d }
          }
        }
        item {
          Text(
            "PICK ON THE MAP ›", color = ScienceInk, fontSize = tp(s, 13f), fontWeight = FontWeight.Bold, textAlign = TextAlign.Center,
            modifier = Modifier.fillMaxWidth().clickable { onPickMap() }.padding(vertical = 6.dp),
          )
        }
      }
      val p = pick
      if (p != null) {
        Column(Modifier.align(Alignment.BottomCenter).padding(bottom = u(s, 52f)).width(u(s, 260f)), horizontalAlignment = Alignment.CenterHorizontally) {
          OrderStatus(ui)
          HoldButton(
            "SEND TO ${p.name.uppercase()}", Teal, filled = true, height = u(s, 46f),
            enabled = ui.command?.orders == true && !ui.ordering,
          ) {
            vm.order(
              Orders.order("send") { put("ship_ids", Orders.ids(g.ids)); put("body_id", p.id) },
              "Under way to ${p.name.uppercase()} · ${p.eta}T",
            )
            onDone()
          }
        }
      }
    }
  }
}

private fun note(d: Destination, capitalId: String?): Pair<String, Color> = when {
  d.status == "fighting" -> "Under fire" to Color(0xFFFF8A82)
  d.id == capitalId -> "Your capital" to Good
  d.status == "yours" -> "Yours" to Good
  d.status == "rival" -> (d.owner?.let { "Held by $it" } ?: "A rival's") to Warn
  else -> "Unclaimed" to Sub
}

@Composable
private fun DestRow(d: Destination, on: Boolean, s: Dp, ui: WearViewModel.UiState, onPick: () -> Unit) {
  val (text, ink) = note(d, ui.state.capital?.id)
  Row(
    Modifier
      .fillMaxWidth()
      .clip(RoundedCornerShape(u(s, 16f)))
      .background(if (on) Color(0xFF0F2A28) else Color(0xE0111821))
      .border(if (on) 2.dp else 1.dp, if (on) Teal else Color(0xFF1B2430), RoundedCornerShape(u(s, 16f)))
      .clickable(onClick = onPick)
      .padding(horizontal = u(s, 12f), vertical = u(s, 7f)),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    PlanetArt(d.sp, u(s, 34f))
    Column(Modifier.weight(1f).padding(start = u(s, 10f))) {
      Text(d.name.uppercase(), color = Ink, fontSize = tp(s, 15f), fontWeight = FontWeight.Bold, maxLines = 1, overflow = TextOverflow.Ellipsis)
      Text(text, color = ink, fontSize = tp(s, 11f), maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
    Text("${d.eta}T", color = Ink, fontSize = tp(s, 14f), fontFamily = GameFont)
  }
}

/**
 * THE LAST STEP, for a place picked on the map or spoken: the fleet, an
 * arrow, the world, and HOLD TO SEND. [heard] is what the watch heard,
 * shown back as said; [onAgain] offers SAY IT AGAIN.
 */
@Composable
fun SendConfirm(
  ui: WearViewModel.UiState,
  vm: WearViewModel,
  g: FleetGroup,
  place: Place,
  heard: String?,
  onDone: () -> Unit,
  onBack: () -> Unit,
  onAgain: (() -> Unit)? = null,
) {
  BackHandler(onBack = onBack)
  val ctx = LocalContext.current
  var eta by remember(g.lead.id, place.id) { mutableStateOf<Int?>(null) }
  LaunchedEffect(g.lead.id, place.id) {
    eta = Orders.destinations(ctx, g.lead.id)?.firstOrNull { it.id == place.id }?.eta
  }
  val from = placeOf(ui.worlds, g.at)
  Box(Modifier.fillMaxSize()) {
    StarfieldBackground(dim = 0.2f)
    Frame(top = if (heard != null) "SPEAK AN ORDER" else "SEND ${g.title}", topInk = Color(0xFFCFF5F1)) { s ->
      Column(Modifier.fillMaxSize().padding(top = u(s, 70f)), horizontalAlignment = Alignment.CenterHorizontally) {
        if (heard != null) {
          Text("“$heard”", color = Ink, fontSize = tp(s, 16f), fontStyle = FontStyle.Italic, textAlign = TextAlign.Center, maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.width(u(s, 300f)))
        }
        Row(
          Modifier
            .padding(top = u(s, 10f))
            .width(u(s, 340f))
            .clip(RoundedCornerShape(u(s, 30f)))
            .background(Color(0xE6111821))
            .border(1.dp, Color(0xFF1E4D4A), RoundedCornerShape(u(s, 30f)))
            .padding(vertical = u(s, 10f), horizontal = u(s, 10f)),
          horizontalArrangement = Arrangement.Center,
          verticalAlignment = Alignment.CenterVertically,
        ) {
          CaptainBadge(g.captain, g.hullKey, u(s, 46f))
          Column(Modifier.padding(start = u(s, 6f)).weight(1f)) {
            Text(g.title, color = Ink, fontSize = tp(s, 13f), fontWeight = FontWeight.Bold, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text("from ${from?.name ?: "?"}", color = Sub, fontSize = tp(s, 10f), maxLines = 1)
          }
          Text("→", color = Teal, fontSize = tp(s, 18f))
          PlanetArt(place.sp, u(s, 40f), modifier = Modifier.padding(horizontal = u(s, 4f)))
          Column(Modifier.weight(1f)) {
            Text(place.name.uppercase(), color = Ink, fontSize = tp(s, 13f), fontWeight = FontWeight.Bold, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(eta?.let { "in $it tick${if (it == 1) "" else "s"}" } ?: "plotting…", color = Sub, fontSize = tp(s, 10f))
          }
        }
        Text(
          if (heard != null) "Heard, matched to your fleets and worlds, and shown back before anything is sent."
          else "Leaves this tick; any course in flight is replaced.",
          color = Sub, fontSize = tp(s, 11f), textAlign = TextAlign.Center, modifier = Modifier.width(u(s, 280f)).padding(top = u(s, 8f)),
        )
        OrderStatus(ui)
        HoldButton(
          "SEND", Teal, Modifier.width(u(s, 220f)).padding(top = u(s, 4f)), filled = true, height = u(s, 50f),
          enabled = ui.command?.orders == true && !ui.ordering,
        ) {
          vm.order(
            Orders.order("send") { put("ship_ids", Orders.ids(g.ids)); put("body_id", place.id) },
            "Under way to ${place.name.uppercase()}",
          )
          onDone()
        }
        if (onAgain != null) {
          Text(
            "SAY IT AGAIN", color = Sub, fontSize = tp(s, 13f), fontWeight = FontWeight.Bold,
            modifier = Modifier.padding(top = u(s, 8f)).clickable { onAgain() },
          )
        }
      }
    }
  }
}
