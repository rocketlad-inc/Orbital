package com.orbitalempire.wear

import android.graphics.Paint
import android.graphics.PathMeasure
import android.graphics.RectF
import androidx.compose.animation.core.Animatable
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.drawIntoCanvas
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalContext
import kotlin.math.cos
import kotlin.math.sin

/**
 * THE RIM IS THE WATCH'S MOST VALUABLE REAL ESTATE, and the old screens
 * left it empty. Here it carries four things, each where the eye already
 * goes on a round face:
 *
 *   - the TICK RING: how far through this tick the game is, all the way
 *     round, so every page answers "how long have I got";
 *   - the TOP ARC: what this screen is, curved to the bezel;
 *   - the BOTTOM ARC: the page names -- the one before, this one lit, the
 *     one after -- so the five pages are named instead of dotted;
 *   - the HOLD RING: a held order fills the rim itself, not a bar inside
 *     the button, so the thumb on the button never hides the progress.
 */
object Rim {
  /** The rim stroke, as a fraction of the screen's width. */
  const val RING = 0.022f
}

/**
 * Text laid along the top of the rim, reading left to right.
 *
 * IT FITS ITS ARC. A title may use the top 100 degrees of the rim and no
 * more: "CANTERBURY · AT PHOBOS" at full size ran down the side of the
 * face into the stance buttons. Too long, it is set smaller (to 70% of
 * the size asked for), and past that it is cut with an ellipsis.
 */
fun DrawScope.rimTextTop(text: String, color: Color, sizePx: Float, inset: Float, typeface: android.graphics.Typeface?, letterSpacing: Float = 0.06f) {
  val r0 = size.minDimension / 2f - inset - sizePx
  val room = (2 * Math.PI * r0 * (100.0 / 360.0)).toFloat()
  val probe = rimPaint(sizePx, typeface, letterSpacing)
  var px = sizePx
  var shown = text
  val w0 = probe.measureText(text)
  if (w0 > room) {
    px = (sizePx * room / w0).coerceAtLeast(sizePx * 0.7f)
    val p2 = rimPaint(px, typeface, letterSpacing)
    while (shown.length > 3 && p2.measureText(shown) > room) shown = shown.dropLast(2).trimEnd() + "…"
  }
  val r = size.minDimension / 2f - inset - px
  val c = center
  val path = android.graphics.Path().apply { addArc(RectF(c.x - r, c.y - r, c.x + r, c.y + r), 180f, 180f) }
  drawOnPath(shown, path, color, px, typeface, letterSpacing)
}

/** Text laid along the bottom of the rim, reading left to right. */
fun DrawScope.rimTextBottom(parts: List<Pair<String, Color>>, sizePx: Float, inset: Float, typeface: android.graphics.Typeface?, letterSpacing: Float = 0.12f) {
  val r = size.minDimension / 2f - inset
  val c = center
  // Counter-clockwise from 9 o'clock through 6 to 3: left to right along
  // the bottom, so the glyphs stand upright, heads toward the centre.
  val path = android.graphics.Path().apply { addArc(RectF(c.x - r, c.y - r, c.x + r, c.y + r), 180f, -180f) }
  val paint = rimPaint(sizePx, typeface, letterSpacing)
  val widths = parts.map { paint.measureText(it.first) }
  val len = PathMeasure(path, false).length
  var off = (len - widths.sum()) / 2f
  drawIntoCanvas { canvas ->
    for ((i, p) in parts.withIndex()) {
      paint.color = p.second.toArgb()
      canvas.nativeCanvas.drawTextOnPath(p.first, path, off, 0f, paint)
      off += widths[i]
    }
  }
}

