package com.orbitalempire.wear

import android.content.Context
import android.os.Build
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager

/**
 * THE HAPTIC LANGUAGE. On a wrist the buzz arrives before the glance, so
 * each kind of news has its own, and a player learns them the way they
 * learn a ringtone:
 *
 *   the tick lands   short, long, short
 *   a kill           two quick taps
 *   a loss           one long
 *   a vote closing   three even taps
 *   a bezel detent   the system's own tick
 *
 * The same shapes are the notification channels' patterns (WatchAlerts),
 * so a buzz means the same thing in the app and out of it.
 */
object Haptics {
  val TICK = longArrayOf(0, 55, 110, 240, 110, 55)
  val KILL = longArrayOf(0, 45, 75, 45)
  val LOSS = longArrayOf(0, 520)
  val VOTE_CLOSING = longArrayOf(0, 70, 90, 70, 90, 70)
  val CONFIRM = longArrayOf(0, 35, 60, 90)

  private fun vibrator(c: Context): Vibrator? =
    if (Build.VERSION.SDK_INT >= 31) c.getSystemService(VibratorManager::class.java)?.defaultVibrator
    else @Suppress("DEPRECATION") c.getSystemService(Vibrator::class.java)

  fun play(c: Context, pattern: LongArray) {
    try {
      vibrator(c)?.takeIf { it.hasVibrator() }?.vibrate(VibrationEffect.createWaveform(pattern, -1))
    } catch (_: Throwable) {
    }
  }

  /** One click of the bezel: set a number blind. */
  fun detent(c: Context) {
    try {
      vibrator(c)?.takeIf { it.hasVibrator() }?.vibrate(VibrationEffect.createPredefined(VibrationEffect.EFFECT_TICK))
    } catch (_: Throwable) {
    }
  }

  /**
   * What the tick did, as one sequence: the tick's own buzz, then a kill's
   * double if you killed anything, then a loss's long if you lost anything.
   */
  fun tickLanded(c: Context, t: TickSummary?) {
    val seq = ArrayList<Long>()
    fun add(p: LongArray) {
      if (seq.isEmpty()) seq.addAll(p.toList()) else { seq.add(260); seq.addAll(p.drop(1)) }
    }
    add(TICK)
    if (t != null && t.killed > 0) add(KILL)
    if (t != null && t.lost > 0) add(LOSS)
    // Waveform timings alternate off/on from an initial delay; the join
    // above keeps that parity (an off gap, then the next pattern's ons).
    play(c, seq.toLongArray())
  }
}

/** Whether the app is on screen: its own notifications then post quietly,
 *  so WatchAlerts plays their buzz itself. */
object AppVisible {
  @Volatile var on: Boolean = false
}
