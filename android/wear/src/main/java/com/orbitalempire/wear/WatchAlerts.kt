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
  private const val KEY_PERM_STATE = "perm_state_reported"
  private const val KEY_PERM_AT = "perm_state_reported_at"
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
  /** THE HAPTIC LANGUAGE's channels (Haptics): a channel's buzz is fixed
   *  when it is made, so the new shapes needed new channels. */
  /** v2: the first tick channel was IMPORTANCE_DEFAULT, which a Wear
   *  watch neither buzzes nor raises for -- and a channel's importance is
   *  fixed when it is made, so the fix is a new channel (the old one is
   *  deleted below). */
  private const val CH_TICK = "alert-tick-v2"
  private const val CH_TICK_OLD = "alert-tick"
  private const val CH_VOTECLOSE = "alert-voteclose"
  private const val CH_INFO = "alert-info"

  /** Canned answers offered under REPLY, beside voice and keyboard: the
   *  same lines the Comms screen offers. */
  private val CANNED = arrayOf<CharSequence>("Agreed.", "Not now.", "On my way.", "Thank you.", "No deal.")

  fun notifId(alertId: Long): Int = ID_BASE + (alertId % 1_000_000L).toInt()

  /** Relayed alerts have no feed id yet: an id from their event key. */
  private fun relayId(key: String): Int = RELAY_BASE + ((key.hashCode().toLong() and 0x7fffffff) % 100_000L).toInt()
  private const val RELAY_BASE = 1_200_000
  private const val KEY_SEEN = "seen_events"
  private const val KEY_ALERT_NID = "alert_nids"
  private const val KEY_RELAY_AT = "relay_seen_at"

  /**
   * ONE POST PER EVENT, however it arrives. An event can reach this watch
   * twice -- relayed from the phone the moment it happens, and later in the
   * server's feed -- so each posted event's key is kept (with the id it
   * was posted under), and the second arrival is dropped. Keys are the
   * producers' dedupe keys ("turn:<game>:<tick>", "battle:<id>"...).
   */
  private fun seenNid(c: Context, key: String): Int? {
    val o = seen(c)
    return if (o.has(key)) o.optInt(key) else null
  }

  private fun seen(c: Context): JSONObject = try {
    JSONObject(c.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY_SEEN, "{}") ?: "{}")
  } catch (_: Throwable) {
    JSONObject()
  }

  private fun remember(c: Context, key: String, nid: Int) {
    val o = seen(c)
    o.put(key, nid)
    // The last 150 events are plenty: a key only matters for the hours
    // between its relay and its turn in the feed.
    val keys = o.keys().asSequence().toList()
    if (keys.size > 150) keys.take(keys.size - 150).forEach { o.remove(it) }
    c.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(KEY_SEEN, o.toString()).apply()
  }

  /** A feed alert whose event was already relayed: remember which
   *  notification it is, so the feed's "resolved" can still clear it. */
  private fun mapAlert(c: Context, alertId: Long, nid: Int) {
    val p = c.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    val o = try { JSONObject(p.getString(KEY_ALERT_NID, "{}") ?: "{}") } catch (_: Throwable) { JSONObject() }
    o.put(alertId.toString(), nid)
    val keys = o.keys().asSequence().toList()
    if (keys.size > 150) keys.take(keys.size - 150).forEach { o.remove(it) }
    p.edit().putString(KEY_ALERT_NID, o.toString()).apply()
  }

  private fun mappedNid(c: Context, alertId: Long): Int? = try {
    val o = JSONObject(c.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY_ALERT_NID, "{}") ?: "{}")
    if (o.has(alertId.toString())) o.optInt(alertId.toString()) else null
  } catch (_: Throwable) {
    null
  }

  /** The phone's relay said hello (or relayed something): it is on. */
  fun relaySeen(c: Context) {
    c.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putLong(KEY_RELAY_AT, System.currentTimeMillis()).apply()
  }

  /** Whether the phone relay has been heard from in the last three days. */
  fun relayActive(c: Context): Boolean =
    System.currentTimeMillis() - c.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getLong(KEY_RELAY_AT, 0L) < 3 * 86_400_000L

  /**
   * AN ALERT RELAYED FROM THE PHONE (RelayListenerService), posted as this
   * watch's own the moment it lands. [key] is "orbital:<event>" as the
   * phone's notification tagged it (worker/push.js); the event names what
   * it is about, which gives its channel (so its buzz), its icon, and the
   * card a tap opens -- the same routing the server gives the feed's copy
   * (worker/wearAlerts.js). It has no buttons: the card it opens has them.
   */
  fun postRelayed(c: Context, key: String, title: String, text: String, at: Long) {
    if (!OrbitalClient.hasToken(c)) return
    val event = key.removePrefix("orbital:")
    if (event.isEmpty() || seenNid(c, event) != null) return
    val kind = event.substringBefore(':')
    val rest = event.substringAfter(':', "")
    val (cat, screen, ref) = when (kind) {
      "turn" -> Triple("turn", "home", null)
      "battle" -> Triple("combat", "decisions", "battle:$rest")
      "inbound" -> Triple("inbound", "systems", null)
      "voteclose", "billnew" -> Triple("senate", "decisions", "bill:$rest")
      "trade" -> Triple("trade", "decisions", "trade:$rest")
      "msg" -> Triple("dm", "comms", null)
      "market" -> Triple("market", "comms", null)
      else -> Triple("info", "home", null)
    }
    val a = JSONObject()
      .put("cat", cat)
      .put("kind", kind)
      .put("title", title)
      .put("body", text)
      .put("screen", screen)
      .put("at", at)
      .put("key", event)
    if (ref != null) a.put("ref", ref)
    post(c, a, relayId(event))
  }

  /**
   * Collect and post whatever is new. Safe to call from anywhere and as
   * often as liked: the cursor makes a second call a no-op.
   *
   * A FIRST CALL ONLY TAKES THE CURSOR. A watch paired a moment ago
   * starts from now rather than replaying days of turns at once.
   */
  suspend fun sync(c: Context): Boolean {
    if (!OrbitalClient.hasToken(c)) return false
    reportPermission(c)
    val prefs = c.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    val cursor = prefs.getLong(KEY_CURSOR, -1L)
    val o = OrbitalClient.alerts(c, if (cursor < 0) null else cursor) ?: return false
    val latest = o.optLong("latest", cursor)
    if (cursor >= 0) {
      val alerts = o.optJSONArray("alerts") ?: JSONArray()
      for (i in 0 until alerts.length()) {
        val a = alerts.optJSONObject(i) ?: continue
        // Already relayed from the phone: not again, but remember which
        // notification it is so "resolved" below can still clear it.
        val key = a.optString("key", "")
        val had = if (key.isNotEmpty()) seenNid(c, key) else null
        if (had != null) {
          mapAlert(c, a.optLong("id", -1L), had)
          continue
        }
        post(c, a)
      }
      val resolved = o.optJSONArray("resolved") ?: JSONArray()
      val nm = NotificationManagerCompat.from(c)
      for (i in 0 until resolved.length()) {
        val id = resolved.optLong(i)
        nm.cancel(notifId(id))
        mappedNid(c, id)?.let { nm.cancel(it) }
      }
    }
    prefs.edit().putLong(KEY_CURSOR, maxOf(latest, cursor)).apply()
    return true
  }

  /**
   * TELL THE SERVER WHETHER THIS WATCH MAY POST AT ALL. post() returns
   * silently without the permission, so a watch that was refused (or
   * whose one prompt was dismissed) fetched every alert and showed none,
   * and nothing anywhere said so. Reported on every change, and once a
   * day while it stays off, as android:wear-notifs in client_crashes.
   */
  private suspend fun reportPermission(c: Context) {
    val prefs = c.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    val state = if (allowed(c)) "on" else "off"
    val last = prefs.getString(KEY_PERM_STATE, null)
    val lastAt = prefs.getLong(KEY_PERM_AT, 0L)
    val now = System.currentTimeMillis()
    if (state == last && (state == "on" || now - lastAt < 24 * 3600_000L)) return
    OrbitalClient.report(c, "wear-notifs", "watch notifications $state (sdk ${Build.VERSION.SDK_INT})")
    prefs.edit().putString(KEY_PERM_STATE, state).putLong(KEY_PERM_AT, now).apply()
  }

  /** Forget the cursor: the next pairing starts from its own "now". */
  fun reset(c: Context) {
    c.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().clear().apply()
  }

  /** May this watch post at all: the runtime permission (Wear 4+) AND the
   *  app-level switch, which a player can turn off with the permission
   *  still granted. Either one alone silently eats every alert. */
  fun allowed(c: Context): Boolean =
    (Build.VERSION.SDK_INT < 33 ||
      c.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) &&
      NotificationManagerCompat.from(c).areNotificationsEnabled()

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

  private fun post(c: Context, a: JSONObject, relayNid: Int? = null) {
    if (!allowed(c)) return
    channels(c)
    val id = a.optLong("id", -1L)
    if (relayNid == null && id < 0) return
    val nid = relayNid ?: notifId(id)
    a.optString("key", "").takeIf { it.isNotEmpty() }?.let { remember(c, it, nid) }
    val cat = a.optString("cat", "")
    val kind = a.optString("kind", "")
    val title = a.optString("title", "Orbital")
    val body = a.optString("body", "")

    val open = PendingIntent.getActivity(
      c,
      nid,
      openIntent(c, a.optString("screen", "empire"), a.optString("ref", "").ifEmpty { null }),
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )

    val b = NotificationCompat.Builder(c, channelFor(cat, kind))
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
      // WITH THE APP ON SCREEN, Wear posts the app's own notification
      // quietly -- the player is already looking at it -- so the buzz
      // that says what kind of news this is would never come. Play it here.
      if (AppVisible.on) Haptics.play(c, hapticFor(cat, a.optString("kind", "")))
    } catch (t: SecurityException) {
      Log.w(TAG, "alert not posted: no permission", t)
    }
  }

  /** The haptic language's buzz for this alert (Haptics), matching its channel. */
  private fun hapticFor(cat: String, kind: String): LongArray = when {
    kind == "voteclose" -> Haptics.VOTE_CLOSING
    cat == "turn" -> Haptics.TICK
    cat == "combat" || cat == "inbound" -> Haptics.LOSS
    else -> Haptics.CONFIRM
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
    val dest = when (screen) {
      "empire", "home" -> Dest.HOME
      "battles", "decisions" -> Dest.DECISIONS
      "senate" -> Dest.SENATE
      "systems", "porthole", "map" -> Dest.MAP
      "territory" -> Dest.TERRITORY
      "comms" -> Dest.COMMS
      "yards" -> Dest.YARDS
      "fleets" -> Dest.FLEETS
      "realm" -> Dest.REALM
      else -> Dest.HOME
    }
    i.putExtra(MainActivity.EXTRA_PAGE, dest)
    if (screen == "porthole" && ref != null) i.putExtra(MainActivity.EXTRA_PORTHOLE, ref)
    // AN ALERT ABOUT SOMETHING YOU CAN ANSWER opens its Decision card.
    if (screen == "decisions" && ref != null) i.putExtra(MainActivity.EXTRA_REF, ref)
    return i
  }

  private fun channelFor(cat: String, kind: String): String = when {
    kind == "voteclose" -> CH_VOTECLOSE
    cat == "combat" || cat == "inbound" -> CH_COMBAT
    cat == "senate" -> CH_SENATE
    cat == "dm" || cat == "trade" || cat == "market" -> CH_DIPLO
    cat == "turn" -> CH_TICK
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
    // Created EVERY time, not once: re-creating a channel with the same
    // id is how Android renames it ("Turn reports" -> "Tick reports"),
    // and it never touches the importance or vibration a player changed.
    if (nm.getNotificationChannel(CH_TICK) != null) return
    try { nm.deleteNotificationChannel(CH_TICK_OLD) } catch (_: Throwable) { }
    // The old tick channel buzzed once; its replacement buzzes the tick's
    // own short-long-short.
    try { nm.deleteNotificationChannel(CH_TURN) } catch (_: Throwable) { }
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
        ch(CH_TICK, "Tick reports", NotificationManager.IMPORTANCE_HIGH, Haptics.TICK),
        ch(CH_VOTECLOSE, "Votes about to close", NotificationManager.IMPORTANCE_HIGH, Haptics.VOTE_CLOSING),
        ch(CH_INFO, "Reports and account", NotificationManager.IMPORTANCE_LOW, null),
      ),
    )
  }
}
