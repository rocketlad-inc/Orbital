package com.orbitalempire.wear

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RadialGradient
import android.graphics.RectF
import android.graphics.Shader
import android.graphics.Typeface
import androidx.core.content.res.ResourcesCompat
import com.orbitalempire.wear.SkyEngine.Body
import kotlin.math.abs
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt
import kotlin.math.sin

/**
 * THE SKY FACE'S BACKGROUND: your sky right now, as a picture.
 *
 * The horizon runs across the lower middle of the face; everything
 * above it is up. Across the face runs the compass, looking SOUTH in the
 * northern hemisphere (north in the southern), so east is on the left:
 * things rise on the left, climb through the middle and set on the
 * right, the way the sky actually turns in front of you. Height above
 * the line is altitude, horizon to zenith.
 *
 *   SKY      coloured by the Sun's altitude: day blue, a glow along the
 *            horizon at dusk and dawn, near-black at night
 *   STARS    the brightest stars and the figures anyone knows (the
 *            Dipper, Orion, Cassiopeia, the Southern Cross), fading in
 *            through twilight
 *   ECLIPTIC a dotted arc: the road the Sun, Moon and planets all travel
 *   BODIES   Sun, Moon in its real phase, planets in their colours,
 *            labelled; what is below the horizon waits as dim markers
 *            just under the line, so you can see what is coming up
 *
 * The lower part is left as dark ground for the face's clock and
 * complications (faces/skyface). Prototyped in a browser, where the
 * drawing and the engine were checked against JPL Horizons, then ported
 * line for line.
 */
object SkyRender {

  /** Fractions of the face: altitude 0 and altitude 90. The face's
   *  markup (skyface/res/raw/watchface.xml) is laid out against these. */
  const val HORIZON = 255f / 450f
  const val ZENITH = 34f / 450f

  /** Opaque, so 16-bit colour: a 400 px face crosses the binder at
   *  320 KB, sharper than the map's 320 px at 32-bit. */
  const val SIZE = 400

  private class Star(val raH: Double, val dec: Double, val mag: Double)

  private val STARS = mapOf(
    "sirius" to Star(6.7525, -16.716, -1.46), "canopus" to Star(6.3992, -52.696, -0.74),
    "arcturus" to Star(14.2610, 19.182, -0.05), "alphacen" to Star(14.6600, -60.834, -0.27),
    "vega" to Star(18.6156, 38.784, 0.03), "capella" to Star(5.2782, 45.998, 0.08),
    "rigel" to Star(5.2423, -8.202, 0.13), "procyon" to Star(7.6550, 5.225, 0.34),
    "achernar" to Star(1.6286, -57.237, 0.46), "betelgeuse" to Star(5.9195, 7.407, 0.50),
    "hadar" to Star(14.0637, -60.373, 0.61), "altair" to Star(19.8464, 8.868, 0.76),
    "acrux" to Star(12.4433, -63.099, 0.76), "aldebaran" to Star(4.5987, 16.509, 0.86),
    "antares" to Star(16.4901, -26.432, 0.96), "spica" to Star(13.4199, -11.161, 0.97),
    "pollux" to Star(7.7553, 28.026, 1.14), "fomalhaut" to Star(22.9608, -29.622, 1.16),
    "deneb" to Star(20.6905, 45.280, 1.25), "mimosa" to Star(12.7954, -59.689, 1.25),
    "regulus" to Star(10.1395, 11.967, 1.35), "castor" to Star(7.5767, 31.888, 1.58),
    "gacrux" to Star(12.5194, -57.113, 1.63), "bellatrix" to Star(5.4189, 6.350, 1.64),
    "alnilam" to Star(5.6036, -1.202, 1.69), "alnitak" to Star(5.6793, -1.943, 1.74),
    "mintaka" to Star(5.5334, -0.299, 2.23), "saiph" to Star(5.7959, -9.670, 2.07),
    "alioth" to Star(12.9005, 55.960, 1.76), "dubhe" to Star(11.0621, 61.751, 1.79),
    "alkaid" to Star(13.7923, 49.313, 1.85), "mizar" to Star(13.3988, 54.925, 2.23),
    "merak" to Star(11.0307, 56.382, 2.37), "phecda" to Star(11.8972, 53.695, 2.44),
    "megrez" to Star(12.2571, 57.033, 3.31), "polaris" to Star(2.5303, 89.264, 1.98),
    "schedar" to Star(0.6751, 56.537, 2.24), "caph" to Star(0.1529, 59.150, 2.28),
    "gammacas" to Star(0.9451, 60.717, 2.47), "ruchbah" to Star(1.4303, 60.235, 2.68),
    "segin" to Star(1.9066, 63.670, 3.37), "deltacru" to Star(12.2524, -58.749, 2.79),
  )

