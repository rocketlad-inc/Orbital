package com.orbitalempire.wear

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import androidx.core.app.RemoteInput
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import org.json.JSONObject

/**
 * A button pressed on one of the watch's own alerts (WatchAlerts).
 *
 * The verb in the intent is the server's, carried untouched from the
 * alert: POST /wear/<token>/act runs it as this watch's owner through
 * the same code as a phone notification's button, so the payload says
 * only WHAT to do and the token says who. Nothing here decides whether
 * an order is legal -- the game does, and its answer is what the player
 * sees in the receipt that replaces the alert.
 */
class AlertActionReceiver : BroadcastReceiver() {

  override fun onReceive(c: Context, i: Intent) {
    val nid = i.getIntExtra(WatchAlerts.EXTRA_NID, 0)
    val verb = try {
      JSONObject(i.getStringExtra(WatchAlerts.EXTRA_VERB) ?: return)
    } catch (t: Throwable) {
      return
    }
    // Spoken, typed or a canned line: whichever the player chose.
    val reply = RemoteInput.getResultsFromIntent(i)
      ?.getCharSequence(WatchAlerts.KEY_REPLY)?.toString()?.trim()?.ifEmpty { null }
    val title = i.getStringExtra(WatchAlerts.EXTRA_TITLE)
    val app = c.applicationContext
    val pending = goAsync()
    scope.launch {
      try {
        val (ok, message) = OrbitalClient.act(app, verb, reply)
        WatchAlerts.result(app, nid, ok, message, title)
        // What the order changed shows at once rather than at the next
        // wrist raise: the Battle Stations card, the alert list.
        if (ok) AlertWorker.kick(app)
      } catch (t: Throwable) {
        Log.w("OrbitalWear", "alert action failed", t)
        WatchAlerts.result(app, nid, false, "No connection", title)
      } finally {
        pending.finish()
      }
    }
  }

  private companion object {
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
  }
}
