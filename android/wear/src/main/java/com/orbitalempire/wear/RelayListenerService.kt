package com.orbitalempire.wear

import android.util.Log
import com.google.android.gms.wearable.MessageEvent
import com.google.android.gms.wearable.WearableListenerService
import org.json.JSONObject

/**
 * THE PHONE'S RELAY, arriving (the phone's OrbitalNotificationRelay).
 *
 * A sleeping watch has no network for background work, so its own look
 * for news just after each tick came late or not at all. The phone gets
 * Orbital's alerts on time, and hands each one here over the phone-to-
 * watch link, which reaches a sleeping watch without either device going
 * to the internet. The alert is posted at once as the watch's own
 * (WatchAlerts.postRelayed): its buzz, and a tap onto the right card.
 *
 *   /orbital/hello   the relay is on (access granted on the phone)
 *   /orbital/alert   {key, title, text, at}: one of Orbital's alerts
 */
class RelayListenerService : WearableListenerService() {

  override fun onMessageReceived(ev: MessageEvent) {
    when (ev.path) {
      PATH_HELLO -> WatchAlerts.relaySeen(this)
      PATH_ALERT -> try {
        val o = JSONObject(String(ev.data, Charsets.UTF_8))
        WatchAlerts.relaySeen(this)
        WatchAlerts.postRelayed(
          this,
          key = o.optString("key", ""),
          title = o.optString("title", "Orbital"),
          text = o.optString("text", ""),
          at = o.optLong("at", System.currentTimeMillis()),
        )
        // The feed's copy (with its buttons, and what has since resolved)
        // follows whenever the watch next has the network.
        AlertWorker.kick(this)
      } catch (t: Throwable) {
        Log.w("OrbitalWear", "relayed alert unreadable", t)
      }
    }
  }

  companion object {
    const val PATH_HELLO = "/orbital/hello"
    const val PATH_ALERT = "/orbital/alert"
  }
}
