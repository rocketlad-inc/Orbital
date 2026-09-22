package com.orbitalempire.wear

import android.content.Context
import android.graphics.BitmapFactory
import android.util.Log
import android.util.LruCache
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

/**
 * The systems and the orbits: /wear/<token>/worlds.json.
 *
 * SYSTEMS are what the bezel turns through, in the game's own grouping
 * and named as the map names them. WORLDS are the places you have ships
 * parked, each with every ship in that orbit -- yours and rivals' --
 * which is what the Porthole draws. See worker/wearWorlds.js.
 */
data class Worlds(
  val tick: Int = 0,
  val me: String = "",
  val factions: Map<String, FactionInfo> = emptyMap(),
  val worlds: List<World> = emptyList(),
  val systems: List<SystemView> = emptyList(),
  /** live | eliminated | ended | none, from the feed. */
  val state: String = "live",
) {
  fun world(id: String): World? = worlds.firstOrNull { it.id == id }
  fun colorOf(factionId: String): String = factions[factionId]?.color ?: "#4ecdc4"
  fun nameOf(factionId: String): String = factions[factionId]?.name ?: ""
}

data class FactionInfo(val name: String, val color: String)

data class World(
  val id: String,
  val name: String,
  val type: String,
  val color: String,
  val radius: Double,
  val parent: String?,
  val owner: String?,
  val firing: Boolean,
  val battle: Boolean,
  val counts: Map<String, Int>,
  val ships: List<OrbitShip>,
  /** The world's sprite key: /wear/planet/<sp>/<px>.png. */
  val sp: String? = null,
)

data class OrbitShip(
  val id: String,
  val name: String,
  val key: String,
  val cls: String,
  val hp: Int?,
  val faction: String,
  val fleet: String?,
  val lead: Boolean,
  val fighting: Boolean,
  val target: String?,
)

data class SystemView(
  val id: String,
  val label: String,
  val grid: Boolean,
  val bodies: List<SysBody>,
  val mine: Int,
  val battle: String?,
  /** Who holds the system (the senate's plurality rule), for the map. */
  val controller: String? = null,
  val contested: Boolean = false,
)

data class SysBody(
  val id: String,
  val name: String,
  val type: String,
  val color: String,
  val radius: Double,
  val parent: String?,
  val orbit: Double,
  val angle: Double,
  val owner: String?,
  val mine: Int,
  val rivals: Int,
  val battle: String?,
  /** In sensor range right now (the game's own visible set): tapping it
   *  shows the ships in its orbit. Out of range, the Porthole says so. */
  val seen: Boolean = true,
  /** Sun-centred position this tick, for the watch face's map. */
  val hx: Double = 0.0,
  val hy: Double = 0.0,
  /** Ships in orbit per empire, where you can see them; each count is
   *  drawn in its owner's colour. */
  val counts: Map<String, Int> = emptyMap(),
  /** The world's sprite key: /wear/planet/<sp>/<px>.png, the game's own
   *  planet art. Null from an older server: the watch draws a plain disc. */
  val sp: String? = null,
)

fun parseWorlds(raw: String): Worlds {
  val o = JSONObject(raw)
  val factions = HashMap<String, FactionInfo>()
  o.optJSONObject("factions")?.let { f ->
    for (k in f.keys()) {
      val v = f.optJSONObject(k) ?: continue
      factions[k] = FactionInfo(v.optString("name", ""), v.optString("color", "#4ecdc4"))
    }
  }
  return Worlds(
    state = o.optString("state", "live"),
    tick = o.optInt("tick", 0),
    me = o.optString("me", ""),
    factions = factions,
    worlds = o.optJSONArray("worlds").objects { w ->
      val battle = w.optJSONObject("battle")
      val counts = HashMap<String, Int>()
      w.optJSONObject("counts")?.let { c -> for (k in c.keys()) counts[k] = c.optInt(k, 0) }
      World(
        id = w.optString("id"),
        name = w.optString("name"),
        type = w.optString("type"),
        color = w.optString("color", "#8899aa"),
        radius = w.optDouble("radius", 1.0),
        parent = w.optStringOrNull("parent"),
        owner = w.optStringOrNull("owner"),
        firing = battle?.optBoolean("firing", false) ?: false,
        battle = battle != null,
        counts = counts,
        sp = w.optStringOrNull("sp"),
        ships = w.optJSONArray("ships").objects { s ->
          OrbitShip(
            id = s.optString("id"),
            name = s.optString("n"),
            key = s.optString("k", "corvette:A:green"),
            cls = s.optString("cls", "corvette"),
            hp = if (s.isNull("hp")) null else s.optInt("hp", 100),
            faction = s.optString("f"),
            fleet = s.optStringOrNull("fl"),
            lead = s.optBoolean("lead", false),
            fighting = s.optBoolean("c", false),
            target = s.optStringOrNull("t"),
          )
        },
      )
    },
    systems = o.optJSONArray("systems").objects { s ->
      SystemView(
        id = s.optString("id"),
        label = s.optString("label"),
        grid = s.optString("layout") == "grid",
        mine = s.optInt("mine", 0),
        battle = s.optStringOrNull("battle"),
        controller = s.optStringOrNull("controller"),
        contested = s.optBoolean("contested", false),
        bodies = s.optJSONArray("bodies").objects { b ->
          SysBody(
            id = b.optString("id"),
            name = b.optString("name"),
            type = b.optString("type"),
            color = b.optString("color", "#8899aa"),
            radius = b.optDouble("radius", 1.0),
            parent = b.optStringOrNull("parent"),
            orbit = b.optDouble("orbit", 0.0),
            angle = b.optDouble("angle", 0.0),
            owner = b.optStringOrNull("owner"),
            mine = b.optInt("mine", 0),
            rivals = b.optInt("rivals", 0),
            battle = b.optStringOrNull("battle"),
            seen = b.optBoolean("seen", true),
            hx = b.optDouble("hx", 0.0),
            hy = b.optDouble("hy", 0.0),
            sp = b.optStringOrNull("sp"),
            counts = HashMap<String, Int>().also { m ->
              b.optJSONObject("counts")?.let { c -> for (k in c.keys()) c.optInt(k, 0).takeIf { it > 0 }?.let { m[k] = it } }
            },
          )
        },
      )
    },
  )
}

