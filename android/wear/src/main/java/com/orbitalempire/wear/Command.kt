package com.orbitalempire.wear

import android.content.Context
import android.util.Log
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedReader
import java.net.HttpURLConnection
import java.net.URL

/**
 * What the order screens show: /wear/<token>/command.json.
 * See worker/wearOrders.js. [orders] is whether this watch was allowed to
 * give orders (the 'wear_orders' pairing); everything else is readable
 * either way.
 */
data class Command(
  val orders: Boolean = false,
  val tick: Int = 0,
  val me: String = "",
  val factions: Map<String, FactionInfo> = emptyMap(),
  val ships: List<CmdShip> = emptyList(),
  val offers: List<Offer> = emptyList(),
  val wars: List<War> = emptyList(),
  val inbox: List<Message> = emptyList(),
  val yards: List<Yard> = emptyList(),
  val prices: Map<String, Price> = emptyMap(),
) {
  fun ship(id: String) = ships.firstOrNull { it.id == id }
  fun fleetOf(s: CmdShip): List<CmdShip> = if (s.fleet == null) listOf(s) else ships.filter { it.fleet == s.fleet }
  fun name(f: String?) = factions[f]?.name ?: "?"
  fun color(f: String?) = factions[f]?.color ?: "#7d92a6"
}

data class CmdShip(
  val id: String,
  val name: String,
  val cls: String,
  val at: String?,
  val fleet: String?,
  val moving: Boolean,
  val stance: String,
  val retreatPct: Int?,
  val detonatePct: Int?,
  val priority: String,
  val detonator: Boolean,
  val armedTick: Int?,
)

data class Offer(val id: String, val from: String, val give: String, val get: String, val pacts: List<String>, val note: String?)
data class War(val with: String, val since: Int, val ceasefire: String?)
data class Message(val id: String, val from: String, val body: String, val at: Int, val read: Boolean)
data class Yard(val body: String, val name: String, val level: Int, val queue: List<Build>)
data class Build(val id: String, val cls: String, val name: String?, val status: String, val left: Int?, val of: Int?, val rushed: Int)
data class Price(val metal: Int, val credits: Int)

private fun JSONObject.str(k: String): String? = if (!has(k) || isNull(k)) null else optString(k, "").ifEmpty { null }
private fun JSONObject.int(k: String): Int? = if (!has(k) || isNull(k)) null else optInt(k)
private inline fun <T> JSONArray?.each(f: (JSONObject) -> T): List<T> {
  if (this == null) return emptyList()
  return (0 until length()).mapNotNull { optJSONObject(it)?.let(f) }
}

/** "80M 60C" -- what a trade gives or asks, in resource order. */
private fun bundle(o: JSONObject?): String {
  if (o == null) return ""
  val parts = ArrayList<String>()
  for ((k, t) in listOf("metal" to "M", "gold" to "C", "science" to "S", "fuel" to "F")) {
    val v = o.optDouble(k, 0.0)
    if (v > 0) parts += "${compact(v.toLong())}$t"
  }
  return parts.joinToString(" ")
}

