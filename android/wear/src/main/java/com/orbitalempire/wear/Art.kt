package com.orbitalempire.wear

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.RadialGradient
import android.graphics.Shader
import android.util.Log
import android.util.LruCache
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.requiredSize
import androidx.compose.ui.draw.rotate
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ColorFilter
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import kotlin.math.roundToInt

/**
 * THE GAME'S OWN ART, ON THE WRIST.
 *
 * Every screen sits on the map's starfield, every world shows the sprite
 * the map paints it with, every hull is the game's ShipIcon coloured by
 * its health, every captain has their face and every empire its flag.
 * None of it is drawn here: the planets, hulls and flags come from the
 * server's own rasterisers (worker/planetSvg.js, shipIconRaster.js,
 * wearFlag.js) and the faces from the game's portrait set, so the watch
 * and the map never disagree about what anything looks like.
 */
object Starfield {

  /**
   * mapRenderer.generateStarfield, ported: the same density (one star per
   * 700 square pixels, split 60/40 far and near, the near layer boosted
   * 1.35), the same four kinds of star by the same odds, and the same
   * three faint nebulae. SEEDED, so the sky does not reshuffle every time
   * a screen is opened, and drawn once per size into a bitmap.
   */
  private val cache = LruCache<Int, ImageBitmap>(3)

  fun bitmap(size: Int): ImageBitmap {
    cache.get(size)?.let { return it }
    val bmp = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
    val c = android.graphics.Canvas(bmp)
    c.drawColor(android.graphics.Color.rgb(7, 11, 16))
    val rnd = java.util.Random(0x0B17A1L)
    val p = android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG)
    // The nebulae are placed for a 480px map view and scaled to the
    // watch: at the map's own radii they would be the whole screen.
    val k = size / 480f
    for ((r, g, b, a) in listOf(
      arrayOf(80, 60, 130, 13), arrayOf(60, 90, 150, 13), arrayOf(140, 80, 90, 10),
    )) {
      val cx = rnd.nextFloat() * size
      val cy = rnd.nextFloat() * size
      val rad = (180 + rnd.nextFloat() * 280) * k
      p.shader = RadialGradient(
        cx, cy, rad,
        android.graphics.Color.argb(a, r, g, b), android.graphics.Color.argb(0, 0, 0, 0),
        Shader.TileMode.CLAMP,
      )
      c.drawRect(cx - rad, cy - rad, cx + rad, cy + rad, p)
    }
    p.shader = null
    val count = (size * size) / 700
    val far = (count * 0.6).toInt()
    // Device pixels are small on a watch; a map pixel is about 1.4 here.
    val px = size / 330f
    paintStars(c, p, rnd, far, 1f, size, px)
    paintStars(c, p, rnd, count - far, 1.35f, size, px)
    return bmp.asImageBitmap().also { cache.put(size, it) }
  }

  private fun paintStars(c: android.graphics.Canvas, p: android.graphics.Paint, rnd: java.util.Random, n: Int, boost: Float, size: Int, px: Float) {
    fun rgba(r: Int, g: Int, b: Int, a: Float) = android.graphics.Color.argb((a.coerceIn(0f, 1f) * 255).roundToInt(), r, g, b)
    repeat(n) {
      val x = rnd.nextFloat() * size
      val y = rnd.nextFloat() * size
      val r = rnd.nextFloat()
      when {
        r > 0.985f -> {
          val halo = 4.5f * boost * px
          p.shader = RadialGradient(x, y, halo, rgba(255, 240, 200, 0.45f), rgba(255, 240, 200, 0f), Shader.TileMode.CLAMP)
          c.drawCircle(x, y, halo, p)
          p.shader = null
          p.color = rgba(255, 248, 220, 0.95f)
          c.drawCircle(x, y, 1.4f * boost * px, p)
        }
        r > 0.93f -> {
          p.color = rgba(220, 230, 255, (0.7f + rnd.nextFloat() * 0.3f) * boost)
          c.drawCircle(x, y, boost * px, p)
        }
        r > 0.70f -> {
          p.color = rgba(200, 210, 225, (0.4f + rnd.nextFloat() * 0.3f) * boost)
          c.drawRect(x, y, x + 0.8f * boost * px, y + 0.8f * boost * px, p)
        }
        else -> {
          p.color = rgba(170, 180, 200, (0.18f + rnd.nextFloat() * 0.22f) * boost)
          c.drawRect(x, y, x + 0.6f * boost * px, y + 0.6f * boost * px, p)
        }
      }
    }
  }
}

