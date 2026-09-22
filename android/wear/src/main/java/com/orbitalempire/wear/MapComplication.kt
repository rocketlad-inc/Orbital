package com.orbitalempire.wear

import android.app.PendingIntent
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.RadialGradient
import android.graphics.Shader
import android.graphics.drawable.Icon
import android.util.Log
import androidx.compose.ui.graphics.toArgb
import androidx.wear.watchface.complications.data.ComplicationData
import androidx.wear.watchface.complications.data.ComplicationType
import androidx.wear.watchface.complications.data.NoDataComplicationData
import androidx.wear.watchface.complications.data.PhotoImageComplicationData
import androidx.wear.watchface.complications.data.PlainComplicationText
import androidx.wear.watchface.complications.datasource.ComplicationRequest
import androidx.wear.watchface.complications.datasource.SuspendingComplicationDataSourceService
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.ln
import kotlin.math.max
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * The Sol map, as the Orbital watch face's background.
 *
 * Lorne's picture was the game's zoomed-out map: every system a band
 * around the Sun, shaded by whoever holds it, the planets on their
 * orbits, the territory readable at a glance. A Watch Face Format face
 * cannot fetch anything itself, so the watch app draws that map here
 * and hands it to the face as a PHOTO_IMAGE complication, refreshed at
 * Wear's five-minute floor and whenever the app or a tile has fresh
 * data (OrbitalComplication.refreshAll).
 *
 *   BANDS  one per system, spanning its worlds' distances from the Sun,
 *          in the controller's colour (the senate's plurality rule);
 *          hatched grey when contested, a faint ring when unheld
 *   ORBITS a hairline per world
 *   WORLDS at their position this tick; yours ringed in your colour,
 *          a battlefield ringed red
 *
 * THE SCALE IS LOGARITHMIC in distance, as the game's zoomed-out view
 * effectively is: Mercury and the Far Reach differ by a factor of about
 * thirty, and a linear map would put the whole inner system in the
 * pixels the face's clock covers.
 *
 * THE CENTRE IS LEFT QUIET. The face draws the time over it, so the inner
 * system is dimmed there rather than competing with the digits.
 */
class MapComplication : SuspendingComplicationDataSourceService() {

  override suspend fun onComplicationRequest(request: ComplicationRequest): ComplicationData? {
    return try {
      val w = OrbitalClient.worlds(this) ?: return NoDataComplicationData()
      if (w.systems.isEmpty()) return NoDataComplicationData()
      PhotoImageComplicationData.Builder(
        Icon.createWithBitmap(render(w, SIZE)),
        PlainComplicationText.Builder("Map of the Sol system: who holds each system").build(),
      ).setTapAction(open()).build()
    } catch (t: Throwable) {
      Log.w("OrbitalWear", "map complication failed", t)
      NoDataComplicationData()
    }
  }

  override fun getPreviewData(type: ComplicationType): ComplicationData? =
    PhotoImageComplicationData.Builder(
      Icon.createWithBitmap(render(Worlds(), SIZE)),
      PlainComplicationText.Builder("Sol map").build(),
    ).build()

  private fun open(): PendingIntent = PendingIntent.getActivity(
    this,
    7201,
    Intent(this, MainActivity::class.java)
      .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
      .putExtra(MainActivity.EXTRA_PAGE, 3),
    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
  )

