package com.orbitalempire.wear

import androidx.concurrent.futures.CallbackToFutureAdapter
import androidx.wear.protolayout.ColorBuilders.argb
import androidx.wear.protolayout.DimensionBuilders.dp
import androidx.wear.protolayout.DimensionBuilders.expand
import androidx.wear.protolayout.LayoutElementBuilders
import androidx.wear.protolayout.LayoutElementBuilders.LayoutElement
import androidx.wear.protolayout.ModifiersBuilders
import androidx.wear.protolayout.ResourceBuilders
import androidx.wear.protolayout.TimelineBuilders
import androidx.wear.tiles.RequestBuilders
import androidx.wear.tiles.TileBuilders
import androidx.wear.tiles.TileService
import com.google.common.util.concurrent.ListenableFuture
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlin.math.roundToLong

/**
 * The three screens, as tiles: Empire, Battles, Senate.
 *
 * EACH TILE IS ITS SCREEN AT A GLANCE, and a tap on it opens that screen
 * in the app. A tile is the watch's home-screen card, so it carries the
 * one or two things that screen exists to tell you -- what you hold and
 * earn, whether you are fighting, whether the senate wants your vote --
 * and leaves the rest to the app.
 *
 * THEY FETCH FOR THEMSELVES, through the same OrbitalClient and the same
 * paired token as the app, so a tile works without the app ever having
 * been opened since the watch rebooted. No token: the tile says so and
 * opens the app's pairing screen.
 *
 * FRESHNESS IS TEN MINUTES. A tick is an hour of real time; the system
 * also refetches whenever the player swipes to the tile, so a stale tile
 * is only ever seen for as long as it takes to be replaced.
 */
abstract class OrbitalTileService : TileService() {

  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

  /** The page this tile opens in the app. */
  protected abstract val page: Int

  /** This tile's layout for a live state. */
  protected abstract fun layout(s: WearState, img: TileKit.Images): LayoutElement

  /** A clickable id this tile handles itself (a vote); true if it acted. */
  protected open suspend fun handleClick(id: String): Boolean = false

  override fun onTileRequest(request: RequestBuilders.TileRequest): ListenableFuture<TileBuilders.Tile> =
    CallbackToFutureAdapter.getFuture { done ->
      scope.launch {
        try {
          val clicked = request.currentState.lastClickableId
          if (clicked.isNotEmpty()) {
            try { handleClick(clicked) } catch (_: Throwable) { }
          }
          done.set(buildTile())
        } catch (t: Throwable) {
          done.setException(t)
        }
      }
      "orbital-tile-$page"
    }

  override fun onTileResourcesRequest(request: RequestBuilders.ResourcesRequest): ListenableFuture<ResourceBuilders.Resources> =
    CallbackToFutureAdapter.getFuture { done ->
      scope.launch {
        try {
          done.set(TileKit.resources(this@OrbitalTileService, request.version))
        } catch (t: Throwable) {
          done.setException(t)
        }
      }
      "orbital-tile-res-$page"
    }

  override fun onDestroy() {
    scope.cancel()
    super.onDestroy()
  }

  private suspend fun buildTile(): TileBuilders.Tile {
    val img = TileKit.Images(this)
    val body: LayoutElement = when (val f = OrbitalClient.state(this)) {
      is OrbitalClient.Fetch.Ok -> {
        // The tiles' ten-minute beat is Battle Stations' beat too.
        BattleStations.sync(this, f.state)
        OrbitalComplication.refreshAll(this)
        // A LAYOUT THAT THROWS MUST STILL SAY SOMETHING. ProtoLayout
        // rejects a bad element at build time, and the tile then draws
        // as an empty card -- indistinguishable from a tile that never
        // loaded, which is how a blank one hides its own cause.
        try {
          layout(f.state, img)
        } catch (t: Throwable) {
          android.util.Log.w("OrbitalWear", "tile $page layout failed", t)
          message(img, "ORBITAL", "This tile could not be drawn")
        }
      }
      is OrbitalClient.Fetch.Unpaired -> message(img, "CONNECT", "Tap to connect this watch")
      is OrbitalClient.Fetch.Failed -> message(img, "OFFLINE", "Tap to open Orbital")
      else -> message(img, "ORBITAL", "Tap to open")
    }
    val root = LayoutElementBuilders.Box.Builder()
      .setWidth(expand())
      .setHeight(expand())
      .setHorizontalAlignment(LayoutElementBuilders.HORIZONTAL_ALIGN_CENTER)
      .setVerticalAlignment(LayoutElementBuilders.VERTICAL_ALIGN_CENTER)
      .addContent(body)
      .build()
    return TileBuilders.Tile.Builder()
      .setResourcesVersion(img.version())
      .setFreshnessIntervalMillis(10 * 60 * 1000L)
      .setTileTimeline(TimelineBuilders.Timeline.fromLayoutElement(root))
      .build()
  }

