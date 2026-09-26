package com.orbitalempire.wear

import android.app.PendingIntent
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.graphics.drawable.Icon
import android.text.format.DateFormat
import android.util.Log
import androidx.wear.watchface.complications.data.ComplicationData
import androidx.wear.watchface.complications.data.ComplicationType
import androidx.wear.watchface.complications.data.LongTextComplicationData
import androidx.wear.watchface.complications.data.MonochromaticImage
import androidx.wear.watchface.complications.data.NoDataComplicationData
import androidx.wear.watchface.complications.data.PhotoImageComplicationData
import androidx.wear.watchface.complications.data.PlainComplicationText
import androidx.wear.watchface.complications.data.RangedValueComplicationData
import androidx.wear.watchface.complications.data.ShortTextComplicationData
import androidx.wear.watchface.complications.datasource.ComplicationDataSourceUpdateRequester
import androidx.wear.watchface.complications.datasource.ComplicationRequest
import androidx.wear.watchface.complications.datasource.SuspendingComplicationDataSourceService
import com.orbitalempire.wear.SkyEngine.Body
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import kotlin.math.roundToInt

/**
 * THE SKY'S COMPLICATIONS, for the Orbital Sky face (faces/skyface) and
 * for any other face that wants them:
 *
 *   SKY      the whole sky as a picture, the face's background
 *   SUN      the next sunset or sunrise
 *   MOON     the phase, as a percentage lit and a name, the Moon drawn
 *   CLOUDS   temperature and cloud cover (Open-Meteo)
 *   PLANETS  which of the five bright planets are above the horizon
 *   DARK     when the sky is properly dark (astronomical twilight ends),
 *            or when it stops being dark
 *
 * All of it but the weather is computed on the watch from the saved
 * location (SkyLocation) and needs no network. Tapping any of them
 * opens the Sky screen, which is also where the location is granted.
 */
object SkyComplications {

  private val ALL = listOf(
    SkyComplication::class.java, SunComplication::class.java, MoonComplication::class.java,
    CloudComplication::class.java, PlanetsComplication::class.java, DarkComplication::class.java,
  )

  fun refreshAll(c: Context) {
    for (cls in ALL) {
      try {
        ComplicationDataSourceUpdateRequester.create(c, ComponentName(c, cls)).requestUpdateAll()
      } catch (t: Throwable) {
        Log.w("OrbitalSky", "complication refresh failed for ${cls.simpleName}", t)
      }
    }
  }

  fun open(c: Context): PendingIntent = PendingIntent.getActivity(
    c,
    7301,
    Intent(c, SkyActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP),
    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
  )

  /** A clock time as the watch shows times: 7:42 or 19:42, no AM/PM
   *  (a complication has seven characters, and the face shows the hour). */
  fun clock(c: Context, ms: Long): String =
    SimpleDateFormat(if (DateFormat.is24HourFormat(c)) "H:mm" else "h:mm", Locale.getDefault()).format(Date(ms))
}

private fun skyText(s: String) = PlainComplicationText.Builder(s).build()

/** Shared plumbing: the saved fix, the tap into the Sky screen, an icon,
 *  and a slot that says "set location" rather than going blank. */
abstract class SkyComplicationBase : SuspendingComplicationDataSourceService() {

  protected abstract val title: String
  protected abstract val iconRes: Int

  protected fun icon(): MonochromaticImage =
    MonochromaticImage.Builder(Icon.createWithResource(this, iconRes)).build()

  protected fun needsLocation(type: ComplicationType): ComplicationData = when (type) {
    ComplicationType.LONG_TEXT -> LongTextComplicationData.Builder(skyText("Tap to set location"), skyText("Set a location for the sky"))
      .setTitle(skyText(title)).setMonochromaticImage(icon()).setTapAction(SkyComplications.open(this)).build()
    ComplicationType.RANGED_VALUE -> RangedValueComplicationData.Builder(0f, 0f, 1f, skyText("Set a location for the sky"))
      .setText(skyText("SET")).setTitle(skyText(title)).setMonochromaticImage(icon()).setTapAction(SkyComplications.open(this)).build()
    else -> ShortTextComplicationData.Builder(skyText("SET"), skyText("Set a location for the sky"))
      .setTitle(skyText("LOCATION")).setMonochromaticImage(icon()).setTapAction(SkyComplications.open(this)).build()
  }

