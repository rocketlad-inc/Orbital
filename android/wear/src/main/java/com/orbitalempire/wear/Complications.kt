package com.orbitalempire.wear

import android.app.PendingIntent
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.graphics.drawable.Icon
import android.util.Log
import androidx.wear.watchface.complications.data.ComplicationData
import androidx.wear.watchface.complications.data.ComplicationText
import androidx.wear.watchface.complications.data.ComplicationType
import androidx.wear.watchface.complications.data.CountDownTimeReference
import androidx.wear.watchface.complications.data.MonochromaticImage
import androidx.wear.watchface.complications.data.PlainComplicationText
import androidx.wear.watchface.complications.data.RangedValueComplicationData
import androidx.wear.watchface.complications.data.ShortTextComplicationData
import androidx.wear.watchface.complications.data.TimeDifferenceComplicationText
import androidx.wear.watchface.complications.data.TimeDifferenceStyle
import androidx.wear.watchface.complications.datasource.ComplicationDataSourceUpdateRequester
import androidx.wear.watchface.complications.datasource.ComplicationRequest
import androidx.wear.watchface.complications.datasource.SuspendingComplicationDataSourceService
import java.time.Instant
import kotlin.math.roundToLong

/**
 * Orbital on the watch face: twelve complications, one number each.
 *
 * Lorne's list: the situation log count, messages and trades, each
 * resource, each resource per turn, the domination ring, the next-tick
 * countdown, your ship count, and enemy ships inbound across the empire.
 *
 * ONE FETCH FEEDS THEM ALL. Each reads OrbitalClient.stateFresh, so a
 * face carrying six of these costs one request, and every time the app
 * or a tile fetches, [refreshAll] pushes the new numbers to every one --
 * which beats the five-minute floor Wear puts on a complication asking
 * for itself.
 *
 * THE FACE DRAWS THEM, not us: the typeface and layout are the watch
 * face's. What is ours is the number, the short title under it, the
 * monochrome icon and where a tap goes.
 *
 * THE TICK COUNTDOWN COSTS NOTHING: it is handed to the face as a
 * timestamp (TimeDifferenceComplicationText) and the face counts it
 * down itself, to the second, without waking this app.
 */
abstract class OrbitalComplication : SuspendingComplicationDataSourceService() {

  /** The app page a tap opens: 0 empire, 1 battles, 2 senate, 3 systems. */
  protected open val page: Int = 0

  protected abstract val iconRes: Int

  /** The short title under the number, e.g. "METAL". */
  protected abstract val title: String

  /** This complication's number for a live state, or null for "none". */
  protected abstract fun text(s: WearState): ComplicationText?

  /** A spoken version, for TalkBack. */
  protected abstract fun describe(s: WearState): String

  /** Sample data for the face's complication picker. */
  protected abstract val preview: String

  /**
   * NEVER NO-DATA WHILE THE SLOT IS OURS. A watch face draws
   * NoDataComplicationData as an empty slot -- a blank circle with no
   * hint of what put it there -- and this returned exactly that for
   * every state that was not 'live'. An ELIMINATED player (a real,
   * ordinary state: the game goes on around them) therefore saw a face
   * full of blank circles, and so did anyone whose watch had not
   * finished pairing.
   *
   * So: whatever the state, the complication renders its title, its
   * icon and either its number or an em dash, and its tap still opens
   * the app. A slot that cannot say a number can at least say which
   * number it is and that Orbital is behind it.
   */
  override suspend fun onComplicationRequest(request: ComplicationRequest): ComplicationData? {
    return try {
      val s = OrbitalClient.stateFresh(this)
      if (s == null) unavailable(request.complicationType, "Orbital is not connected to a game yet")
      else build(request.complicationType, s) ?: unavailable(request.complicationType, describe(s))
    } catch (t: Throwable) {
      Log.w("OrbitalWear", "complication ${javaClass.simpleName} failed", t)
      unavailable(request.complicationType, "Orbital is not reachable right now")
    }
  }

  /** The slot, named and tappable, with an em dash where the number goes. */
  protected fun unavailable(type: ComplicationType, why: String): ComplicationData {
    if (type == ComplicationType.RANGED_VALUE) {
      return RangedValueComplicationData.Builder(0f, 0f, 1f, plain(why))
        .setText(plain("—"))
        .setTitle(plain(title))
        .setMonochromaticImage(icon())
        .setTapAction(tap())
        .build()
    }
    return ShortTextComplicationData.Builder(plain("—"), plain(why))
      .setTitle(plain(title))
      .setMonochromaticImage(icon())
      .setTapAction(tap())
      .build()
  }

