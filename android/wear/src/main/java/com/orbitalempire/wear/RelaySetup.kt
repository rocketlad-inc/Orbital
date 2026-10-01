package com.orbitalempire.wear

import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.wear.compose.material.Text
import androidx.wear.remote.interactions.RemoteActivityHelper
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * ON-TIME ALERTS: the one step the phone relay needs, offered until the
 * relay has been heard from (WatchAlerts.relayActive).
 *
 * The button opens orbital://watch-relay on the phone -- the phone app's
 * RelaySetupActivity -- which goes straight to Orbital's switch in the
 * phone's notification-access settings. Once it is on, the relay says
 * hello and this row goes away by itself.
 */
@Composable
fun RelaySetupRow() {
  val ctx = LocalContext.current
  if (WatchAlerts.relayActive(ctx)) return
  val scope = rememberCoroutineScope()
  var note by remember { mutableStateOf<String?>(null) }
  Column(Modifier.fillMaxWidth().padding(vertical = 4.dp), horizontalAlignment = Alignment.CenterHorizontally) {
    Text(
      "Tick alerts come late while the watch sleeps. Let your phone pass them on:",
      color = Sub, fontSize = 9.sp, textAlign = TextAlign.Center,
    )
    TapButton("ON-TIME ALERTS: SET UP ON PHONE", Teal, Modifier.padding(top = 4.dp), outline = true) {
      scope.launch {
        note = try {
          withContext(Dispatchers.IO) {
            RemoteActivityHelper(ctx.applicationContext)
              .startRemoteActivity(
                Intent(Intent.ACTION_VIEW)
                  .addCategory(Intent.CATEGORY_BROWSABLE)
                  .setData(Uri.parse("orbital://watch-relay")),
                null,
              )
              .get()
          }
          "On your phone: turn on Orbital watch alerts"
        } catch (t: Throwable) {
          "Could not reach your phone. Update Orbital there and try again."
        }
      }
    }
    note?.let { Text(it, color = Warn, fontSize = 9.sp, textAlign = TextAlign.Center, modifier = Modifier.padding(top = 3.dp)) }
  }
}
