package com.orbitalempire.wear

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.wear.ongoing.OngoingActivity
import androidx.wear.ongoing.Status

/**
 * Battle Stations: while your ships are fighting, the fight stays up.
 *
 * AN ONGOING ACTIVITY, the Wear OS surface for "this is happening now":
 * an Orbital battle icon on the watch face and in recents, for as long
 * as the fight lasts, and a tap opens that world's Porthole already
 * fighting (MainActivity.EXTRA_PORTHOLE). When the fight ends it goes.
 *
 * A BUZZ FOR WHAT CHANGED, not for every refresh: a double pulse when
 * your side has scored a kill since the watch last looked, one long buzz
 * when you have lost a ship. Two channels, because a channel's vibration
 * pattern is fixed once created and the two must feel different on the
 * wrist without looking.
 *
 * NO POLLING OF ITS OWN. It runs whenever the watch fetches state anyway
 * -- the tiles every ten minutes, the app on every wrist raise -- so it
 * costs no extra network. The moment a fight STARTS is the phone's news
 * to tell (its combat notification bridges to the watch); this keeps the
 * fight in front of you once the watch knows.
 */
object BattleStations {

  private const val TAG = "OrbitalWear"
  private const val ONGOING_ID = 7101
  private const val EVENT_ID = 7102
  private const val CH_ONGOING = "battle-stations"
  private const val CH_KILL = "battle-kill"
  private const val CH_LOSS = "battle-loss"
  private const val PREFS = "orbital_battle_stations"

  fun sync(c: Context, s: WearState) {
    try {
      if (!allowed(c)) return
      channels(c)
      val nm = NotificationManagerCompat.from(c)
      val prefs = c.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
      if (!s.isLive || s.battles.isEmpty()) {
        nm.cancel(ONGOING_ID)
        prefs.edit().clear().apply()
        return
      }

      // The fight to lead with: the feed already orders them hottest first.
      val b = s.battles.first()
      val mine = b.sides.filter { it.mine }.sumOf { it.alive }
      val theirs = b.sides.filter { !it.mine }.sumOf { it.alive }
      val where = b.body.uppercase()
      val summary = if (b.known) "$mine vs $theirs" else "$mine vs ?"
      val more = if (s.battles.size > 1) " · +${s.battles.size - 1}" else ""

      val open = PendingIntent.getActivity(
        c,
        ONGOING_ID,
        Intent(c, MainActivity::class.java)
          .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
          .putExtra(MainActivity.EXTRA_PORTHOLE, b.bodyId),
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
      )
      val card = NotificationCompat.Builder(c, CH_ONGOING)
        .setSmallIcon(R.drawable.ic_battle)
        .setContentTitle("BATTLE AT $where")
        .setContentText("$summary · ${b.kills} KILLS · ${b.lost} LOST$more")
        .setContentIntent(open)
        .setOngoing(true)
        .setOnlyAlertOnce(true)
        .setSilent(true)
        .setCategory(NotificationCompat.CATEGORY_STATUS)
      OngoingActivity.Builder(c, ONGOING_ID, card)
        .setStaticIcon(R.drawable.ic_battle)
        .setTouchIntent(open)
        .setStatus(
          Status.Builder()
            .addTemplate("#w# #s#")
            .addPart("w", Status.TextPart(where))
            .addPart("s", Status.TextPart(summary))
            .build(),
        )
        .build()
        .apply(c)
      nm.notify(ONGOING_ID, card.build())

      // What changed since the watch last looked, summed over every fight.
      val kills = s.battles.sumOf { it.kills }
      val lost = s.battles.sumOf { it.lost }
      val seenKills = prefs.getInt("kills", -1)
      val seenLost = prefs.getInt("lost", -1)
      if (seenLost >= 0 && lost > seenLost) {
        event(c, nm, CH_LOSS, "SHIP LOST AT $where", "${lost - seenLost} down · $summary", open)
      } else if (seenKills >= 0 && kills > seenKills) {
        event(c, nm, CH_KILL, "KILL AT $where", "${kills - seenKills} destroyed · $summary", open)
      }
      prefs.edit().putInt("kills", kills).putInt("lost", lost).apply()
    } catch (t: Throwable) {
      Log.w(TAG, "battle stations sync failed", t)
    }
  }

  private fun event(c: Context, nm: NotificationManagerCompat, channel: String, title: String, text: String, open: PendingIntent) {
    if (!allowed(c)) return
    nm.notify(
      EVENT_ID,
      NotificationCompat.Builder(c, channel)
        .setSmallIcon(R.drawable.ic_battle)
        .setContentTitle(title)
        .setContentText(text)
        .setContentIntent(open)
        .setAutoCancel(true)
        .setCategory(NotificationCompat.CATEGORY_EVENT)
        .build(),
    )
  }

  private fun allowed(c: Context): Boolean =
    Build.VERSION.SDK_INT < 33 ||
      c.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED

  private fun channels(c: Context) {
    val nm = c.getSystemService(NotificationManager::class.java) ?: return
    if (nm.getNotificationChannel(CH_ONGOING) != null) return
    nm.createNotificationChannel(
      NotificationChannel(CH_ONGOING, "Battle in progress", NotificationManager.IMPORTANCE_LOW).apply {
        description = "Keeps a fight on your watch face while it lasts"
        setShowBadge(false)
      },
    )
    nm.createNotificationChannel(
      NotificationChannel(CH_KILL, "Kills", NotificationManager.IMPORTANCE_HIGH).apply {
        description = "Your side destroyed a ship"
        enableVibration(true)
        vibrationPattern = longArrayOf(0, 90, 110, 90)
      },
    )
    nm.createNotificationChannel(
      NotificationChannel(CH_LOSS, "Losses", NotificationManager.IMPORTANCE_HIGH).apply {
        description = "You lost a ship"
        enableVibration(true)
        vibrationPattern = longArrayOf(0, 600)
      },
    )
  }
}
