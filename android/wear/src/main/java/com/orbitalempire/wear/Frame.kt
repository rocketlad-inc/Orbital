package com.orbitalempire.wear

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.BoxWithConstraintsScope
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.sp

/** The design's accent teal, the page names' grey (6:1 on the ground,
 *  where the old #56697C was 3.3:1), and the secondary text grey. */
val Teal = Color(0xFF4ECDC4)
val Label = Color(0xFF8A9DB0)
val Sub = Color(0xFFA9BACB)

/** Callbacks from any page into the sheets the app host keeps. */
class Nav(
  /** Open a world's Porthole: the battle, as it looks. */
  val watch: (String) -> Unit = {},
  /** A fleet's orders, by any ship in it. */
  val orders: (String) -> Unit = {},
  /** Choose where a fleet goes. */
  val send: (FleetGroup) -> Unit = {},
  /** Choose research. */
  val research: () -> Unit = {},
  /** Open a destination (Dest.*): a page or a sheet. */
  val go: (Int) -> Unit = {},
  /** Speak an order. */
  val voice: () -> Unit = {},
  /** Where the capital is in the real sky. */
  val lookUp: () -> Unit = {},
  /** A yard's build picker. */
  val build: (Yard) -> Unit = {},
)

/**
 * One round screen: the rim ring (how far through the tick, or whatever
 * [ring] says), the top arc naming the screen, and the content inside.
 * [s] is the screen's diameter, which every page lays itself out against,
 * so the same design fits a 192dp and a 240dp watch.
 */
@Composable
fun Frame(
  top: String?,
  topInk: Color = Sub,
  ring: Float? = null,
  ringInk: Color = Teal,
  rim: (DrawScope.() -> Unit)? = null,
  content: @Composable BoxWithConstraintsScope.(s: Dp) -> Unit,
) {
  val ctx = LocalContext.current
  val face = remember { TileKit.audiowide(ctx.applicationContext) }
  BoxWithConstraints(Modifier.fillMaxSize()) {
    val s = if (maxWidth < maxHeight) maxWidth else maxHeight
    content(s)
    // DRAWN OVER THE CONTENT, on its own ground: a list scrolled up put
    // its rows straight through the title (the review, on real data).
    // The top of the face darkens first, the way the page names' does.
    Canvas(Modifier.fillMaxSize()) {
      if (top != null) {
        drawRect(
          androidx.compose.ui.graphics.Brush.verticalGradient(
            0f to Ground.copy(alpha = 0.94f),
            1f to Color.Transparent,
            startY = size.height * 0.10f,
            endY = size.height * 0.20f,
          ),
          size = androidx.compose.ui.geometry.Size(size.width, size.height * 0.20f),
        )
      }
      if (ring != null) rimRing(ring, ringInk)
      rim?.invoke(this)
      if (top != null) rimTextTop(top, topInk, size.minDimension * 0.05f, size.minDimension * 0.03f, face)
    }
  }
}

/** Ticks through the current tick, 0..1, against the server's clock. */
fun tickFraction(st: WearState, now: Long): Float {
  if (st.nextTickAt <= 0L) return 0f
  val len = if (st.tickMs > 0) st.tickMs else 3_600_000L
  val skew = if (st.serverNow > 0) st.serverNow - System.currentTimeMillis() else 0L
  val left = st.nextTickAt - (now + skew)
  return (1f - left.toFloat() / len).coerceIn(0f, 1f)
}

/** "34M", "2H 5M", "40S", "ANY MOMENT": the time to the next tick. */
fun untilTick(st: WearState, now: Long): String {
  if (st.phase == "ended" || st.phase == "none" || st.nextTickAt <= 0L) return ""
  val skew = if (st.serverNow > 0) st.serverNow - System.currentTimeMillis() else 0L
  val left = st.nextTickAt - (now + skew)
  return when {
    left <= 0L -> "ANY MOMENT"
    left < 60_000L -> "${left / 1000}S"
    left < 3_600_000L -> "${left / 60_000}M"
    else -> "${left / 3_600_000}H ${(left % 3_600_000) / 60_000}M"
  }
}

/** A font size as a fraction of the screen's diameter. */
fun fs(s: Dp, k: Float): TextUnit = (s.value * k).sp

/**
 * THE DESIGN'S UNITS. The review drew every screen on a 454px round face;
 * [u] maps a length in those pixels onto this watch's diameter, so a
 * layout keeps its proportions on any size of watch. Text ([tp]) is set a
 * quarter larger than drawn and never below 7.5sp: the smallest size the
 * old screens proved readable on a wrist.
 */
fun u(s: Dp, px: Float): Dp = s * (px / 454f)

fun tp(s: Dp, px: Float): TextUnit = maxOf(s.value * px / 454f * 1.25f, 7.5f).sp