  override suspend fun onComplicationRequest(request: ComplicationRequest): ComplicationData? = try {
    val fix = SkyLocation.saved(this)
    if (fix == null) needsLocation(request.complicationType) else build(request.complicationType, fix, System.currentTimeMillis())
  } catch (t: Throwable) {
    Log.w("OrbitalSky", "${javaClass.simpleName} failed", t)
    NoDataComplicationData()
  }

  protected abstract suspend fun build(type: ComplicationType, fix: SkyLocation.Fix, now: Long): ComplicationData?

  protected fun short(text: String, titleText: String, spoken: String): ComplicationData =
    ShortTextComplicationData.Builder(skyText(text), skyText(spoken))
      .setTitle(skyText(titleText)).setMonochromaticImage(icon()).setTapAction(SkyComplications.open(this)).build()
}

/** The whole sky, as the face's background picture. */
class SkyComplication : SuspendingComplicationDataSourceService() {
  override suspend fun onComplicationRequest(request: ComplicationRequest): ComplicationData? = try {
    val fix = SkyLocation.saved(this)
    PhotoImageComplicationData.Builder(
      Icon.createWithBitmap(SkyRender.render(this, System.currentTimeMillis(), fix)),
      skyText(if (fix == null) "Set a location to see your sky" else "The sky above you now"),
    ).setTapAction(SkyComplications.open(this)).build()
  } catch (t: Throwable) {
    Log.w("OrbitalSky", "sky complication failed", t)
    NoDataComplicationData()
  }

  override fun getPreviewData(type: ComplicationType): ComplicationData? =
    PhotoImageComplicationData.Builder(
      Icon.createWithBitmap(SkyRender.render(this, System.currentTimeMillis(), SkyLocation.saved(this) ?: SkyLocation.Fix(40.7, -74.0, 0L))),
      skyText("The sky above you"),
    ).build()
}

/** The next sunset while the Sun is up; the next sunrise while it is down. */
class SunComplication : SkyComplicationBase() {
  override val title = "SUN"
  override val iconRes = R.drawable.ic_c_sun

  override suspend fun build(type: ComplicationType, fix: SkyLocation.Fix, now: Long): ComplicationData {
    val h0 = SkyEngine.horizonFor(Body.SUN)
    val up = SkyEngine.position(Body.SUN, now, fix.lat, fix.lon).alt > h0
    val at = SkyEngine.nextCrossing(Body.SUN, now, fix.lat, fix.lon, h0, rising = !up)
    val label = if (up) "SUNSET" else "SUNRISE"
    return if (at == null) short("—", label, "No $label today")
    else short(SkyComplications.clock(this, at), label, "${label.lowercase()} at ${SkyComplications.clock(this, at)}")
  }

  override fun getPreviewData(type: ComplicationType): ComplicationData? =
    ShortTextComplicationData.Builder(skyText("7:12"), skyText("Sunset")).setTitle(skyText("SUNSET")).setMonochromaticImage(icon()).build()
}

/** How much of the Moon is lit, and the phase's name, with the Moon drawn. */
class MoonComplication : SkyComplicationBase() {
  override val title = "MOON"
  override val iconRes = R.drawable.ic_c_moon

  override suspend fun build(type: ComplicationType, fix: SkyLocation.Fix, now: Long): ComplicationData {
    val ph = SkyEngine.moonPhase(now)
    val pct = (ph.fraction * 100).roundToInt()
    val up = SkyEngine.position(Body.MOON, now, fix.lat, fix.lon).alt > 0
    val spoken = "Moon ${ph.name.lowercase()}, $pct percent lit, ${if (up) "up" else "below the horizon"}"
    if (type == ComplicationType.RANGED_VALUE) {
      return RangedValueComplicationData.Builder(pct.toFloat(), 0f, 100f, skyText(spoken))
        .setText(skyText("$pct%")).setTitle(skyText(ph.name)).setMonochromaticImage(icon())
        .setTapAction(SkyComplications.open(this)).build()
    }
    return short("$pct%", ph.name, spoken)
  }

