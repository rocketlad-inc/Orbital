package com.orbitalempire.wear

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Typeface
import android.util.Base64
import androidx.compose.ui.graphics.toArgb
import androidx.wear.protolayout.ActionBuilders
import androidx.wear.protolayout.ColorBuilders.argb
import androidx.wear.protolayout.DimensionBuilders.dp
import androidx.wear.protolayout.DimensionBuilders.sp
import androidx.wear.protolayout.LayoutElementBuilders
import androidx.wear.protolayout.ModifiersBuilders
import androidx.wear.protolayout.ResourceBuilders
import java.io.ByteArrayOutputStream
import kotlin.math.ceil

/**
 * The pieces every Orbital tile is built from.
 *
 * THE MIX, as Lorne chose it: a tile cannot set text in a custom font --
 * ProtoLayout offers the watch's system faces and nothing else -- so the
 * headline numbers and titles are DRAWN in Audiowide into images, and
 * the small labels stay live system text. The big type is the game's;
 * the fine print stays crisp, cheap and readable at the watch's own
 * text size.
 *
 * AN IMAGE'S ID IS ITS RECIPE. The id encodes the text, size and colour,
 * and the tile's resources version is the list of ids, so the renderer
 * can redraw any tile's images from the version string alone. Nothing
 * has to survive between the layout request and the resources request,
 * which matters because the system may kill this process between them.
 */
object TileKit {

  private const val VERSION_PREFIX = "a1:"
  private const val ID_SEP = "~"

  private var face: Typeface? = null

  fun audiowide(c: Context): Typeface =
    face ?: c.resources.getFont(R.font.audiowide).also { face = it }

  /** Tracks every Audiowide image a layout uses, in order. */
  class Images(private val c: Context) {
    val ids = LinkedHashSet<String>()

    /** An Audiowide rendering of [text], sized in sp, as a layout element. */
    fun text(text: String, sizeSp: Float, color: Int, description: String? = null): LayoutElementBuilders.LayoutElement {
      val id = idFor(text, sizeSp, color)
      ids += id
      val (wPx, hPx) = measure(c, text, sizeSp)
      val density = c.resources.displayMetrics.density
      return LayoutElementBuilders.Image.Builder()
        .setResourceId(id)
        .setWidth(dp(wPx / density))
        .setHeight(dp(hPx / density))
        .setModifiers(
          ModifiersBuilders.Modifiers.Builder()
            .setSemantics(
              ModifiersBuilders.Semantics.Builder()
                .setContentDescription(description ?: text)
                .build(),
            )
            .build(),
        )
        .build()
    }

    fun version(): String = VERSION_PREFIX + ids.joinToString(ID_SEP)
  }

  /** Every image a resources version names, rendered. */
  fun resources(c: Context, version: String): ResourceBuilders.Resources {
    val b = ResourceBuilders.Resources.Builder().setVersion(version)
    if (!version.startsWith(VERSION_PREFIX)) return b.build()
    for (id in version.removePrefix(VERSION_PREFIX).split(ID_SEP)) {
      if (id.isEmpty()) continue
      val recipe = decode(id) ?: continue
      val png = render(c, recipe.text, recipe.sizeSp, recipe.color) ?: continue
      b.addIdToImageMapping(
        id,
        ResourceBuilders.ImageResource.Builder()
          .setInlineResource(
            ResourceBuilders.InlineImageResource.Builder()
              .setData(png.bytes)
              .setWidthPx(png.w)
              .setHeightPx(png.h)
              .setFormat(ResourceBuilders.IMAGE_FORMAT_UNDEFINED)
              .build(),
          )
          .build(),
      )
    }
    return b.build()
  }

  private data class Recipe(val text: String, val sizeSp: Float, val color: Int)
  private class Png(val bytes: ByteArray, val w: Int, val h: Int)

  private fun idFor(text: String, sizeSp: Float, color: Int): String {
    val raw = "$sizeSp|${Integer.toHexString(color)}|$text"
    return Base64.encodeToString(raw.toByteArray(Charsets.UTF_8), Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP)
  }

  private fun decode(id: String): Recipe? = try {
    val raw = String(Base64.decode(id, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP), Charsets.UTF_8)
    val a = raw.indexOf('|')
    val b = raw.indexOf('|', a + 1)
    Recipe(raw.substring(b + 1), raw.substring(0, a).toFloat(), java.lang.Long.parseLong(raw.substring(a + 1, b), 16).toInt())
  } catch (t: Throwable) {
    null
  }