private fun JSONObject.optStringOrNull(key: String): String? =
  if (!has(key) || isNull(key)) null else optString(key, "").ifEmpty { null }

private inline fun <T> JSONArray?.objects(f: (JSONObject) -> T): List<T> {
  if (this == null) return emptyList()
  val out = ArrayList<T>(length())
  for (i in 0 until length()) {
    val o = optJSONObject(i) ?: continue
    out.add(f(o))
  }
  return out
}

/**
 * The real ship icon, fetched once per key and kept.
 *
 * THE GAME'S ShipIcon, not a watch drawing of one: the server rasterises
 * the same generated SVG the battle card uses and hands back a PNG. Kept
 * in memory and on disk, so a Porthole full of the same frigate costs
 * one request, ever -- the key names the drawing exactly.
 */
object ShipIcons {
  private const val TAG = "OrbitalWear"
  private const val PX = 64

  private val memory = LruCache<String, ImageBitmap>(96)
  private val lock = Mutex()

  fun cached(key: String): ImageBitmap? = memory.get(key)

  suspend fun load(c: Context, key: String): ImageBitmap? {
    memory.get(key)?.let { return it }
    return lock.withLock {
      memory.get(key)?.let { return@withLock it }
      withContext(Dispatchers.IO) {
        try {
          val dir = File(c.cacheDir, "ship-icons").apply { mkdirs() }
          val file = File(dir, key.replace(':', '_') + "@$PX.png")
          if (!file.exists() || file.length() == 0L) {
            val conn = URL("${OrbitalClient.BASE}/wear/icon/$key/$PX.png").openConnection() as HttpURLConnection
            try {
              conn.connectTimeout = 10_000
              conn.readTimeout = 10_000
              if (conn.responseCode != 200) return@withContext null
              val bytes = conn.inputStream.use { it.readBytes() }
              file.writeBytes(bytes)
            } finally {
              conn.disconnect()
            }
          }
          val bmp = BitmapFactory.decodeFile(file.path) ?: return@withContext null
          bmp.asImageBitmap().also { memory.put(key, it) }
        } catch (t: Throwable) {
          Log.w(TAG, "icon $key failed", t)
          null
        }
      }
    }
  }
}

/**
 * The game's planet art, per world: the map's own procedural painter,
 * run on the server and rasterised (worker/planetSvg.js), so a world on
 * the wrist has the continents, bands and craters it has on the map. The
 * key names everything the art depends on, so each size of each world
 * is fetched once, ever, and kept on disk.
 */
object PlanetSprites {
  private const val TAG = "OrbitalWear"

  /** Saturn and Uranus wear rings, so their sprite is twice the disk
   *  across with the disk centred (planetSvg.js RING_PAD): fetch it
   *  twice as large and draw it twice as large. */
  fun scale(key: String): Int = if (key.startsWith("saturn~") || key.startsWith("uranus~")) 2 else 1
  private val memory = LruCache<String, ImageBitmap>(48)
  private val lock = Mutex()

  fun cached(key: String, px: Int): ImageBitmap? = memory.get("$key@$px")

  suspend fun load(c: Context, key: String, px: Int): ImageBitmap? {
    val mk = "$key@$px"
    memory.get(mk)?.let { return it }
    return lock.withLock {
      memory.get(mk)?.let { return@withLock it }
      withContext(Dispatchers.IO) {
        try {
          val dir = File(c.cacheDir, "planets").apply { mkdirs() }
          val file = File(dir, key.replace(Regex("[^A-Za-z0-9_~-]"), "_") + "@$px.png")
          if (!file.exists() || file.length() == 0L) {
            val conn = URL("${OrbitalClient.BASE}/wear/planet/$key/$px.png").openConnection() as HttpURLConnection
            try {
              conn.connectTimeout = 10_000
              conn.readTimeout = 15_000
              if (conn.responseCode != 200) return@withContext null
              file.writeBytes(conn.inputStream.use { it.readBytes() })
            } finally {
              conn.disconnect()
            }
          }
          val bmp = BitmapFactory.decodeFile(file.path) ?: return@withContext null
          bmp.asImageBitmap().also { memory.put(mk, it) }
        } catch (t: Throwable) {
          Log.w(TAG, "planet $key failed", t)
          null
        }
      }
    }
  }
}