/** The starfield, filling whatever it is put in. [dim] darkens it under
 *  busy screens so the stars never compete with text. */
@Composable
fun StarfieldBackground(modifier: Modifier = Modifier, dim: Float = 0f, tint: Color? = null) {
  BoxWithConstraints(modifier.fillMaxSize()) {
    val px = with(LocalDensity.current) { maxOf(maxWidth, maxHeight).toPx().roundToInt() }.coerceIn(64, 720)
    val img = remember(px) { Starfield.bitmap(px) }
    Image(bitmap = img, contentDescription = null, modifier = Modifier.fillMaxSize())
    if (tint != null) Box(Modifier.fillMaxSize().background(tint))
    if (dim > 0f) Box(Modifier.fillMaxSize().background(Color.Black.copy(alpha = dim)))
  }
}

/**
 * The captains' faces: /portraits/p<N>.webp, the game's own set, which is
 * Naev's art under CC-BY-SA 3.0 (credited on the Realm page, as the
 * game's Credits page credits it). Kept on disk: a face never changes.
 */
object Portraits {
  private const val TAG = "OrbitalWear"
  private val memory = LruCache<String, ImageBitmap>(32)
  private val missing = java.util.Collections.synchronizedSet(HashSet<String>())
  private val lock = Mutex()

  fun cached(id: String): ImageBitmap? = memory.get(id)

  suspend fun load(c: Context, id: String): ImageBitmap? {
    if (!Regex("p\\d{1,4}").matches(id)) return null
    memory.get(id)?.let { return it }
    if (missing.contains(id)) return null
    return lock.withLock {
      memory.get(id)?.let { return@withLock it }
      withContext(Dispatchers.IO) {
        try {
          val dir = File(c.cacheDir, "portraits").apply { mkdirs() }
          val file = File(dir, "$id.webp")
          if (!file.exists() || file.length() == 0L) {
            val conn = URL("${OrbitalClient.BASE}/portraits/$id.webp").openConnection() as HttpURLConnection
            try {
              conn.connectTimeout = 10_000
              conn.readTimeout = 10_000
              if (conn.responseCode != 200) {
                missing.add(id)
                return@withContext null
              }
              file.writeBytes(conn.inputStream.use { it.readBytes() })
            } finally {
              conn.disconnect()
            }
          }
          val bmp = BitmapFactory.decodeFile(file.path) ?: return@withContext null
          bmp.asImageBitmap().also { memory.put(id, it) }
        } catch (t: Throwable) {
          Log.w(TAG, "portrait $id failed", t)
          null
        }
      }
    }
  }
}

/** A world, as the map paints it; a plain disc in [fallback] until the
 *  sprite arrives (or if it never does). */
@Composable
fun PlanetArt(sp: String?, size: Dp, modifier: Modifier = Modifier, fallback: Color = Dim, alpha: Float = 1f) {
  val ctx = LocalContext.current
  val scale = sp?.let { PlanetSprites.scale(it) } ?: 1
  val px = with(LocalDensity.current) { size.toPx().roundToInt() }.coerceIn(16, 256).let { spritePx(it) } * scale
  var img by remember(sp, px) { mutableStateOf(sp?.let { PlanetSprites.cached(it, px) }) }
  LaunchedEffect(sp, px) { if (sp != null && img == null) img = PlanetSprites.load(ctx, sp, px) }
  Box(modifier.size(size)) {
    val bmp = img
    if (bmp != null) {
      // A ringed world's sprite is twice the disc across; drawn centred,
      // twice the size, so the disc itself is [size].
      Image(
        bitmap = bmp, contentDescription = null, alpha = alpha,
        modifier = Modifier.requiredSize(size * scale),
      )
    } else {
      Canvas(Modifier.fillMaxSize()) {
        drawCircle(fallback.copy(alpha = 0.55f * alpha), radius = this.size.minDimension / 2.4f)
      }
    }
  }
}

/** Sprites come in a few sizes only, so one world is not fetched at
 *  seven slightly different pixel widths across seven screens. */
private fun spritePx(px: Int): Int = when {
  px <= 32 -> 32
  px <= 64 -> 64
  px <= 96 -> 96
  px <= 128 -> 128
  else -> 192
}

