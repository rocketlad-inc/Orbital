package com.orbitalempire.wear

import android.app.Activity
import android.content.Intent
import android.speech.RecognizerIntent
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
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
import androidx.wear.compose.foundation.lazy.items
import androidx.wear.compose.foundation.lazy.rememberScalingLazyListState
import androidx.wear.compose.material.Text

/**
 * Comms: every diplomacy answer the watch can give.
 *
 *   WARS     each open war; OFFER CEASEFIRE, or ACCEPT PEACE when they
 *            offered (both sides must agree -- the game's rule), or
 *            WITHDRAW your own offer
 *   OFFERS   trade and pact offers waiting on you: ACCEPT (held) or DECLINE
 *   INBOX    the latest messages to you; tap one to reply with a set line
 *            or by voice (Wear's own speech input)
 *
 * The answers go through the game's own routes (worker/wearOrders.js),
 * so an accepted pact becomes a treaty exactly as a click would make it.
 */
private val CANNED = listOf("Agreed.", "Not now.", "Standing down.", "On my way.", "Thank you.", "No deal.")

@Composable
fun CommsScreen(ui: WearViewModel.UiState, vm: WearViewModel) {
  val cmd = ui.command
  var replyTo by remember { mutableStateOf<Message?>(null) }
  val open = replyTo
  if (cmd != null && open != null) {
    ReplySheet(ui, vm, cmd, open) { replyTo = null }
    return
  }
  val allowed = cmd?.orders == true && !ui.ordering
  ScalingLazyColumn(
    state = rememberScalingLazyListState(),
    modifier = Modifier.fillMaxSize(),
    contentPadding = PaddingValues(horizontal = 14.dp, vertical = 26.dp),
  ) {
    item { Text("COMMS", color = Ink, fontSize = 12.sp, textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth()) }
    item { OrderStatus(ui) }
    if (cmd == null) {
      item { Text("LOADING…", color = Dim, fontSize = 10.sp, textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth()) }
      return@ScalingLazyColumn
    }
    if (!cmd.orders) {
      item { Text("Getting this watch ready…", color = Dim, fontSize = 9.sp, textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth()) }
    }

    if (cmd.wars.isNotEmpty()) {
      item { Section("WARS") }
      items(cmd.wars) { w ->
        Column(Modifier.fillMaxWidth().padding(vertical = 3.dp)) {
          Text("AT WAR · ${cmd.name(w.with).uppercase()}", color = factionColor(cmd.color(w.with)), fontSize = 10.sp, maxLines = 1)
          when (w.ceasefire) {
            "theirs" -> {
              Text("They offer peace", color = Good, fontSize = 8.sp)
              HoldButton("ACCEPT PEACE", Good, enabled = allowed) {
                vm.order(Orders.order("ceasefire") { put("faction_id", w.with) }, "Peace made")
              }
            }
            "mine" -> {
              Text("You offered peace", color = Dim, fontSize = 8.sp)
              TapButton("WITHDRAW OFFER", Dim) {
                vm.order(Orders.order("ceasefire_withdraw") { put("faction_id", w.with) }, "Offer withdrawn")
              }
            }
            else -> HoldButton("OFFER CEASEFIRE", Warn, enabled = allowed) {
              vm.order(Orders.order("ceasefire") { put("faction_id", w.with) }, "Ceasefire offered")
            }
          }
        }
      }
    }

    item { Section("OFFERS") }
    if (cmd.offers.isEmpty()) item { None("No offers waiting") }
    items(cmd.offers) { t ->
      Column(Modifier.fillMaxWidth().padding(vertical = 3.dp)) {
        Text("FROM ${cmd.name(t.from).uppercase()}", color = factionColor(cmd.color(t.from)), fontSize = 10.sp, maxLines = 1)
        if (t.give.isNotEmpty()) Text("GIVES ${t.give}", color = Good, fontSize = 9.sp)
        if (t.get.isNotEmpty()) Text("WANTS ${t.get}", color = Warn, fontSize = 9.sp)
        if (t.pacts.isNotEmpty()) Text(t.pacts.joinToString(" · "), color = Ink, fontSize = 8.sp)
        t.note?.let { Text(it, color = Dim, fontSize = 8.sp, maxLines = 2) }
        HoldButton("ACCEPT", Good, Modifier.padding(top = 3.dp), enabled = allowed) {
          vm.order(Orders.order("trade_accept") { put("trade_id", t.id) }, "Accepted")
        }
        TapButton("DECLINE", Alarm, Modifier.padding(top = 3.dp)) {
          if (allowed) vm.order(Orders.order("trade_decline") { put("trade_id", t.id) }, "Declined")
        }
      }
    }

    item { Section("INBOX") }
    if (cmd.inbox.isEmpty()) item { None("No messages") }
    items(cmd.inbox) { m ->
      Column(
        Modifier
          .fillMaxWidth()
          .padding(vertical = 2.dp)
          .clip(RoundedCornerShape(10.dp))
          .background(Trough)
          .clickable { replyTo = m }
          .padding(horizontal = 8.dp, vertical = 5.dp),
      ) {
        Text(
          (if (m.read) "" else "● ") + cmd.name(m.from).uppercase(),
          color = factionColor(cmd.color(m.from)), fontSize = 9.sp, maxLines = 1,
        )
        Text(m.body, color = Ink, fontSize = 9.sp, maxLines = 3)
      }
    }
  }
}

@Composable
private fun ReplySheet(ui: WearViewModel.UiState, vm: WearViewModel, cmd: Command, m: Message, onClose: () -> Unit) {
  androidx.activity.compose.BackHandler(onBack = onClose)
  // Opening it is reading it.
  androidx.compose.runtime.LaunchedEffect(m.id) {
    if (!m.read && cmd.orders) vm.order(Orders.order("read") { put("message_id", m.id) }, "")
  }
  val allowed = cmd.orders && !ui.ordering
  val send = { text: String ->
    vm.order(Orders.order("message") { put("faction_id", m.from); put("body", text) }, "Sent")
    onClose()
  }
  val voice = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { r ->
    if (r.resultCode == Activity.RESULT_OK) {
      r.data?.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS)?.firstOrNull()?.takeIf { it.isNotBlank() }?.let(send)
    }
  }
  ScalingLazyColumn(
    state = rememberScalingLazyListState(),
    modifier = Modifier.fillMaxSize(),
    contentPadding = PaddingValues(horizontal = 14.dp, vertical = 26.dp),
  ) {
    item { Text(cmd.name(m.from).uppercase(), color = factionColor(cmd.color(m.from)), fontSize = 11.sp, textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth()) }
    item { Text(m.body, color = Ink, fontSize = 10.sp, modifier = Modifier.padding(vertical = 4.dp)) }
    item { OrderStatus(ui) }
    if (!cmd.orders) {
      item { Text("Getting this watch ready…", color = Dim, fontSize = 9.sp, textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth()) }
      return@ScalingLazyColumn
    }
    item {
      TapButton("SPEAK A REPLY", Good) {
        if (allowed) voice.launch(
          Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
            .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            .putExtra(RecognizerIntent.EXTRA_PROMPT, "Reply to ${cmd.name(m.from)}"),
        )
      }
    }
    items(CANNED) { line ->
      TapButton(line.uppercase(), Ink, Modifier.padding(top = 3.dp)) { if (allowed) send(line) }
    }
  }
}

@Composable
internal fun Section(title: String) {
  Text(title, color = Dim, fontSize = 8.sp, textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth().padding(top = 8.dp, bottom = 2.dp))
}

@Composable
internal fun None(text: String) {
  Text(text, color = Dim, fontSize = 9.sp, textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth())
}
