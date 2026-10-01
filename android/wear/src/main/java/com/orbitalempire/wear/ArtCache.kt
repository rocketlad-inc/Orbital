package com.orbitalempire.wear

import android.content.Context
import java.io.File

/**
 * THE PICTURE CACHES, AND WHEN TO THROW THEM AWAY.
 *
 * Ship icons, planet sprites and flags are fetched once per key and kept
 * on disk for good (Worlds.kt). That is right while the art stands
 * still and wrong the moment it moves: an icon cached before a redesign
 * would be drawn forever. Ship and planet keys carry the server's art
 * version, so new art arrives under new keys by itself -- but the old
 * files stay on disk for nothing, and a flag's key is only its emblem
 * id, so a redrawn emblem would never be fetched at all.
 *
 * So the feed names the art version (worlds.json `art`), and when it
 * changes every picture cache is emptied, on disk and in memory. The
 * same happens when the watch unpairs or is pointed at another server,
 * since nothing it drew for the last one is owed to the next.
 */
object ArtCache {
  private const val PREFS = "orbital_wear_art"
  private const val KEY_ART = "art"
  private val DIRS = listOf("ship-icons", "planets", "flags")

  /** Empty the caches if the server's art has moved since they filled. */
  fun sync(c: Context, art: String?) {
    if (art.isNullOrEmpty()) return
    val prefs = c.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    val had = prefs.getString(KEY_ART, null)
    if (had == art) return
    // The first sync after install has nothing stale to clear unless an
    // older build left files behind; clearing is cheap either way.
    clear(c)
    prefs.edit().putString(KEY_ART, art).apply()
  }

  /** Every picture, gone: disk and memory. */
  fun clear(c: Context) {
    for (d in DIRS) {
      try {
        File(c.cacheDir, d).deleteRecursively()
      } catch (_: Throwable) {
      }
    }
    ShipIcons.clearMemory()
    PlanetSprites.clearMemory()
    FlagIcons.clearMemory()
    c.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().remove(KEY_ART).apply()
  }
}