  private fun message(img: TileKit.Images, title: String, hint: String): LayoutElement =
    column(page)
      .addContent(img.text(title, 16f, TileKit.argbOf(Ink)))
      .addContent(TileKit.spacer(4f))
      .addContent(TileKit.label(hint, 11f, TileKit.argbOf(Dim), maxLines = 2))
      .build()

  /** A centred column that opens this tile's screen when tapped. */
  protected fun column(openPage: Int): LayoutElementBuilders.Column.Builder =
    LayoutElementBuilders.Column.Builder()
      .setWidth(expand())
      .setHorizontalAlignment(LayoutElementBuilders.HORIZONTAL_ALIGN_CENTER)
      .setModifiers(
        ModifiersBuilders.Modifiers.Builder()
          .setClickable(TileKit.openApp(this, openPage))
          .setPadding(ModifiersBuilders.Padding.Builder().setStart(dp(14f)).setEnd(dp(14f)).build())
          .build(),
      )

  protected fun ink(c: androidx.compose.ui.graphics.Color) = TileKit.argbOf(c)
}

/**
 * What you hold, what a tick adds, what you are building toward, and
 * what needs you.
 *
 * THE FLEET LINE COUNTS HULLS, NOT BATTLES. attention.fighting is the
 * number of battles you are in, which read as a fleet size and is not
 * one; the line says how many of your ships are live, how many are on
 * the ways, and how many are actually shooting.
 */
class EmpireTileService : OrbitalTileService() {
  override val page = 0

  override fun layout(s: WearState, img: TileKit.Images): LayoutElement {
    val col = column(page)
      .addContent(TileKit.label(s.faction.uppercase(), 10f, TileKit.colorOf(s.color), bold = true))
      .addContent(TileKit.spacer(3f))
      .addContent(
        LayoutElementBuilders.Row.Builder()
          .setVerticalAlignment(LayoutElementBuilders.VERTICAL_ALIGN_TOP)
          .addContent(resource(img, "METAL", s.metal, s.perTick.metal, MetalInk))
          .addContent(TileKit.gap(8f))
          .addContent(resource(img, "CR", s.credits, s.perTick.credits, CreditInk))
          .addContent(TileKit.gap(8f))
          .addContent(resource(img, "SCI", s.science, s.perTick.science, ScienceInk))
          .build(),
      )
      .addContent(TileKit.spacer(5f))
      .addContent(researchBlock(s))
      .addContent(TileKit.spacer(4f))
      .addContent(fleetLine(s))
      .addContent(TileKit.spacer(4f))
      .addContent(TileKit.label(tickLine(s), 9f, ink(Dim)))
      .addContent(TileKit.spacer(2f))
    val (attention, color) = attentionLine(s)
    col.addContent(TileKit.label(attention, 10f, ink(color)))
    return col.build()
  }

  /** The project, the level it is buying, and the science into it. */
  private fun researchBlock(s: WearState): LayoutElement {
    val r = s.research
      ?: return TileKit.label("NO RESEARCH PROJECT", 9f, ink(Warn))
    val pct = (r.fraction * 100).toInt()
    return LayoutElementBuilders.Column.Builder()
      .setHorizontalAlignment(LayoutElementBuilders.HORIZONTAL_ALIGN_CENTER)
      .addContent(
        TileKit.label(
          "${r.name.uppercase()} ${r.level} · $pct%",
          9f, ink(ScienceInk),
        ),
      )
      .addContent(TileKit.spacer(2f))
      .addContent(TileKit.bar(104f, r.fraction, TileKit.argbOf(ScienceInk), TileKit.argbOf(Trough)))
      .build()
  }

  /** Live hulls, hulls building, hulls in the fighting. */
  private fun fleetLine(s: WearState): LayoutElement {
    val row = LayoutElementBuilders.Row.Builder()
      .setVerticalAlignment(LayoutElementBuilders.VERTICAL_ALIGN_BOTTOM)
    row.addContent(TileKit.label("${s.ships ?: 0} SHIPS", 9f, ink(Ink)))
    val building = s.building ?: 0
    if (building > 0) {
      row.addContent(TileKit.label("  ·  ", 9f, ink(Dim)))
      row.addContent(TileKit.label("$building BUILDING", 9f, ink(Good)))
    }
    val fighting = s.inCombat ?: 0
    if (fighting > 0) {
      row.addContent(TileKit.label("  ·  ", 9f, ink(Dim)))
      row.addContent(TileKit.label("$fighting IN COMBAT", 9f, ink(Alarm)))
    }
    return row.build()
  }