private fun DrawScope.drawOnPath(text: String, path: android.graphics.Path, color: Color, sizePx: Float, typeface: android.graphics.Typeface?, letterSpacing: Float) {
  val paint = rimPaint(sizePx, typeface, letterSpacing).apply { this.color = color.toArgb() }
  val len = PathMeasure(path, false).length
  val w = paint.measureText(text)
  drawIntoCanvas { it.nativeCanvas.drawTextOnPath(text, path, ((len - w) / 2f).coerceAtLeast(0f), 0f, paint) }
}

private fun rimPaint(sizePx: Float, typeface: android.graphics.Typeface?, letterSpacing: Float) = Paint(Paint.ANTI_ALIAS_FLAG).apply {
  textSize = sizePx
  this.typeface = typeface
  this.letterSpacing = letterSpacing
}

/** A ring round the rim, [frac] of it lit from twelve o'clock. */
fun DrawScope.rimRing(frac: Float, ink: Color, trough: Color = Trough, widthPx: Float = size.minDimension * Rim.RING) {
  val r = size.minDimension / 2f - widthPx / 2f
  val tl = Offset(center.x - r, center.y - r)
  val sz = Size(r * 2, r * 2)
  drawArc(trough, 0f, 360f, false, tl, sz, style = Stroke(widthPx))
  if (frac > 0f) drawArc(ink, -90f, 360f * frac.coerceIn(0f, 1f), false, tl, sz, style = Stroke(widthPx, cap = StrokeCap.Round))
}

/**
 * An arc of the rim as a SLIDER: from [fromDeg] to [toDeg] (degrees
 * clockwise from three o'clock, as Android counts them), filled to
 * [frac], with a knob at the fill's end.
 */
fun DrawScope.rimSlider(fromDeg: Float, toDeg: Float, frac: Float, ink: Color, widthPx: Float, inset: Float) {
  val r = size.minDimension / 2f - inset - widthPx / 2f
  val tl = Offset(center.x - r, center.y - r)
  val sz = Size(r * 2, r * 2)
  val sweep = toDeg - fromDeg
  drawArc(Trough, fromDeg, sweep, false, tl, sz, style = Stroke(widthPx, cap = StrokeCap.Round))
  val f = frac.coerceIn(0f, 1f)
  if (f > 0f) drawArc(ink, fromDeg, sweep * f, false, tl, sz, style = Stroke(widthPx, cap = StrokeCap.Round))
  val a = Math.toRadians((fromDeg + sweep * f).toDouble())
  val k = Offset(center.x + r * cos(a).toFloat(), center.y + r * sin(a).toFloat())
  drawCircle(Ground, radius = widthPx * 1.1f, center = k)
  drawCircle(if (f > 0f) ink else Dim, radius = widthPx * 0.8f, center = k)
}

/**
 * THE HOLD RING. One per app, drawn over everything; a HoldButton anywhere
 * below fills it while held. [label] is what the ring is confirming, shown
 * on the top arc while the hold is in progress ("HOLD TO RETREAT").
 */
class RimHold {
  val progress = Animatable(0f)
  var tint by mutableStateOf(Good)
  var label by mutableStateOf<String?>(null)
}

val LocalRimHold = staticCompositionLocalOf<RimHold?> { null }

@Composable
fun RimHoldRing(h: RimHold) {
  val ctx = LocalContext.current
  val typeface = remember { TileKit.audiowide(ctx.applicationContext) }
  Canvas(Modifier.fillMaxSize()) {
    val p = h.progress.value
    if (p <= 0f) return@Canvas
    val w = size.minDimension * 0.035f
    val r = size.minDimension / 2f - w / 2f
    val tl = Offset(center.x - r, center.y - r)
    val sz = Size(r * 2, r * 2)
    drawArc(h.tint.copy(alpha = 0.22f), 0f, 360f, false, tl, sz, style = Stroke(w))
    drawArc(h.tint, -90f, 360f * p, false, tl, sz, style = Stroke(w, cap = StrokeCap.Round))
    h.label?.let { rimTextTop(it, h.tint, size.minDimension * 0.052f, w * 1.6f, typeface) }
  }
}
