package com.orbitalempire.wear

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.RemoteInput
import androidx.wear.phone.interactions.notifications.BridgingConfig
import androidx.wear.phone.interactions.notifications.BridgingManager
import org.json.JSONArray
import org.json.JSONObject

/**
 * THE WATCH'S OWN ALERTS, not the phone's copied across.
 *
 * A mirrored phone notification can only open the phone, and its
 * buttons run there. These come from the server's watch feed
 * (worker/wearAlerts.js) and are posted here, natively:
 *
 *  - A TAP OPENS THE RIGHT SCREEN OF THE WATCH APP: the Porthole of the
 *    world under fire or being approached, the Senate page for a bill,
 *    Comms for a message or an offer, the Empire page for a turn.
 *  - THE BUTTONS ACT FROM THE WRIST: RETREAT, YEA / NAY / ABSTAIN,
 *    ACCEPT / DECLINE, and REPLY by voice, keyboard or a canned line --
 *    through the watch's own orders token (AlertActionReceiver), the
 *    same verbs the phone's buttons send.
 *  - THEY CLEAR THEMSELVES: the feed names the alerts already dealt
 *    with -- the fight over, the offer answered in the browser, the
 *    bill voted on the phone -- and this cancels them.
 *
 * AND THE PHONE STOPS MIRRORING while this is running, so the same
 * event does not arrive twice (see [bridging]).
 */
object WatchAlerts {

  private const val TAG = "OrbitalWear"
  private const val PREFS = "orbital_watch_alerts"
  private const val KEY_CURSOR = "cursor"

  /** Notification ids for alerts live above everything else the app
   *  posts (Battle Stations uses 7101/7102). */
  private const val ID_BASE = 100_000

  const val KEY_REPLY = "reply"
  const val EXTRA_NID = "nid"
  const val EXTRA_VERB = "verb"
  const val EXTRA_TITLE = "title"
  const val EXTRA_LABEL = "label"

  private const val CH_COMBAT = "alert-combat"
  private const val CH_SENATE = "alert-senate"
  private const val CH_DIPLO = "alert-diplomacy"
  private const val CH_TURN = "alert-turn"
  private const val CH_INFO = "alert-info"

  /** Canned answers offered under REPLY, beside voice and keyboard: the
   *  same lines the Comms screen offers. */
  private val CANNED = arrayOf<CharSequence>("Agreed.", "Not now.", "On my way.", "Thank you.", "No deal.")

  fun notifId(alertId: Long): Int = ID_BASE + (alertId % 1_000_000L).toInt()

  /**
   * Collect and post whatever is new. Safe to call from anywhere and as
   * often as liked: the cursor makes a second call a no-op.
   *
   * A FIRST CALL ONLY TAKES THE CURSOR. A watch paired a moment ago
   * starts from now rather than replaying days of turns at once.
   */
  suspend fun sync(c: Context): Boolean {
    if (!OrbitalClient.hasToken(c)) return false
    val prefs = c.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    val cursor = prefs.getLong(KEY_CURSOR, -1L)
    val o = OrbitalClient.alerts(c, if (cursor < 0) null else cursor) ?: return false
    val latest = o.optLong("latest", cursor)
    if (cursor >= 0) {
      val alerts = o.optJSONArray("alerts") ?: JSONArray()
      for (i in 0 until alerts.length()) {
        alerts.optJSONObject(i)?.let { post(c, it) }
      }
      val resolved = o.optJSONArray("resolved") ?: JSONArray()
      val nm = NotificationManagerCompat.from(c)
      for (i in 0 until resolved.length()) nm.cancel(notifId(resolved.optLong(i)))
    }
    prefs.edit().putLong(KEY_CURSOR, maxOf(latest, cursor)).apply()
    return true
  }

  /** Forget the cursor: the next pairing starts from its own "now". */
  fun reset(c: Context) {
    c.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().clear().apply()
  }

  fun allowed(c: Context): Boolean =
    Build.VERSION.SDK_INT < 33 ||
      c.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED

  /**
   * WHO SHOWS THE PHONE'S ORBITAL ALERTS ON THIS WATCH.
   *
   * The watch app shares the phone app's package, and Wear OS lets it
   * decide whether that package's phone notifications are mirrored. While
   * this watch is paired and allowed to post its own, mirroring is off
   * -- otherwise every event arrives twice, once as the phone's copy and
   * once as the watch's. Unpaired, or with notifications refused on the
   * watch, the phone's copies come back, so a player is never left with
   * nothing on the wrist.
   */
  fun bridging(c: Context, mirror: Boolean = false) {
    val own = !mirror && OrbitalClient.hasToken(c) && allowed(c)
    try {
      BridgingManager.fromContext(c).setConfig(BridgingConfig.Builder(c, !own).build())
    } catch (t: Throwable) {
      Log.w(TAG, "could not set notification bridging", t)
    }
  }