fun parseCommand(raw: String): Command {
  val o = JSONObject(raw)
  val factions = HashMap<String, FactionInfo>()
  o.optJSONObject("factions")?.let { f ->
    for (k in f.keys()) f.optJSONObject(k)?.let { v -> factions[k] = FactionInfo(v.optString("name"), v.optString("color", "#7d92a6")) }
  }
  val prices = HashMap<String, Price>()
  o.optJSONObject("prices")?.let { p ->
    for (k in p.keys()) p.optJSONObject(k)?.let { v -> prices[k] = Price(v.optInt("metal"), v.optInt("credits")) }
  }
  return Command(
    orders = o.optBoolean("orders", false),
    tick = o.optInt("tick", 0),
    me = o.optString("me", ""),
    factions = factions,
    ships = o.optJSONArray("ships").each { s ->
      CmdShip(
        id = s.optString("id"), name = s.optString("n"), cls = s.optString("cls", "corvette"),
        at = s.str("at"), fleet = s.str("fl"), moving = s.optBoolean("moving", false),
        stance = s.optString("stance", "attack"), retreatPct = s.int("rt"), detonatePct = s.int("dt"),
        priority = s.optString("prio", "auto"), detonator = s.optBoolean("det", false), armedTick = s.int("boom"),
      )
    },
    offers = o.optJSONArray("offers").each { t ->
      val pacts = t.optJSONArray("pacts")
      Offer(
        id = t.optString("id"), from = t.optString("from"),
        give = bundle(t.optJSONObject("offer")), get = bundle(t.optJSONObject("request")),
        pacts = (0 until (pacts?.length() ?: 0)).map { i ->
          val p = pacts!!.opt(i)
          (if (p is JSONObject) p.optString("kind", p.toString()) else p.toString()).replace('_', ' ').uppercase()
        },
        note = t.str("note"),
      )
    },
    wars = o.optJSONArray("wars").each { w -> War(w.optString("with"), w.optInt("since"), w.str("ceasefire")) },
    inbox = o.optJSONArray("inbox").each { m ->
      Message(m.optString("id"), m.optString("from"), m.optString("body"), m.optInt("at"), m.optBoolean("read"))
    },
    yards = o.optJSONArray("yards").each { y ->
      Yard(
        body = y.optString("body"), name = y.optString("name"), level = y.optInt("level", 1),
        queue = y.optJSONArray("queue").each { q ->
          Build(q.optString("id"), q.optString("cls"), q.str("n"), q.optString("status", "building"), q.int("left"), q.int("of"), q.optInt("rushed", 0))
        },
      )
    },
    prices = prices,
  )
}

/** One order's outcome: null error is success; otherwise the game's own words. */
data class OrderResult(val ok: Boolean, val message: String?)

object Orders {
  private const val TAG = "OrbitalWear"

  suspend fun command(c: Context): Command? = withContext(Dispatchers.IO) {
    val token = OrbitalClient.token(c) ?: return@withContext null
    try {
      val conn = URL("${OrbitalClient.BASE}/wear/$token/command.json").openConnection() as HttpURLConnection
      try {
        conn.connectTimeout = 15_000; conn.readTimeout = 15_000
        if (conn.responseCode != 200) null
        else parseCommand(conn.inputStream.bufferedReader().use(BufferedReader::readText))
      } finally { conn.disconnect() }
    } catch (t: Throwable) {
      Log.w(TAG, "command fetch failed", t)
      null
    }
  }

  /** POST one order ({ verb, ... }). */
  suspend fun send(c: Context, order: JSONObject): OrderResult = withContext(Dispatchers.IO) {
    val token = OrbitalClient.token(c) ?: return@withContext OrderResult(false, "Not connected")
    try {
      val conn = URL("${OrbitalClient.BASE}/wear/$token/order").openConnection() as HttpURLConnection
      try {
        conn.connectTimeout = 15_000; conn.readTimeout = 20_000
        conn.requestMethod = "POST"
        conn.doOutput = true
        conn.setRequestProperty("content-type", "application/json")
        conn.outputStream.use { it.write(order.toString().toByteArray()) }
        val code = conn.responseCode
        val body = (if (code < 400) conn.inputStream else conn.errorStream)?.bufferedReader()?.use(BufferedReader::readText)
        val err = try { body?.let { JSONObject(it).optJSONObject("error")?.optString("message") } } catch (_: Throwable) { null }
        if (code < 400 && err.isNullOrEmpty()) OrderResult(true, null)
        else OrderResult(false, err?.ifEmpty { null } ?: "The game said $code")
      } finally { conn.disconnect() }
    } catch (t: Throwable) {
      Log.w(TAG, "order failed", t)
      OrderResult(false, "No connection")
    }
  }

  fun order(verb: String, build: JSONObject.() -> Unit = {}) = JSONObject().apply { put("verb", verb); build() }
  fun ids(list: List<String>) = JSONArray().apply { list.forEach { put(it) } }
}