  private fun resource(img: TileKit.Images, label: String, amount: Long, perTick: Double?, tint: androidx.compose.ui.graphics.Color): LayoutElement {
    val rate = when {
      perTick == null -> "—"
      perTick >= 0 -> "+${compact(perTick.roundToLong())}"
      else -> "−${compact(-perTick.roundToLong())}"
    }
    val rateInk = when {
      perTick == null -> Dim
      perTick > 0 -> Good
      perTick < 0 -> Alarm
      else -> Dim
    }
    return LayoutElementBuilders.Column.Builder()
      .setHorizontalAlignment(LayoutElementBuilders.HORIZONTAL_ALIGN_CENTER)
      .addContent(img.text(compact(amount), 15f, ink(tint), "$label ${compact(amount)}"))
      .addContent(TileKit.label(label, 8f, ink(Dim)))
      .addContent(TileKit.label(rate, 9f, ink(rateInk)))
      .build()
  }

  private fun tickLine(s: WearState): String {
    if (!s.isLive) return "TICK ${s.tick}"
    if (s.nextTickAt <= 0L) return "TICK ${s.tick} · PAUSED"
    val skew = if (s.serverNow > 0) s.serverNow - System.currentTimeMillis() else 0L
    val mins = ((s.nextTickAt - (System.currentTimeMillis() + skew)) / 60_000L).coerceAtLeast(0)
    return if (mins <= 0) "TICK ${s.tick} · ANY MOMENT" else "TICK ${s.tick} · NEXT ~${mins}M"
  }

  private fun attentionLine(s: WearState): Pair<String, androidx.compose.ui.graphics.Color> {
    val a = s.attention
    val parts = buildList {
      // Battles, not hulls -- the fleet line above counts the hulls.
      if (a.fighting > 0) add("${a.fighting} ${if (a.fighting == 1) "BATTLE" else "BATTLES"}")
      if (a.inbound > 0) add("${a.inbound} INBOUND")
      if (a.bills > 0) add("${a.bills} TO VOTE")
    }
    return when {
      parts.isEmpty() -> "ALL QUIET" to Dim
      a.fighting > 0 || a.inbound > 0 -> parts.joinToString(" · ") to Alarm
      else -> parts.joinToString(" · ") to Warn
    }
  }
}

/** Whether you are fighting, the hottest fight, and what is coming. */
class BattlesTileService : OrbitalTileService() {
  override val page = 1

  override fun layout(s: WearState, img: TileKit.Images): LayoutElement {
    val col = column(page)
      .addContent(img.text("BATTLES", 13f, ink(Ink)))
      .addContent(TileKit.spacer(4f))
    if (s.battles.isEmpty() && s.threats.isEmpty()) {
      col.addContent(TileKit.label("NO FIGHTING", 11f, ink(Dim)))
      col.addContent(TileKit.label("Your fleets are at peace", 9f, ink(Dim)))
      return col.build()
    }
    if (s.battles.isNotEmpty()) {
      col.addContent(img.text("${s.battles.size}", 26f, ink(Alarm), "${s.battles.size} engaged"))
      col.addContent(TileKit.label(if (s.battles.size == 1) "ENGAGEMENT" else "ENGAGEMENTS", 8f, ink(Dim)))
      col.addContent(TileKit.spacer(4f))
      val b = s.battles.first()
      col.addContent(TileKit.label(b.body.uppercase(), 10f, ink(Ink), bold = true))
      val mine = b.sides.filter { it.mine }
      val theirs = b.sides.filter { !it.mine }
      if (mine.isNotEmpty() || theirs.isNotEmpty()) {
        val row = LayoutElementBuilders.Row.Builder()
          .setVerticalAlignment(LayoutElementBuilders.VERTICAL_ALIGN_CENTER)
        val myAlive = mine.sumOf { it.alive }
        val myInk = mine.firstOrNull()?.let { TileKit.colorOf(it.color) } ?: ink(Good)
        row.addContent(img.text("$myAlive", 15f, myInk, "your ships $myAlive"))
        row.addContent(TileKit.gap(6f))
        row.addContent(TileKit.label("VS", 9f, ink(Dim)))
        row.addContent(TileKit.gap(6f))
        if (b.known) {
          val theirAlive = theirs.sumOf { it.alive }
          val theirInk = theirs.firstOrNull()?.let { TileKit.colorOf(it.color) } ?: ink(Alarm)
          row.addContent(img.text("$theirAlive", 15f, theirInk, "enemy ships $theirAlive"))
        } else {
          row.addContent(img.text("?", 15f, ink(Dim), "enemy strength unknown"))
        }
        col.addContent(row.build())
      }
    }
    s.threats.firstOrNull()?.let { t ->
      col.addContent(TileKit.spacer(4f))
      val eta = when {
        t.eta == null -> ""
        t.eta <= 0 -> " · NOW"
        else -> " · ${t.eta}T"
      }
      col.addContent(TileKit.label("INBOUND ${t.ships} → ${t.body.uppercase()}$eta", 9f, ink(Warn)))
    }
    return col.build()
  }
}