  private val LINES = listOf(
    "dubhe" to "merak", "merak" to "phecda", "phecda" to "megrez", "megrez" to "dubhe",
    "megrez" to "alioth", "alioth" to "mizar", "mizar" to "alkaid",
    "betelgeuse" to "bellatrix", "betelgeuse" to "alnitak", "bellatrix" to "mintaka",
    "alnitak" to "alnilam", "alnilam" to "mintaka", "alnitak" to "saiph", "mintaka" to "rigel",
    "caph" to "schedar", "schedar" to "gammacas", "gammacas" to "ruchbah", "ruchbah" to "segin",
    "acrux" to "gacrux", "mimosa" to "deltacru",
  )

  private class Style(val r: Float, val color: Int)

  private val STYLE = mapOf(
    Body.SUN to Style(10f, 0xffffd75a.toInt()),
    Body.MOON to Style(9f, 0xfff0efe6.toInt()),
    Body.MERCURY to Style(3.2f, 0xffc9bfae.toInt()),
    Body.VENUS to Style(5f, 0xfffff6d8.toInt()),
    Body.MARS to Style(4.2f, 0xffff6b4a.toInt()),
    Body.JUPITER to Style(5.2f, 0xfff2dcb0.toInt()),
    Body.SATURN to Style(4.4f, 0xffead08a.toInt()),
    Body.URANUS to Style(2.6f, 0xff9fe6ea.toInt()),
    Body.NEPTUNE to Style(2.6f, 0xff7d9bff.toInt()),
  )

  /** Sky colour by the Sun's altitude: (altitude, top, horizon). */
  private val SKY = listOf(
    Triple(-90.0, 0xff02040a.toInt(), 0xff070c18.toInt()),
    Triple(-18.0, 0xff03060d.toInt(), 0xff0a1122.toInt()),
    Triple(-12.0, 0xff070c1c.toInt(), 0xff18203f.toInt()),
    Triple(-6.0, 0xff0f1a38.toInt(), 0xff433f6b.toInt()),
    Triple(-2.0, 0xff1a2c55.toInt(), 0xffc46a45.toInt()),
    Triple(2.0, 0xff27508f.toInt(), 0xffe6a268.toInt()),
    Triple(8.0, 0xff2c65ac.toInt(), 0xff9cc3e6.toInt()),
    Triple(90.0, 0xff2a67b3.toInt(), 0xff8dbde8.toInt()),
  )

  private fun mix(a: Int, b: Int, t: Double): Int {
    fun ch(x: Int, y: Int) = (x + (y - x) * t).roundToInt()
    return Color.rgb(
      ch(Color.red(a), Color.red(b)), ch(Color.green(a), Color.green(b)), ch(Color.blue(a), Color.blue(b)),
    )
  }

  private fun skyColors(sunAlt: Double): Pair<Int, Int> {
    for (i in 0 until SKY.size - 1) {
      val (a0, t0, h0) = SKY[i]
      val (a1, t1, h1) = SKY[i + 1]
      if (sunAlt <= a1) {
        val t = ((sunAlt - a0) / (a1 - a0)).coerceIn(0.0, 1.0)
        return mix(t0, t1, t) to mix(h0, h1, t)
      }
    }
    return SKY.last().second to SKY.last().third
  }

  private class Pt(val x: Float, val y: Float)

  private fun project(alt: Double, az: Double, s: Float, south: Boolean): Pt {
    val facing = if (south) 180.0 else 0.0
    val d = ((az - facing + 540.0) % 360.0) - 180.0
    val x = s / 2 + (d / 180.0).toFloat() * (s / 2)
    val h = s * HORIZON
    val top = s * ZENITH
    val y = if (alt >= 0) h - (alt / 90.0).toFloat() * (h - top)
    else h + 7f + min(1.0, -alt / 90.0).toFloat() * 18f
    return Pt(x, y)
  }