  protected open fun build(type: ComplicationType, s: WearState): ComplicationData? {
    // An em dash, not nothing: see onComplicationRequest.
    val t = text(s) ?: plain("—")
    return ShortTextComplicationData.Builder(t, plain(describe(s)))
      .setTitle(plain(title))
      .setMonochromaticImage(icon())
      .setTapAction(tap())
      .build()
  }

  override fun getPreviewData(type: ComplicationType): ComplicationData? =
    ShortTextComplicationData.Builder(plain(preview), plain("$title $preview"))
      .setTitle(plain(title))
      .setMonochromaticImage(icon())
      .build()

  protected fun icon(): MonochromaticImage =
    MonochromaticImage.Builder(Icon.createWithResource(this, iconRes)).build()

  protected fun tap(): PendingIntent = PendingIntent.getActivity(
    this,
    javaClass.name.hashCode(),
    Intent(this, MainActivity::class.java)
      .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
      .putExtra(MainActivity.EXTRA_PAGE, page),
    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
  )

  companion object {
    fun plain(s: String): ComplicationText = PlainComplicationText.Builder(s).build()

    fun rate(v: Double?): String = when {
      v == null -> "—"
      v >= 0 -> "+${compact(v.roundToLong())}"
      else -> "−${compact(-v.roundToLong())}"
    }

    private val ALL = listOf(
      SituationComplication::class.java,
      MessagesComplication::class.java,
      MetalComplication::class.java,
      CreditsComplication::class.java,
      ScienceComplication::class.java,
      MetalRateComplication::class.java,
      CreditsRateComplication::class.java,
      ScienceRateComplication::class.java,
      DominationComplication::class.java,
      NextTickComplication::class.java,
      ShipsComplication::class.java,
      InboundComplication::class.java,
      MapComplication::class.java,
    )

    /** Push fresh numbers to every Orbital complication on the face. */
    fun refreshAll(c: Context) {
      for (cls in ALL) {
        try {
          ComplicationDataSourceUpdateRequester.create(c, ComponentName(c, cls)).requestUpdateAll()
        } catch (t: Throwable) {
          Log.w("OrbitalWear", "complication refresh failed for ${cls.simpleName}", t)
        }
      }
    }
  }
}

/**
 * The situation log, as its own dock badge counts it -- mirrored from the
 * open game (migration 0137), because the badge is the client's rules
 * plus the player's dismissals and no server can recompute it. Exact, and
 * possibly old: the spoken description carries its age.
 */
class SituationComplication : OrbitalComplication() {
  override val iconRes = R.drawable.ic_c_log
  override val title = "LOG"
  override val preview = "6"
  override fun text(s: WearState): ComplicationText? = s.situation?.let { plain("${it.count}") }
  override fun describe(s: WearState): String {
    val b = s.situation ?: return "Situation log not reported yet"
    val mins = ((System.currentTimeMillis() - b.at) / 60_000L).coerceAtLeast(0)
    val age = if (mins < 2) "just now" else if (mins < 120) "$mins minutes ago" else "${mins / 60} hours ago"
    return "${b.count} in the situation log${if (b.now) ", under fire" else ""}, as of $age"
  }
}

/** Unread messages plus trade offers waiting on you. */
class MessagesComplication : OrbitalComplication() {
  override val iconRes = R.drawable.ic_c_msg
  override val title = "MSG"
  override val preview = "3"
  override fun text(s: WearState) = plain("${s.attention.unread + s.attention.offers}")
  override fun describe(s: WearState) = "${s.attention.unread} unread messages, ${s.attention.offers} trade offers"
}

class MetalComplication : OrbitalComplication() {
  override val iconRes = R.drawable.ic_c_metal
  override val title = "METAL"
  override val preview = "37.4M"
  override fun text(s: WearState) = plain(compact(s.metal))
  override fun describe(s: WearState) = "${s.metal} metal"
}

class CreditsComplication : OrbitalComplication() {
  override val iconRes = R.drawable.ic_c_credit
  override val title = "CR"
  override val preview = "62.6M"
  override fun text(s: WearState) = plain(compact(s.credits))
  override fun describe(s: WearState) = "${s.credits} credits"
}

class ScienceComplication : OrbitalComplication() {
  override val iconRes = R.drawable.ic_c_science
  override val title = "SCI"
  override val preview = "150M"
  override fun text(s: WearState) = plain(compact(s.science))
  override fun describe(s: WearState) = "${s.science} science"
}