  private fun post(c: Context, a: JSONObject) {
    if (!allowed(c)) return
    channels(c)
    val id = a.optLong("id", -1L)
    if (id < 0) return
    val nid = notifId(id)
    val cat = a.optString("cat", "")
    val title = a.optString("title", "Orbital")
    val body = a.optString("body", "")

    val open = PendingIntent.getActivity(
      c,
      nid,
      openIntent(c, a.optString("screen", "empire"), a.optString("ref", "").ifEmpty { null }),
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )

    val b = NotificationCompat.Builder(c, channelFor(cat))
      .setSmallIcon(iconFor(cat))
      .setContentTitle(title)
      .setContentText(body)
      .setStyle(NotificationCompat.BigTextStyle().bigText(body))
      .setContentIntent(open)
      .setAutoCancel(true)
      .setWhen(a.optLong("at", System.currentTimeMillis()))
      .setShowWhen(true)
      .setCategory(
        when (cat) {
          "dm", "trade", "market" -> NotificationCompat.CATEGORY_MESSAGE
          "combat", "inbound" -> NotificationCompat.CATEGORY_ALARM
          else -> NotificationCompat.CATEGORY_EVENT
        },
      )

    val actions = a.optJSONArray("actions") ?: JSONArray()
    for (i in 0 until actions.length()) {
      val act = actions.optJSONObject(i) ?: continue
      val verb = act.optJSONObject("verb") ?: continue
      val label = act.optString("label", "OK")
      val reply = act.optBoolean("reply", false)
      val intent = Intent(c, AlertActionReceiver::class.java)
        // A distinct data URI per button keeps each PendingIntent its own:
        // extras alone do not make two intents different to Android.
        .setData(Uri.parse("orbital-alert://$id/${act.optString("id", i.toString())}"))
        .putExtra(EXTRA_NID, nid)
        .putExtra(EXTRA_VERB, verb.toString())
        .putExtra(EXTRA_TITLE, title)
        .putExtra(EXTRA_LABEL, label)
      // A reply needs a MUTABLE intent: the system writes the typed or
      // spoken text into it. Every other button stays immutable.
      val flags = PendingIntent.FLAG_UPDATE_CURRENT or
        (if (reply) PendingIntent.FLAG_MUTABLE else PendingIntent.FLAG_IMMUTABLE)
      val pi = PendingIntent.getBroadcast(c, nid * 4 + i, intent, flags)
      val builder = NotificationCompat.Action.Builder(0, label, pi)
      if (reply) {
        builder
          .addRemoteInput(
            RemoteInput.Builder(KEY_REPLY)
              .setLabel("Reply")
              .setChoices(CANNED)
              .build(),
          )
          .setAllowGeneratedReplies(true)
      }
      b.addAction(builder.build())
    }

    try {
      NotificationManagerCompat.from(c).notify(nid, b.build())
    } catch (t: SecurityException) {
      Log.w(TAG, "alert not posted: no permission", t)
    }
  }

  /**
   * After a button: replace the alert with what happened, in the game's
   * own words. Replacing it is also what ends the spinner Wear shows on
   * a REPLY while it waits.
   */
  fun result(c: Context, nid: Int, ok: Boolean, message: String, title: String?) {
    if (!allowed(c)) return
    channels(c)
    val done = NotificationCompat.Builder(c, CH_INFO)
      .setSmallIcon(R.drawable.ic_c_log)
      .setContentTitle(if (ok) "Order given" else "Not done")
      .setContentText(listOfNotNull(message, title).joinToString(" · "))
      .setOnlyAlertOnce(true)
      .setAutoCancel(true)
      // A receipt, not news: it goes by itself.
      .setTimeoutAfter(if (ok) 6_000L else 20_000L)
      .build()
    try {
      NotificationManagerCompat.from(c).notify(nid, done)
    } catch (t: SecurityException) {
      Log.w(TAG, "result not posted", t)
    }
  }

  /** The watch app, opened on the screen an alert belongs to. */
  private fun openIntent(c: Context, screen: String, ref: String?): Intent {
    val i = Intent(c, MainActivity::class.java)
      .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
    val page = when (screen) {
      "empire" -> 0
      "battles" -> 1
      "senate" -> 2
      "systems", "porthole" -> 3
      "territory" -> 4
      "comms" -> 5
      "yards" -> 6
      else -> 0
    }
    i.putExtra(MainActivity.EXTRA_PAGE, page)
    if (screen == "porthole" && ref != null) i.putExtra(MainActivity.EXTRA_PORTHOLE, ref)
    return i
  }

  private fun channelFor(cat: String): String = when (cat) {
    "combat", "inbound" -> CH_COMBAT
    "senate" -> CH_SENATE
    "dm", "trade", "market" -> CH_DIPLO
    "turn" -> CH_TURN
    else -> CH_INFO
  }

  private fun iconFor(cat: String): Int = when (cat) {
    "combat" -> R.drawable.ic_battle
    "inbound" -> R.drawable.ic_c_inbound
    "dm", "trade", "market" -> R.drawable.ic_c_msg
    "senate" -> R.drawable.ic_c_dom
    "economy" -> R.drawable.ic_c_ship
    else -> R.drawable.ic_c_log
  }

  /**
   * One channel per kind of news, because on a wrist the BUZZ is the
   * message: a channel's vibration is fixed at creation, and a fight
   * should not feel like a turn report. The player can mute any one in
   * the watch's own settings without losing the others.
   */
  private fun channels(c: Context) {
    val nm = c.getSystemService(NotificationManager::class.java) ?: return
    if (nm.getNotificationChannel(CH_INFO) != null) return
    fun ch(id: String, name: String, importance: Int, pattern: LongArray?) =
      NotificationChannel(id, name, importance).apply {
        if (pattern != null) {
          enableVibration(true)
          vibrationPattern = pattern
        }
      }
    nm.createNotificationChannels(
      listOf(
        ch(CH_COMBAT, "Fighting and inbound fleets", NotificationManager.IMPORTANCE_HIGH, longArrayOf(0, 250, 120, 250, 120, 250)),
        ch(CH_SENATE, "Senate bills and votes", NotificationManager.IMPORTANCE_HIGH, longArrayOf(0, 180, 140, 180)),
        ch(CH_DIPLO, "Messages and trade offers", NotificationManager.IMPORTANCE_HIGH, longArrayOf(0, 120, 90, 120)),
        ch(CH_TURN, "Turn reports", NotificationManager.IMPORTANCE_DEFAULT, longArrayOf(0, 90)),
        ch(CH_INFO, "Reports and account", NotificationManager.IMPORTANCE_LOW, null),
      ),
    )
  }
}