  private var typeface: Typeface? = null
  private fun font(c: Context): Typeface =
    typeface ?: (try { ResourcesCompat.getFont(c, R.font.audiowide) } catch (t: Throwable) { null } ?: Typeface.DEFAULT)
      .also { typeface = it }

  /** The sky at [ms] for an observer, or a prompt to set a location. */
  fun render(c: Context, ms: Long, fix: SkyLocation.Fix?, size: Int = SIZE): Bitmap {
    val bmp = Bitmap.createBitmap(size, size, Bitmap.Config.RGB_565)
    val cv = Canvas(bmp)
    if (fix == null) {
      drawNoLocation(c, cv, size.toFloat())
    } else {
      draw(c, cv, size.toFloat(), ms, fix.lat, fix.lon)
    }
    return bmp
  }

  private fun drawGround(cv: Canvas, s: Float, lineColor: Int) {
    val h = s * HORIZON
    val p = Paint(Paint.ANTI_ALIAS_FLAG).apply { isDither = true }
    p.shader = LinearGradient(0f, h, 0f, s, 0xff0e1319.toInt(), 0xff040609.toInt(), Shader.TileMode.CLAMP)
    cv.drawRect(0f, h, s, s, p)
    p.shader = null
    p.color = lineColor
    p.strokeWidth = 1.2f
    cv.drawLine(0f, h, s, h, p)
  }

  private fun drawNoLocation(c: Context, cv: Canvas, s: Float) {
    val h = s * HORIZON
    val p = Paint(Paint.ANTI_ALIAS_FLAG).apply { isDither = true }
    p.shader = LinearGradient(0f, s * ZENITH * 0.3f, 0f, h, 0xff03060d.toInt(), 0xff0a1122.toInt(), Shader.TileMode.CLAMP)
    cv.drawRect(0f, 0f, s, h, p)
    p.shader = null
    drawGround(cv, s, 0x9978_8ca5.toInt())
    p.typeface = font(c)
    p.textAlign = Paint.Align.CENTER
    p.color = 0xffe2ecf5.toInt()
    p.textSize = s * 0.045f
    cv.drawText("TAP TO SET", s / 2, h * 0.52f, p)
    cv.drawText("YOUR LOCATION", s / 2, h * 0.52f + s * 0.06f, p)
    p.color = 0xff7d92a6.toInt()
    p.textSize = s * 0.028f
    cv.drawText("the sky is drawn for where you stand", s / 2, h * 0.52f + s * 0.12f, p)
  }