/** Per turn is NET where the server knows it (income less upkeep) -- the
 *  same figure the Empire screen shows -- else gross income. */
class MetalRateComplication : OrbitalComplication() {
  override val iconRes = R.drawable.ic_c_metal
  override val title = "METAL/T"
  override val preview = "+570"
  override fun text(s: WearState) = plain(rate(s.perTick.netMetal ?: s.perTick.metal))
  override fun describe(s: WearState) = "metal ${rate(s.perTick.netMetal ?: s.perTick.metal)} per turn"
}

class CreditsRateComplication : OrbitalComplication() {
  override val iconRes = R.drawable.ic_c_credit
  override val title = "CR/T"
  override val preview = "+1036"
  override fun text(s: WearState) = plain(rate(s.perTick.netCredits ?: s.perTick.credits))
  override fun describe(s: WearState) = "credits ${rate(s.perTick.netCredits ?: s.perTick.credits)} per turn"
}

class ScienceRateComplication : OrbitalComplication() {
  override val iconRes = R.drawable.ic_c_science
  override val title = "SCI/T"
  override val preview = "+2690"
  override fun text(s: WearState) = plain(rate(s.perTick.science))
  override fun describe(s: WearState) = "science ${rate(s.perTick.science)} per turn"
}

/**
 * The domination ring: worlds you hold against the number that wins --
 * the win check's own arithmetic (strictly more than the game's
 * domination fraction of all worlds), so a full ring means you have won.
 */
class DominationComplication : OrbitalComplication() {
  override val page = 3
  override val iconRes = R.drawable.ic_c_dom
  override val title = "DOM"
  override val preview = "18/28"
  override fun text(s: WearState) = s.domination?.let { plain("${it.owned}/${it.need}") }
  override fun describe(s: WearState): String {
    val d = s.domination ?: return "Domination unknown"
    return "${d.owned} of ${d.total} worlds held, ${d.need} to win"
  }

  override fun build(type: ComplicationType, s: WearState): ComplicationData? {
    val d = s.domination ?: return unavailable(type, describe(s))
    if (type != ComplicationType.RANGED_VALUE) return super.build(type, s)
    return RangedValueComplicationData.Builder(
      value = d.owned.coerceAtMost(d.need).toFloat(),
      min = 0f,
      max = d.need.toFloat(),
      contentDescription = plain(describe(s)),
    )
      .setText(plain("${d.owned}"))
      .setTitle(plain(title))
      .setMonochromaticImage(icon())
      .setTapAction(tap())
      .build()
  }

  override fun getPreviewData(type: ComplicationType): ComplicationData? {
    if (type != ComplicationType.RANGED_VALUE) return super.getPreviewData(type)
    return RangedValueComplicationData.Builder(18f, 0f, 28f, plain("18 of 28 worlds to win"))
      .setText(plain("18"))
      .setTitle(plain(title))
      .setMonochromaticImage(icon())
      .build()
  }
}

/** Counted down BY THE FACE from one timestamp, to the second, for free. */
class NextTickComplication : OrbitalComplication() {
  override val iconRes = R.drawable.ic_c_tick
  override val title = "TICK"
  override val preview = "12m"
  override fun text(s: WearState): ComplicationText? {
    if (s.nextTickAt <= 0L) return plain("—")
    // The server's clock, carried over to the watch's: a watch that runs
    // minutes fast would otherwise count down to a tick already gone.
    val skew = if (s.serverNow > 0) s.serverNow - System.currentTimeMillis() else 0L
    return TimeDifferenceComplicationText.Builder(
      TimeDifferenceStyle.SHORT_SINGLE_UNIT,
      CountDownTimeReference(Instant.ofEpochMilli(s.nextTickAt - skew)),
    ).build()
  }
  override fun describe(s: WearState) = "next tick, tick ${s.tick + 1}"
}

class ShipsComplication : OrbitalComplication() {
  override val page = 3
  override val iconRes = R.drawable.ic_c_ship
  override val title = "SHIPS"
  override val preview = "140"
  override fun text(s: WearState) = s.ships?.let { plain("$it") }
  override fun describe(s: WearState) = "${s.ships ?: 0} ships"
}

/** Hostile hulls in flight toward worlds you hold, treaty partners excluded. */
class InboundComplication : OrbitalComplication() {
  override val page = 1
  override val iconRes = R.drawable.ic_c_inbound
  override val title = "INBOUND"
  override val preview = "5"
  override fun text(s: WearState) = plain("${s.attention.inbound}")
  override fun describe(s: WearState) = "${s.attention.inbound} enemy ships inbound"
}