  companion object {
    /** Bitmaps cross a binder to the face; 320 square stays well under
     *  the transaction limit and the face scales it to its own size. */
    private const val SIZE = 320

    fun render(w: Worlds, size: Int): Bitmap {
      val bmp = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
      val cv = Canvas(bmp)
      val c = size / 2f
      cv.drawColor(Ground.toArgb())
      val p = Paint(Paint.ANTI_ALIAS_FLAG)

      val bodies = w.systems.flatMap { s -> s.bodies.map { s to it } }
      val dist = { b: SysBody -> sqrt(b.hx * b.hx + b.hy * b.hy) }
      val far = max(1.0, bodies.maxOfOrNull { dist(it.second) } ?: 1.0) * 1.04
      val outer = c * 0.96f
      val k = far / 60.0
      val rOf = { d: Double -> (outer * ln(1 + d / k) / ln(1 + far / k)).toFloat() }
      val mine = factionColor(w.colorOf(w.me)).toArgb()

      // Bands, outermost first so an inner band paints over a wide outer one.
      for (sys in w.systems.sortedByDescending { s -> s.bodies.maxOfOrNull { dist(it) } ?: 0.0 }) {
        if (sys.bodies.isEmpty()) continue
        val lo = sys.bodies.minOf { dist(it) }
        val hi = sys.bodies.maxOf { dist(it) }
        val r0 = rOf(lo) - 5f
        val r1 = rOf(hi) + 5f
        val width = max(6f, r1 - r0)
        val mid = (r0 + r1) / 2f
        p.style = Paint.Style.STROKE
        p.strokeWidth = width
        p.shader = null
        p.color = when {
          sys.controller != null -> withAlpha(factionColor(w.colorOf(sys.controller)).toArgb(), 0.62f)
          sys.contested -> withAlpha(0xFF6B7280.toInt(), 0.45f)
          else -> withAlpha(Trough.toArgb(), 0.85f)
        }
        cv.drawCircle(c, c, mid, p)
        if (sys.contested) {
          // Contested: the game hatches it; a dashed rim reads the same.
          p.strokeWidth = 1.2f
          p.color = withAlpha(0xFFE2ECF5.toInt(), 0.35f)
          p.pathEffect = android.graphics.DashPathEffect(floatArrayOf(4f, 4f), 0f)
          cv.drawCircle(c, c, mid, p)
          p.pathEffect = null
        }
      }

      // Orbits.
      p.shader = null
      p.style = Paint.Style.STROKE
      p.strokeWidth = 0.8f
      p.color = withAlpha(0xFFE2ECF5.toInt(), 0.18f)
      for ((_, b) in bodies) cv.drawCircle(c, c, rOf(dist(b)), p)

      // The Sun.
      p.style = Paint.Style.FILL
      p.shader = RadialGradient(c, c, 16f, intArrayOf(0xFFFFF1B0.toInt(), 0xFFFFB347.toInt(), 0x00FF8A00), null, Shader.TileMode.CLAMP)
      cv.drawCircle(c, c, 16f, p)
      p.shader = null

      // Worlds.
      for ((_, b) in bodies) {
        val d = dist(b)
        val a = atan2(b.hy, b.hx)
        val r = rOf(d)
        val x = c + (cos(a) * r).toFloat()
        val y = c + (sin(a) * r).toFloat()
        val dot = when (b.type) {
          "gas-giant", "gas_giant" -> 4.2f
          "ice-giant", "ice_giant" -> 3.8f
          "terrestrial" -> 3.2f
          else -> 1.8f
        }
        p.style = Paint.Style.FILL
        p.color = factionColor(b.color).toArgb()
        cv.drawCircle(x, y, dot, p)
        if (b.mine > 0) {
          p.style = Paint.Style.STROKE
          p.strokeWidth = 1.4f
          p.color = mine
          cv.drawCircle(x, y, dot + 2.6f, p)
        }
        if (b.battle != null) {
          p.style = Paint.Style.STROKE
          p.strokeWidth = 1.6f
          p.color = Alarm.toArgb()
          cv.drawCircle(x, y, dot + 5f, p)
        }
      }

      // Quiet the middle, where the face draws the time.
      p.style = Paint.Style.FILL
      p.shader = RadialGradient(c, c, c * 0.42f, intArrayOf(withAlpha(Ground.toArgb(), 0.78f), withAlpha(Ground.toArgb(), 0f)), null, Shader.TileMode.CLAMP)
      cv.drawCircle(c, c, c * 0.42f, p)
      p.shader = null
      return bmp
    }

    private fun withAlpha(argb: Int, a: Float): Int =
      (argb and 0x00FFFFFF) or ((a.coerceIn(0f, 1f) * 255).toInt() shl 24)
  }
}
