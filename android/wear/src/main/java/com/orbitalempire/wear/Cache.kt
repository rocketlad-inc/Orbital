package com.orbitalempire.wear

import android.content.Context
import java.io.File

/**
 * WORKS ON A TRAIN. The last state and orders documents are kept on the
 * watch with the time they arrived, so a watch out of signal opens on the
 * empire as of twelve minutes ago -- marked with its age -- rather than a
 * spinner. Only ever the player's own documents, and cleared on unpairing.
 */
object Cache {
  private const val PREFS = "orbital_wear_cache"

  fun put(c: Context, name: String, raw: String) {
    try {
      File(c.filesDir, "cache-$name.json").writeText(raw)
      c.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putLong(name, System.currentTimeMillis()).apply()
    } catch (_: Throwable) {
    }
  }

  /** The document and when it was fetched, or null. */
  fun get(c: Context, name: String): Pair<String, Long>? = try {
    val f = File(c.filesDir, "cache-$name.json")
    val at = c.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getLong(name, 0L)
    if (f.exists() && at > 0L) f.readText() to at else null
  } catch (_: Throwable) {
    null
  }

  fun clear(c: Context) {
    for (n in listOf("state", "command")) File(c.filesDir, "cache-$n.json").delete()
    c.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().clear().apply()
  }
}