/** The most urgent open bill, and your vote on it, from the tile. */
class SenateTileService : OrbitalTileService() {
  override val page = 2

  /**
   * VOTING FROM THE TILE, same rule as the app: no confirmation, because
   * castVoteCore updates a vote rather than refusing it and the next tap
   * undoes a mistap. The tile is re-requested with the button's id, the
   * vote goes in, and the redrawn tile shows the choice the server
   * accepted.
   */
  override suspend fun handleClick(id: String): Boolean {
    if (!id.startsWith(VOTE)) return false
    val rest = id.removePrefix(VOTE)
    val sep = rest.indexOf('|')
    if (sep <= 0) return false
    val choice = rest.substring(0, sep)
    val bill = rest.substring(sep + 1)
    if (choice !in setOf("yea", "nay", "abstain")) return false
    return OrbitalClient.vote(this, bill, choice) is OrbitalClient.Voted.Ok
  }

  override fun layout(s: WearState, img: TileKit.Images): LayoutElement {
    val col = column(page)
      .addContent(img.text("SENATE", 13f, ink(Ink)))
      .addContent(TileKit.spacer(3f))
    val bills = s.senate.sortedBy { it.closesIn }
    val bill = bills.firstOrNull()
    if (bill == null) {
      col.addContent(TileKit.label("NO OPEN BILLS", 11f, ink(Dim)))
      return col.build()
    }
    col.addContent(TileKit.label(bill.title.uppercase(), 10f, ink(Ink), bold = true, maxLines = 2))
    col.addContent(
      TileKit.label(
        if (bill.closesIn <= 0) "CLOSING NOW" else "CLOSES IN ${bill.closesIn}T",
        9f,
        ink(if (bill.closesIn <= 1) Alarm else Warn),
      ),
    )
    col.addContent(TileKit.spacer(3f))
    col.addContent(
      LayoutElementBuilders.Row.Builder()
        .setVerticalAlignment(LayoutElementBuilders.VERTICAL_ALIGN_CENTER)
        .addContent(img.text("${bill.yea}", 14f, ink(Good), "${bill.yea} yea"))
        .addContent(TileKit.gap(3f))
        .addContent(TileKit.label("YEA", 8f, ink(Dim)))
        .addContent(TileKit.gap(10f))
        .addContent(img.text("${bill.nay}", 14f, ink(Alarm), "${bill.nay} nay"))
        .addContent(TileKit.gap(3f))
        .addContent(TileKit.label("NAY", 8f, ink(Dim)))
        .build(),
    )
    col.addContent(TileKit.spacer(5f))
    col.addContent(
      LayoutElementBuilders.Row.Builder()
        .addContent(voteButton("YEA", "yea", bill, Good))
        .addContent(TileKit.gap(4f))
        .addContent(voteButton("NAY", "nay", bill, Alarm))
        .addContent(TileKit.gap(4f))
        .addContent(voteButton("ABS", "abstain", bill, Dim))
        .build(),
    )
    if (bills.size > 1) {
      col.addContent(TileKit.spacer(3f))
      col.addContent(TileKit.label("+${bills.size - 1} MORE", 8f, ink(Dim)))
    }
    return col.build()
  }

  private fun voteButton(label: String, choice: String, bill: Bill, tint: androidx.compose.ui.graphics.Color): LayoutElement {
    val chosen = bill.myVote == choice
    return LayoutElementBuilders.Box.Builder()
      .setWidth(dp(40f))
      .setHeight(dp(26f))
      .setHorizontalAlignment(LayoutElementBuilders.HORIZONTAL_ALIGN_CENTER)
      .setVerticalAlignment(LayoutElementBuilders.VERTICAL_ALIGN_CENTER)
      .setModifiers(
        ModifiersBuilders.Modifiers.Builder()
          .setClickable(TileKit.reload("$VOTE$choice|${bill.id}"))
          .setBackground(
            ModifiersBuilders.Background.Builder()
              .setColor(argb(if (chosen) ink(tint) else ink(Trough)))
              .setCorner(ModifiersBuilders.Corner.Builder().setRadius(dp(13f)).build())
              .build(),
          )
          .setSemantics(
            ModifiersBuilders.Semantics.Builder()
              .setContentDescription(if (chosen) "$label, your vote" else "Vote $label")
              .build(),
          )
          .build(),
      )
      .addContent(TileKit.label(label, 10f, if (chosen) ink(Ground) else ink(tint), bold = true))
      .build()
  }

  private companion object {
    const val VOTE = "vote|"
  }
}
