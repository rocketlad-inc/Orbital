package com.orbitalempire.wear

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationManager
import android.os.Build
import android.util.Log
import java.util.concurrent.Executors
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeoutOrNull
import kotlin.coroutines.resume

/**
 * WHERE THE WATCH IS, for the sky: a city-level fix, saved.
 *
 * The sky barely changes across tens of kilometres, so a coarse fix is
 * all the face needs, and it only needs a new one when the player
 * travels. Complications run in the background, where Android withholds
 * location from an app granted it "while in use", so the fix is taken
 * whenever the app is in front (Orbital or the Sky screen opening) and
 * the complications read the saved copy.
 */
object SkyLocation {

  private const val PREFS = "orbital_sky"
  private const val TAG = "OrbitalSky"

  data class Fix(val lat: Double, val lon: Double, val at: Long)

  fun granted(c: Context): Boolean =
    c.checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED ||
      c.checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED

  fun saved(c: Context): Fix? {
    val p = c.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    if (!p.contains("lat")) return null
    return Fix(
      Double.fromBits(p.getLong("lat", 0L)),
      Double.fromBits(p.getLong("lon", 0L)),
      p.getLong("at", 0L),
    )
  }

  private fun save(c: Context, l: Location) {
    c.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
      .putLong("lat", l.latitude.toBits())
      .putLong("lon", l.longitude.toBits())
      .putLong("at", System.currentTimeMillis())
      .apply()
  }

  /**
   * Take a fresh fix if allowed and the saved one is older than
   * [maxAgeMs]; returns what is saved afterwards. Never throws, never
   * waits more than twenty seconds: a sky a few hours stale is fine.
   */
  suspend fun refresh(c: Context, maxAgeMs: Long = 3 * 3600_000L): Fix? {
    val have = saved(c)
    if (!granted(c)) return have
    if (have != null && System.currentTimeMillis() - have.at < maxAgeMs) return have
    val got = withTimeoutOrNull(20_000L) { current(c) } ?: lastKnown(c)
    if (got != null) {
      save(c, got)
      SkyComplications.refreshAll(c)
    }
    return saved(c)
  }

  @SuppressLint("MissingPermission")
  private fun lastKnown(c: Context): Location? = try {
    val lm = c.getSystemService(LocationManager::class.java)
    lm?.getProviders(true).orEmpty()
      .mapNotNull { lm?.getLastKnownLocation(it) }
      .maxByOrNull { it.time }
  } catch (t: Throwable) {
    Log.w(TAG, "last known location failed", t)
    null
  }

  @SuppressLint("MissingPermission")
  private suspend fun current(c: Context): Location? {
    val lm = c.getSystemService(LocationManager::class.java) ?: return null
    val enabled = lm.getProviders(true)
    val provider = when {
      Build.VERSION.SDK_INT >= 31 && LocationManager.FUSED_PROVIDER in enabled -> LocationManager.FUSED_PROVIDER
      LocationManager.NETWORK_PROVIDER in enabled -> LocationManager.NETWORK_PROVIDER
      LocationManager.GPS_PROVIDER in enabled -> LocationManager.GPS_PROVIDER
      else -> return null
    }
    return try {
      suspendCancellableCoroutine { cont ->
        val signal = android.os.CancellationSignal()
        cont.invokeOnCancellation { signal.cancel() }
        lm.getCurrentLocation(provider, signal, Executors.newSingleThreadExecutor()) { loc ->
          if (cont.isActive) cont.resume(loc)
        }
      }
    } catch (t: Throwable) {
      Log.w(TAG, "current location failed", t)
      null
    }
  }
}