/** A hull, as the game draws it: [key] is cls:variant:green|amber|red. */
@Composable
fun HullArt(key: String, size: Dp, modifier: Modifier = Modifier, rotation: Float = 0f, tint: ColorFilter? = null) {
  val ctx = LocalContext.current
  var img by remember(key) { mutableStateOf(ShipIcons.cached(key)) }
  LaunchedEffect(key) { if (img == null) img = ShipIcons.load(ctx, key) }
  val bmp = img
  if (bmp == null) {
    Box(modifier.size(size))
    return
  }
  Image(
    bitmap = bmp, contentDescription = null, colorFilter = tint,
    modifier = modifier.size(size).rotate(rotation),
  )
}

/**
 * A captain's face in a ring, or -- for a hull with no captain -- the hull
 * itself filling the slot. With a captain, the flagship's hull rides on the
 * face as a badge, bottom right: "Captains have faces" (the review).
 */
@Composable
fun CaptainBadge(captain: Captain?, hullKey: String, size: Dp, ring: Color = Trough) {
  val ctx = LocalContext.current
  val pid = captain?.portrait
  var face by remember(pid) { mutableStateOf(pid?.let { Portraits.cached(it) }) }
  LaunchedEffect(pid) { if (pid != null && face == null) face = Portraits.load(ctx, pid) }
  Box(Modifier.size(size)) {
    val f = face
    if (f != null) {
      Image(
        bitmap = f, contentDescription = captain?.name,
        modifier = Modifier.size(size).clip(CircleShape),
      )
      Canvas(Modifier.size(size)) {
        drawCircle(ring, radius = this.size.minDimension / 2f - 1.dp.toPx(), style = Stroke(1.5.dp.toPx()))
      }
      HullArt(hullKey, size * 0.62f, Modifier.offset(size * 0.5f, size * 0.5f))
    } else {
      HullArt(hullKey, size * 0.95f)
    }
  }
}

/** An empire's emblem in its colour, or a dot in it until one loads. */
@Composable
fun FlagArt(emblem: String?, color: Color, size: Dp, modifier: Modifier = Modifier) {
  val ctx = LocalContext.current
  val px = with(LocalDensity.current) { size.toPx().roundToInt() }.coerceIn(16, 128)
  var flag by remember(emblem, px) { mutableStateOf(emblem?.let { FlagIcons.cached(it, px) }) }
  LaunchedEffect(emblem, px) { if (emblem != null && flag == null) flag = FlagIcons.load(ctx, emblem, px) }
  val img = flag
  if (img == null) {
    Box(modifier.size(size), contentAlignment = androidx.compose.ui.Alignment.Center) {
      Box(Modifier.size(size * 0.55f).clip(CircleShape).background(color))
    }
  } else {
    Image(bitmap = img, contentDescription = null, modifier = modifier.size(size), colorFilter = ColorFilter.tint(color))
  }
}

/**
 * The last few readings of a pool, as a line. Oldest left. Flat when
 * there is nothing to compare, and nothing at all with under two points.
 */
@Composable
fun Sparkline(values: List<Double>, ink: Color, modifier: Modifier) {
  if (values.size < 2) {
    Box(modifier)
    return
  }
  Canvas(modifier) {
    val lo = values.min()
    val hi = values.max()
    val span = if (hi - lo <= 0.0) 1.0 else hi - lo
    val step = size.width / (values.size - 1)
    val path = androidx.compose.ui.graphics.Path()
    values.forEachIndexed { i, v ->
      val x = i * step
      val y = size.height - ((v - lo) / span).toFloat() * (size.height - 2.dp.toPx()) - 1.dp.toPx()
      if (i == 0) path.moveTo(x, y) else path.lineTo(x, y)
    }
    drawPath(path, ink.copy(alpha = 0.75f), style = Stroke(width = 1.4.dp.toPx(), cap = androidx.compose.ui.graphics.StrokeCap.Round, join = androidx.compose.ui.graphics.StrokeJoin.Round))
    val last = values.last()
    drawCircle(ink, radius = 1.8.dp.toPx(), center = Offset(size.width, size.height - ((last - lo) / span).toFloat() * (size.height - 2.dp.toPx()) - 1.dp.toPx()))
  }
}
