package com.orbitalempire.wear

import android.content.Context
import android.util.Log
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.BufferedReader
import java.net.HttpURLConnection
import java.net.URL

/**
 * The board: who holds what, from /wear/<token>/standings.json.
 *
 * WORLDS AND SYSTEMS ARE PUBLIC, and everything else is a sensors
 * question the SERVER answers -- a rival's fleet comes back null without
 * Fleet Census (Sensors 3), and its stockpiles null without Economic
 * Intel (Sensors 4). Null here means locked, and the screen says so
 * rather than drawing a zero, because a zero is a claim and this is an
 * absence of one.
 */
data class Standing(
  val id: String,
  val name: String,
  val color: String,
  val mine: Boolean,
  val out: Boolean,
  val worlds: Int,
  val systems: Int,
  val weight: Int,
  val ships: Int?,
  val metal: Long?,
  val credits: Long?,
  val science: Long?,
)

data class Board(
  val state: String = "none",
  val tick: Int = 0,
  val me: String? = null,
  val total: Int = 0,
  val claimed: Int = 0,
  val unclaimed: Int = 0,
  val systemsTotal: Int = 0,
  /** The smallest number of worlds that wins. */
  val need: Int = 0,
  val factions: List<Standing> = emptyList(),
) {
  val hasBar: Boolean get() = total > 0
}

fun parseBoard(raw: String): Board {
  val o = JSONObject(raw)
  val w = o.optJSONObject("worlds")
  val list = ArrayList<Standing>()
  o.optJSONArray("factions")?.let { arr ->
    for (i in 0 until arr.length()) {
      val f = arr.optJSONObject(i) ?: continue
      fun longOrNull(k: String): Long? = if (f.isNull(k)) null else f.optLong(k, 0L)
      list += Standing(
        id = f.optString("id"),
        name = f.optString("name", "?"),
        color = f.optString("color", "#7d92a6"),
        mine = f.optBoolean("mine", false),
        out = f.optBoolean("out", false),
        worlds = f.optInt("worlds", 0),
        systems = f.optInt("systems", 0),
        weight = f.optInt("weight", 0),
        ships = if (f.isNull("ships")) null else f.optInt("ships", 0),
        metal = longOrNull("metal"),
        credits = longOrNull("credits"),
        science = longOrNull("science"),
      )
    }
  }
  return Board(
    state = o.optString("state", "none"),
    tick = o.optInt("tick", 0),
    me = if (o.isNull("me")) null else o.optString("me").ifEmpty { null },
    total = w?.optInt("total", 0) ?: 0,
    claimed = w?.optInt("claimed", 0) ?: 0,
    unclaimed = w?.optInt("unclaimed", 0) ?: 0,
    systemsTotal = w?.optInt("systemsTotal", 0) ?: 0,
    need = w?.optInt("need", 0) ?: 0,
    factions = list,
  )
}

object Standings {
  private const val TAG = "OrbitalWear"

  suspend fun board(c: Context): Board? = withContext(Dispatchers.IO) {
    val token = OrbitalClient.token(c) ?: return@withContext null
    try {
      val conn = URL("${OrbitalClient.BASE}/wear/$token/standings.json").openConnection() as HttpURLConnection
      try {
        conn.connectTimeout = 15_000
        conn.readTimeout = 15_000
        if (conn.responseCode != 200) null
        else parseBoard(conn.inputStream.bufferedReader().use(BufferedReader::readText))
      } finally {
        conn.disconnect()
      }
    } catch (t: Throwable) {
      Log.w(TAG, "standings fetch failed", t)
      null
    }
  }
}