  override fun getPreviewData(type: ComplicationType): ComplicationData? =
    ShortTextComplicationData.Builder(skyText("73%"), skyText("Moon")).setTitle(skyText("WAX GIB")).setMonochromaticImage(icon()).build()
}

/** Temperature, and the number that decides stargazing: cloud cover. */
class CloudComplication : SkyComplicationBase() {
  override val title = "CLOUDS"
  override val iconRes = R.drawable.ic_c_cloud

  override suspend fun build(type: ComplicationType, fix: SkyLocation.Fix, now: Long): ComplicationData {
    val w = SkyWeather.now(this) ?: return short("—", "CLOUDS", "Weather unavailable")
    val spoken = "${w.temp} ${w.unit}, ${w.sky.lowercase()}, ${w.cloud} percent cloud"
    if (type == ComplicationType.RANGED_VALUE) {
      return RangedValueComplicationData.Builder(w.cloud.toFloat(), 0f, 100f, skyText(spoken))
        .setText(skyText("${w.temp}°")).setTitle(skyText("CLD ${w.cloud}%")).setMonochromaticImage(icon())
        .setTapAction(SkyComplications.open(this)).build()
    }
    return short("${w.temp}°", "CLD ${w.cloud}%", spoken)
  }

  override fun getPreviewData(type: ComplicationType): ComplicationData? =
    ShortTextComplicationData.Builder(skyText("72°"), skyText("Weather")).setTitle(skyText("CLD 20%")).setMonochromaticImage(icon()).build()
}

/** Which of the five bright planets are above the horizon right now. */
class PlanetsComplication : SkyComplicationBase() {
  override val title = "PLANETS"
  override val iconRes = R.drawable.ic_c_planet

  override suspend fun build(type: ComplicationType, fix: SkyLocation.Fix, now: Long): ComplicationData {
    val up = SkyEngine.BRIGHT_PLANETS.filter { SkyEngine.position(it, now, fix.lat, fix.lon).alt > 0 }
    val names = up.joinToString(" · ") { it.label }
    val spoken = if (up.isEmpty()) "No bright planets up" else "$names above the horizon"
    if (type == ComplicationType.LONG_TEXT) {
      return LongTextComplicationData.Builder(skyText(if (up.isEmpty()) "No planets up" else "$names up"), skyText(spoken))
        .setMonochromaticImage(icon()).setTapAction(SkyComplications.open(this)).build()
    }
    return short("${up.size} UP", "PLANETS", spoken)
  }

  override fun getPreviewData(type: ComplicationType): ComplicationData? =
    if (type == ComplicationType.LONG_TEXT) {
      LongTextComplicationData.Builder(skyText("Venus · Jupiter · Saturn up"), skyText("Planets up")).setMonochromaticImage(icon()).build()
    } else {
      ShortTextComplicationData.Builder(skyText("3 UP"), skyText("Planets up")).setTitle(skyText("PLANETS")).setMonochromaticImage(icon()).build()
    }
}

/** When the sky gets properly dark (the Sun 18 degrees down), or, while
 *  it is dark, when that ends. The observer's number, not the sunset's. */
class DarkComplication : SkyComplicationBase() {
  override val title = "DARK"
  override val iconRes = R.drawable.ic_c_dark

  override suspend fun build(type: ComplicationType, fix: SkyLocation.Fix, now: Long): ComplicationData {
    val dark = SkyEngine.position(Body.SUN, now, fix.lat, fix.lon).alt < -18
    val at = SkyEngine.nextCrossing(Body.SUN, now, fix.lat, fix.lon, -18.0, rising = dark)
    val label = if (dark) "DARK TIL" else "DARK AT"
    return if (at == null) short("—", "NO DARK", "The sky does not get fully dark tonight")
    else short(SkyComplications.clock(this, at), label, "${if (dark) "Dark until" else "Dark from"} ${SkyComplications.clock(this, at)}")
  }

  override fun getPreviewData(type: ComplicationType): ComplicationData? =
    ShortTextComplicationData.Builder(skyText("8:41"), skyText("Dark at")).setTitle(skyText("DARK AT")).setMonochromaticImage(icon()).build()
}
