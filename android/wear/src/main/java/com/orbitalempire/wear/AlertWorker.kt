package com.orbitalempire.wear

import android.content.Context
import android.util.Log
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import java.util.concurrent.TimeUnit

/**
 * WHEN THE WATCH LOOKS FOR NEWS, with nothing open.
 *
 * Nothing pushes to a watch here yet (that needs Firebase messaging), so
 * the watch collects its alerts itself, three ways:
 *
 *  - JUST AFTER EACH TICK. A turn is an hour and nearly everything worth
 *    buzzing about -- a fight, a fleet setting out, a bill closing, the
 *    turn line -- happens ON the tick. So the watch schedules itself for
 *    ninety seconds after the next one, every time it learns when that
 *    is. Turn news lands within a couple of minutes of the turn.
 *  - EVERY FIFTEEN MINUTES, Wear's shortest periodic job, for what
 *    arrives mid-turn: a message, a trade offer, a new bill.
 *  - WHENEVER THE WATCH IS LOOKING ANYWAY: opening the app, a tile
 *    refreshing, a button pressed on an alert (kick).
 *
 * Each run also refreshes Battle Stations from the same fetch, so the
 * fight card and the kill/loss buzz no longer wait for a tile.
 */
class AlertWorker(ctx: Context, params: WorkerParameters) : CoroutineWorker(ctx, params) {

  override suspend fun doWork(): Result {
    val c = applicationContext
    if (!OrbitalClient.hasToken(c)) return Result.success()
    return try {
      WatchAlerts.sync(c)
      OrbitalClient.stateFresh(c, 30_000L)?.let { s ->
        BattleStations.sync(c, s)
        onState(c, s)
      }
      Result.success()
    } catch (t: Throwable) {
      Log.w(TAG, "alert run failed", t)
      Result.success()
    }
  }

  companion object {
    private const val TAG = "OrbitalWear"
    private const val PERIODIC = "watch-alerts"
    private const val NOW = "watch-alerts-now"
    private const val TICK = "watch-alerts-tick"
    private const val PREFS = "orbital_watch_alerts_sched"
    private const val KEY_TICK_AT = "tick_at"

    /** How long after a tick to look: the tick's own pass (battles,
     *  alerts, the turn line) takes a moment to write. */
    private const val AFTER_TICK_MS = 90_000L

    private val online = Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()

    /**
     * Start (or keep) the schedule, and settle who shows the phone's
     * alerts. Idempotent: called on every app open and tile refresh.
     */
    fun ensure(c: Context) {
      val app = c.applicationContext
      WatchAlerts.bridging(app)
      if (!OrbitalClient.hasToken(app)) return
      try {
        WorkManager.getInstance(app).enqueueUniquePeriodicWork(
          PERIODIC,
          ExistingPeriodicWorkPolicy.KEEP,
          PeriodicWorkRequestBuilder<AlertWorker>(15, TimeUnit.MINUTES).setConstraints(online).build(),
        )
      } catch (t: Throwable) {
        Log.w(TAG, "could not schedule alerts", t)
      }
    }

    /** Look now. A second kick while one is pending is dropped. */
    fun kick(c: Context) {
      val app = c.applicationContext
      if (!OrbitalClient.hasToken(app)) return
      try {
        WorkManager.getInstance(app).enqueueUniqueWork(
          NOW,
          ExistingWorkPolicy.KEEP,
          OneTimeWorkRequestBuilder<AlertWorker>().setConstraints(online).build(),
        )
      } catch (t: Throwable) {
        Log.w(TAG, "could not kick alerts", t)
      }
    }

    /**
     * Book the look for just after the next tick, from a state document.
     *
     * The target is remembered, so the many places that learn the next
     * tick (app, tiles, this worker) book it once. APPEND_OR_REPLACE
     * rather than REPLACE: the tick worker itself books the NEXT tick
     * while it is still running, and REPLACE would cancel it mid-run.
     */
    fun onState(c: Context, s: WearState) {
      val app = c.applicationContext
      if (!s.isLive || s.nextTickAt <= 0L) return
      // The server's clock, not the watch's: nextTickAt is server time.
      val skew = if (s.serverNow > 0L) s.serverNow - System.currentTimeMillis() else 0L
      val at = s.nextTickAt - skew + AFTER_TICK_MS
      val delay = at - System.currentTimeMillis()
      if (delay <= 0L || delay > 6 * 3600_000L) return
      val prefs = app.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
      if (prefs.getLong(KEY_TICK_AT, 0L) == s.nextTickAt) return
      try {
        WorkManager.getInstance(app).enqueueUniqueWork(
          TICK,
          ExistingWorkPolicy.APPEND_OR_REPLACE,
          OneTimeWorkRequestBuilder<AlertWorker>()
            .setInitialDelay(delay, TimeUnit.MILLISECONDS)
            .setConstraints(online)
            .build(),
        )
        prefs.edit().putLong(KEY_TICK_AT, s.nextTickAt).apply()
      } catch (t: Throwable) {
        Log.w(TAG, "could not book the tick look", t)
      }
    }

    /** Unpaired: stop looking, forget the cursor, give the phone back. */
    fun stop(c: Context) {
      val app = c.applicationContext
      try {
        val wm = WorkManager.getInstance(app)
        wm.cancelUniqueWork(PERIODIC)
        wm.cancelUniqueWork(NOW)
        wm.cancelUniqueWork(TICK)
      } catch (t: Throwable) {
        Log.w(TAG, "could not stop alerts", t)
      }
      app.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().clear().apply()
      WatchAlerts.reset(app)
      WatchAlerts.bridging(app, mirror = true)
    }
  }
}
