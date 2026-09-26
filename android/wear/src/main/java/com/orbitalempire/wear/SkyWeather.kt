package com.orbitalempire.wear

import android.content.Context
import android.util.Log
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.BufferedReader
import java.net.HttpURLConnection
import java.net.URL
import java.util.Locale
import kotlin.math.roundToInt

/**
 * THE WEATHER THAT DECIDES WHETHER YOU SEE ANY OF IT: temperature and,
 * above all, cloud cover, from Open-Meteo (no key, no account).
 *
 * Cached for half an hour: the forecast model updates hourly at best,
 * and a complication is asked far more often than that. The position is
 * rounded to two decimals (about a kilometre) before it leaves the watch.
 * Open-Meteo's free tier is for non-commercial use, which a personal
 * face is; a paid product would need its commercial plan.
 */
object SkyWeather {

  private const val PREFS = "orbital_sky_weather"
  private const val TTL_MS = 30 * 60_000L

  data class Now(val temp: Int, val unit: String, val cloud: Int, val code: Int, val at: Long) {
    /** A word for the sky, from the WMO weather code. */
    val sky: String
      get() = when (code) {
        0 -> "CLEAR"
        1, 2 -> "FAIR"
        3 -> "CLOUDY"
        45, 48 -> "FOG"
        in 51..67 -> "RAIN"
        in 71..77 -> "SNOW"
        in 80..82 -> "SHOWERS"
        in 85..86 -> "SNOW"
        in 95..99 -> "STORM"
        else -> "CLOUD"
      }
  }

  private fun fahrenheit(): Boolean =
    Locale.getDefault().country.uppercase(Locale.ROOT) in setOf("US", "LR", "MM", "BS", "KY", "PW", "FM", "MH")

  fun cached(c: Context): Now? {
    val p = c.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    if (!p.contains("at")) return null
    return Now(p.getInt("temp", 0), p.getString("unit", "°") ?: "°", p.getInt("cloud", 0), p.getInt("code", 0), p.getLong("at", 0L))
  }

  /** Current conditions, from cache when fresh. Null when there is no
   *  location yet or the network is out and nothing is cached. */
  suspend fun now(c: Context): Now? {
    val have = cached(c)
    if (have != null && System.currentTimeMillis() - have.at < TTL_MS) return have
    val fix = SkyLocation.saved(c) ?: return have
    val fresh = fetch(fix.lat, fix.lon) ?: return have
    c.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
      .putInt("temp", fresh.temp).putString("unit", fresh.unit)
      .putInt("cloud", fresh.cloud).putInt("code", fresh.code).putLong("at", fresh.at)
      .apply()
    return fresh
  }

  private suspend fun fetch(lat: Double, lon: Double): Now? = withContext(Dispatchers.IO) {
    val f = fahrenheit()
    val url = String.format(
      Locale.ROOT,
      "https://api.open-meteo.com/v1/forecast?latitude=%.2f&longitude=%.2f" +
        "&current=temperature_2m,cloud_cover,weather_code&temperature_unit=%s",
      lat, lon, if (f) "fahrenheit" else "celsius",
    )
    try {
      val conn = (URL(url).openConnection() as HttpURLConnection).apply {
        connectTimeout = 12_000
        readTimeout = 12_000
      }
      try {
        if (conn.responseCode != 200) return@withContext null
        val o = JSONObject(conn.inputStream.bufferedReader().use(BufferedReader::readText))
        val cur = o.getJSONObject("current")
        Now(
          temp = cur.getDouble("temperature_2m").roundToInt(),
          unit = if (f) "°F" else "°C",
          cloud = cur.getDouble("cloud_cover").roundToInt(),
          code = cur.optInt("weather_code", 0),
          at = System.currentTimeMillis(),
        )
      } finally {
        conn.disconnect()
      }
    } catch (t: Throwable) {
      Log.w("OrbitalSky", "weather fetch failed", t)
      null
    }
  }
}