  private fun paint(c: Context, sizeSp: Float, color: Int = 0xFFFFFFFF.toInt()) = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    typeface = audiowide(c)
    textSize = sizeSp * c.resources.displayMetrics.density
    this.color = color
  }

  private fun measure(c: Context, text: String, sizeSp: Float): Pair<Int, Int> {
    val p = paint(c, sizeSp)
    val fm = p.fontMetrics
    val w = ceil(p.measureText(text)).toInt() + 2
    val h = ceil(fm.descent - fm.ascent).toInt()
    return w.coerceAtLeast(1) to h.coerceAtLeast(1)
  }

  private fun render(c: Context, text: String, sizeSp: Float, color: Int): Png? = try {
    val (w, h) = measure(c, text, sizeSp)
    val p = paint(c, sizeSp, color)
    val bmp = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
    Canvas(bmp).drawText(text, 1f, -p.fontMetrics.ascent, p)
    val out = ByteArrayOutputStream()
    bmp.compress(Bitmap.CompressFormat.PNG, 100, out)
    bmp.recycle()
    Png(out.toByteArray(), w, h)
  } catch (t: Throwable) {
    null
  }

  // ---- live system text, the other half of the mix ----------------------

  fun label(
    text: String,
    sizeSp: Float,
    color: Int,
    bold: Boolean = false,
    maxLines: Int = 1,
  ): LayoutElementBuilders.LayoutElement =
    LayoutElementBuilders.Text.Builder()
      .setText(text)
      .setMaxLines(maxLines)
      .setMultilineAlignment(LayoutElementBuilders.TEXT_ALIGN_CENTER)
      .setOverflow(LayoutElementBuilders.TEXT_OVERFLOW_ELLIPSIZE_END)
      .setFontStyle(
        LayoutElementBuilders.FontStyle.Builder()
          .setSize(sp(sizeSp))
          .setColor(argb(color))
          .setWeight(if (bold) LayoutElementBuilders.FONT_WEIGHT_BOLD else LayoutElementBuilders.FONT_WEIGHT_NORMAL)
          .build(),
      )
      .build()

  fun spacer(h: Float): LayoutElementBuilders.LayoutElement =
    LayoutElementBuilders.Spacer.Builder().setHeight(dp(h)).build()

  fun gap(w: Float): LayoutElementBuilders.LayoutElement =
    LayoutElementBuilders.Spacer.Builder().setWidth(dp(w)).build()

  /** One solid block, for a stacked bar (Territory). */
  fun block(w: Float, h: Float, color: Int): LayoutElementBuilders.LayoutElement =
    LayoutElementBuilders.Box.Builder()
      .setWidth(dp(w))
      .setHeight(dp(h))
      .setModifiers(
        ModifiersBuilders.Modifiers.Builder()
          .setBackground(ModifiersBuilders.Background.Builder().setColor(argb(color)).build())
          .build(),
      )
      .build()

  /**
   * A progress bar, [w] dp wide, filled [frac] of the way.
   *
   * ProtoLayout has no progress element that is not an arc, and an arc
   * inside a tile's column fights the tile's own layout; two boxes, one
   * inside the other, is the whole thing.
   */
  fun bar(w: Float, frac: Float, fill: Int, trough: Int, h: Float = 4f): LayoutElementBuilders.LayoutElement {
    val filled = (w * frac.coerceIn(0f, 1f)).coerceAtLeast(if (frac > 0f) 2f else 0f)
    val box = LayoutElementBuilders.Box.Builder()
      .setWidth(dp(w))
      .setHeight(dp(h))
      .setHorizontalAlignment(LayoutElementBuilders.HORIZONTAL_ALIGN_START)
      .setModifiers(
        ModifiersBuilders.Modifiers.Builder()
          .setBackground(
            ModifiersBuilders.Background.Builder()
              .setColor(argb(trough))
              .setCorner(ModifiersBuilders.Corner.Builder().setRadius(dp(h / 2)).build())
              .build(),
          )
          .build(),
      )
    if (filled > 0f) {
      box.addContent(
        LayoutElementBuilders.Box.Builder()
          .setWidth(dp(filled))
          .setHeight(dp(h))
          .setModifiers(
            ModifiersBuilders.Modifiers.Builder()
              .setBackground(
                ModifiersBuilders.Background.Builder()
                  .setColor(argb(fill))
                  .setCorner(ModifiersBuilders.Corner.Builder().setRadius(dp(h / 2)).build())
                  .build(),
              )
              .build(),
          )
          .build(),
      )
    }
    return box.build()
  }

  /** Opens the app on [page] (0 empire, 1 battles, 2 senate). */
  fun openApp(c: Context, page: Int, id: String = "open:$page"): ModifiersBuilders.Clickable =
    ModifiersBuilders.Clickable.Builder()
      .setId(id)
      .setOnClick(
        ActionBuilders.LaunchAction.Builder()
          .setAndroidActivity(
            ActionBuilders.AndroidActivity.Builder()
              .setPackageName(c.packageName)
              .setClassName(MainActivity::class.java.name)
              .addKeyToExtraMapping(MainActivity.EXTRA_PAGE, ActionBuilders.AndroidIntExtra.Builder().setValue(page).build())
              .build(),
          )
          .build(),
      )
      .build()

  /** Re-requests the tile with this clickable's id, handled in the service. */
  fun reload(id: String): ModifiersBuilders.Clickable =
    ModifiersBuilders.Clickable.Builder()
      .setId(id)
      .setOnClick(ActionBuilders.LoadAction.Builder().build())
      .build()

  fun argbOf(c: androidx.compose.ui.graphics.Color): Int = c.toArgb()

  fun colorOf(hex: String): Int = argbOf(factionColor(hex))
}