  private fun draw(c: Context, cv: Canvas, s: Float, ms: Long, lat: Double, lon: Double) {
    val south = lat >= 0
    val h = s * HORIZON
    val pos = Body.values().associateWith { SkyEngine.position(it, ms, lat, lon) }
    val sunAlt = pos.getValue(Body.SUN).alt
    val p = Paint(Paint.ANTI_ALIAS_FLAG).apply { isDither = true }

    // Sky, then the Sun's glow along the horizon near dusk and dawn.
    val (top, hor) = skyColors(sunAlt)
    p.shader = LinearGradient(0f, s * ZENITH * 0.3f, 0f, h, top, hor, Shader.TileMode.CLAMP)
    cv.drawRect(0f, 0f, s, h, p)
    if (sunAlt > -12 && sunAlt < 12) {
      val sp = project(max(0.0, sunAlt), pos.getValue(Body.SUN).az, s, south)
      val k = 1 - abs(sunAlt) / 12
      p.shader = RadialGradient(
        sp.x, h, s * 0.45f,
        Color.argb((0.45 * k * 255).roundToInt(), 255, 170, 90), Color.argb(0, 255, 170, 90),
        Shader.TileMode.CLAMP,
      )
      cv.drawRect(0f, 0f, s, h, p)
    }
    p.shader = null

    // Stars and figures, fading in through twilight.
    val starA = ((-sunAlt - 4) / 10).coerceIn(0.0, 1.0)
    if (starA > 0) {
      val sp = HashMap<String, Pair<Pt, Double>>()
      for ((k, st) in STARS) {
        val hh = SkyEngine.altAz(st.raH * 15, st.dec, ms, lat, lon)
        if (hh.alt > 0) sp[k] = project(hh.alt, hh.az, s, south) to st.mag
      }
      p.style = Paint.Style.STROKE
      p.strokeWidth = 0.8f
      p.color = Color.argb((0.22 * starA * 255).roundToInt(), 140, 170, 210)
      for ((a, b) in LINES) {
        val pa = sp[a]?.first ?: continue
        val pb = sp[b]?.first ?: continue
        if (abs(pa.x - pb.x) > s * 0.4f) continue
        cv.drawLine(pa.x, pa.y, pb.x, pb.y, p)
      }
      p.style = Paint.Style.FILL
      for ((pt, mag) in sp.values) {
        val a = starA * max(0.35, min(1.0, 1 - mag * 0.18))
        p.color = Color.argb((a * 255).roundToInt(), 235, 242, 255)
        cv.drawCircle(pt.x, pt.y, max(0.7, 2.0 - 0.42 * mag).toFloat(), p)
      }
    }

    // The ecliptic: the road the Sun, Moon and planets all travel.
    val t = SkyEngine.centuries(ms)
    p.color = Color.argb(71, 255, 214, 130)
    var l = 0.0
    while (l < 360.0) {
      val eq = SkyEngine.eclToEq(l, 0.0, t)
      val hh = SkyEngine.altAz(eq[0], eq[1], ms, lat, lon)
      if (hh.alt > 0.5) {
        val q = project(hh.alt, hh.az, s, south)
        cv.drawCircle(q.x, q.y, 0.8f, p)
      }
      l += 2.5
    }

    // The ground, and the horizon line.
    drawGround(cv, s, if (sunAlt > 0) Color.argb(140, 210, 225, 240) else Color.argb(153, 120, 140, 165))

    // Compass points along the horizon.
    p.typeface = font(c)
    p.textSize = (s * 0.026f).roundToInt().toFloat()
    p.textAlign = Paint.Align.CENTER
    p.color = if (sunAlt > 0) Color.argb(191, 20, 35, 60) else Color.argb(204, 120, 140, 165)
    val cards = if (south) listOf("E" to 90.0, "SE" to 135.0, "S" to 180.0, "SW" to 225.0, "W" to 270.0)
    else listOf("W" to 270.0, "NW" to 315.0, "N" to 0.0, "NE" to 45.0, "E" to 90.0)
    for ((name, az) in cards) cv.drawText(name, project(0.0, az, s, south).x, h - 4, p)

    // The bodies. Every glyph first, then every label, so no glyph lands
    // on a label placed before it (close pairs are common).
    val order = listOf(
      Body.NEPTUNE, Body.URANUS, Body.MERCURY, Body.MARS, Body.SATURN,
      Body.JUPITER, Body.VENUS, Body.MOON, Body.SUN,
    )
    val sunP = project(pos.getValue(Body.SUN).alt, pos.getValue(Body.SUN).az, s, south)
    val labelSize = (s * 0.03f).roundToInt().toFloat()

    class Shown(val b: Body, val up: Boolean, val pt: Pt, val r: Float)
    val shown = order.mapNotNull { b ->
      val up = pos.getValue(b).alt > 0
      if (!up && (b == Body.SUN || b == Body.URANUS || b == Body.NEPTUNE)) null
      else Shown(b, up, project(pos.getValue(b).alt, pos.getValue(b).az, s, south), if (up) STYLE.getValue(b).r else 2.6f)
    }
    val placed = shown.map {
      val pad = if (it.b == Body.SATURN) it.r * 2.1f else it.r
      RectF(it.pt.x - pad - 1, it.pt.y - it.r - 1, it.pt.x + pad + 1, it.pt.y + it.r + 1)
    }.toMutableList()

    for (sh in shown) {
      val st = STYLE.getValue(sh.b)
      val x = sh.pt.x; val y = sh.pt.y
      if (!sh.up) {
        p.style = Paint.Style.STROKE
        p.strokeWidth = 1f
        p.color = Color.argb(140, 120, 140, 165)
        cv.drawCircle(x, y, 2.6f, p)
        p.style = Paint.Style.FILL
        continue
      }
      when (sh.b) {
        Body.SUN -> {
          p.shader = RadialGradient(x, y, st.r * 3, Color.argb(140, 255, 220, 120), Color.argb(0, 255, 220, 120), Shader.TileMode.CLAMP)
          cv.drawCircle(x, y, st.r * 3, p)
          p.shader = null
          p.color = st.color
          cv.drawCircle(x, y, st.r, p)
        }
        Body.MOON -> {
          val ph = SkyEngine.moonPhase(ms)
          drawMoon(cv, x, y, st.r, ph.fraction, sunP.x - x, sunP.y - y)
        }
        else -> {
          p.color = st.color
          cv.drawCircle(x, y, st.r, p)
          if (sh.b == Body.SATURN) {
            p.style = Paint.Style.STROKE
            p.strokeWidth = 1.1f
            cv.save()
            cv.rotate(-20f, x, y)
            cv.drawOval(RectF(x - st.r * 2.1f, y - st.r * 0.7f, x + st.r * 2.1f, y + st.r * 0.7f), p)
            cv.restore()
            p.style = Paint.Style.FILL
          }
        }
      }
    }

    // Labels, brightest first so they get the best spots.
    p.textAlign = Paint.Align.LEFT
    for (sh in shown.reversed()) {
      val st = STYLE.getValue(sh.b)
      val size = if (sh.up) labelSize else (labelSize * 0.8f).roundToInt().toFloat()
      p.textSize = size
      val text = if (sh.up) sh.b.label else sh.b.label.take(2)
      val tw = p.measureText(text)
      val gap = (if (sh.up) (if (sh.b == Body.SATURN) st.r * 2.1f else st.r) else 2.6f) + 3f
      val tries = if (sh.up) listOf(
        Triple(gap, size * 0.35f, 'L'), Triple(-gap, size * 0.35f, 'R'),
        Triple(0f, -gap - 2f, 'C'), Triple(0f, gap + size, 'C'),
      ) else listOf(Triple(gap, size * 0.35f, 'L'), Triple(-gap, size * 0.35f, 'R'))
      for ((dx, dy, align) in tries) {
        val x0 = when (align) {
          'L' -> sh.pt.x + dx
          'R' -> sh.pt.x + dx - tw
          else -> sh.pt.x - tw / 2
        }
        val box = RectF(x0 - 1, sh.pt.y + dy - size, x0 + tw + 1, sh.pt.y + dy + 2)
        val clash = placed.any { RectF.intersects(it, box) }
        val inside = hypot(box.centerX() - s / 2, box.centerY() - s / 2) < s / 2 - 8
        if (clash || !inside) continue
        p.color = when {
          !sh.up -> Color.argb(191, 120, 140, 165)
          sunAlt > 0 -> Color.argb(230, 15, 25, 45)
          else -> Color.argb(235, 220, 230, 242)
        }
        cv.drawText(text, x0, sh.pt.y + dy, p)
        placed.add(box)
        break
      }
    }
  }

  /** The Moon, lit on the side facing the Sun, in its real phase. */
  private fun drawMoon(cv: Canvas, x: Float, y: Float, r: Float, frac: Double, sunDx: Float, sunDy: Float) {
    val p = Paint(Paint.ANTI_ALIAS_FLAG)
    cv.save()
    cv.translate(x, y)
    cv.rotate(Math.toDegrees(atan2(sunDy.toDouble(), sunDx.toDouble())).toFloat())
    p.color = 0xff2b3038.toInt()
    cv.drawCircle(0f, 0f, r, p)
    val w = r * (2 * frac - 1).toFloat()
    val path = Path()
    path.moveTo(0f, -r)
    path.arcTo(RectF(-r, -r, r, r), -90f, 180f, false)
    var a = 90
    while (a >= -90) {
      val rad = Math.toRadians(a.toDouble())
      path.lineTo((-w * cos(rad)).toFloat(), (r * sin(rad)).toFloat())
      a -= 6
    }
    path.close()
    p.color = 0xfff0efe6.toInt()
    cv.drawPath(path, p)
    cv.restore()
  }
}
