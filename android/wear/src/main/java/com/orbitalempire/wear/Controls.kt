package com.orbitalempire.wear

import android.view.HapticFeedbackConstants
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.unit.Dp
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.wear.compose.material.Text
import kotlinx.coroutines.launch

/**
 * HOLD TO CONFIRM, for the orders a stray touch must not give: retreat,
 * detonate, send, accept, build. Not a confirm dialog: that doubles every
 * order's length to guard against a tap, and a hold guards against the
 * tap by itself. Changeable settings (stance, thresholds) are plain taps
 * -- the next tap undoes them, the same reasoning the senate vote made.
 *
 * THE RIM FILLS, NOT THE BUTTON. With a RimHold in scope (the app always
 * provides one) the hold is drawn round the whole bezel with what it is
 * confirming on the top arc, so the thumb on the button hides nothing.
 * The ring glyph on the button marks it as a hold before it is touched.
 * Without one (a tile preview, a test) it falls back to filling itself.
 */
@Composable
fun HoldButton(
  label: String,
  tint: Color,
  modifier: Modifier = Modifier,
  enabled: Boolean = true,
  holdMs: Int = 900,
  filled: Boolean = false,
  height: Dp = 36.dp,
  onConfirm: () -> Unit,
) {
  val rim = LocalRimHold.current
  val own = remember { Animatable(0f) }
  val progress = rim?.progress ?: own
  val scope = rememberCoroutineScope()
  val view = LocalView.current
  Box(
    modifier
      .fillMaxWidth()
      .height(height)
      .clip(RoundedCornerShape(height / 2))
      .background(if (filled && enabled) tint else Trough)
      .then(if (!filled || !enabled) Modifier.border(1.5.dp, if (enabled) tint.copy(alpha = 0.8f) else Trough, RoundedCornerShape(height / 2)) else Modifier)
      .drawBehind {
        if (rim == null) drawRect(tint.copy(alpha = 0.5f), size = Size(size.width * own.value, size.height))
      }
      .pointerInput(enabled) {
        if (!enabled) return@pointerInput
        detectTapGestures(onPress = {
          rim?.tint = tint
          rim?.label = "HOLD TO ${label}"
          val job = scope.launch {
            progress.snapTo(0f)
            progress.animateTo(1f, tween(holdMs, easing = LinearEasing))
            view.performHapticFeedback(HapticFeedbackConstants.LONG_PRESS)
            onConfirm()
            progress.snapTo(0f)
            rim?.label = null
          }
          tryAwaitRelease()
          if (job.isActive) {
            job.cancel()
            scope.launch {
              progress.animateTo(0f, tween(150))
              rim?.label = null
            }
          }
        })
      },
    contentAlignment = Alignment.Center,
  ) {
    Row(verticalAlignment = Alignment.CenterVertically) {
      if (enabled) {
        // THE HOLD GLYPH: a ring a third drawn, the shape the rim will make.
        Canvas(Modifier.size(11.dp)) {
          val w = 1.6.dp.toPx()
          drawCircle(if (filled) Ground.copy(alpha = 0.35f) else tint.copy(alpha = 0.35f), radius = size.minDimension / 2 - w, style = Stroke(w))
          drawArc(if (filled) Ground else tint, -90f, 130f, false, Offset(w, w), Size(size.width - 2 * w, size.height - 2 * w), style = Stroke(w, cap = StrokeCap.Round))
        }
        Box(Modifier.width(5.dp))
      }
      Text(
        label,
        color = if (!enabled) Dim else if (filled) Ground else tint,
        fontSize = 10.sp,
        textAlign = TextAlign.Center,
        maxLines = 1,
      )
    }
  }
}

/** A plain-tap button, for things the next tap undoes. [outline] draws
 *  it in its colour on a dark tint, the design's secondary action. */
@Composable
fun TapButton(
  label: String,
  tint: Color,
  modifier: Modifier = Modifier,
  height: Dp = 32.dp,
  outline: Boolean = false,
  onClick: () -> Unit,
) {
  Box(
    modifier
      .fillMaxWidth()
      .height(height)
      .clip(RoundedCornerShape(height / 2))
      .background(if (outline) tint.copy(alpha = 0.12f) else Trough)
      .then(if (outline) Modifier.border(1.5.dp, tint.copy(alpha = 0.85f), RoundedCornerShape(height / 2)) else Modifier)
      .clickable(onClick = onClick),
    contentAlignment = Alignment.Center,
  ) {
    Text(label, color = tint, fontSize = 10.sp, maxLines = 1)
  }
}

/** A row of choices, one lit: stance, thresholds, target presets. */
@Composable
fun ChoiceRow(label: String, options: List<Pair<String, Any?>>, selected: Any?, enabled: Boolean, onPick: (Any?) -> Unit) {
  Text(label, color = Dim, fontSize = 8.sp, modifier = Modifier.padding(top = 6.dp, bottom = 2.dp))
  Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(3.dp)) {
    for ((text, value) in options) {
      val on = value == selected
      Box(
        Modifier
          .weight(1f)
          .height(28.dp)
          .clip(RoundedCornerShape(14.dp))
          .background(if (on) Color(0xFF4ECDC4) else Trough)
          .then(if (enabled) Modifier.clickable { if (!on) onPick(value) } else Modifier),
        contentAlignment = Alignment.Center,
      ) {
        Text(text, color = if (on) Ground else if (enabled) Ink else Dim, fontSize = 8.sp, maxLines = 1)
      }
    }
  }
}

/** The last order's outcome, in the game's words. */
@Composable
fun OrderStatus(ui: WearViewModel.UiState) {
  val text = when {
    ui.ordering -> "SENDING…"
    ui.error != null -> ui.error
    ui.notice != null -> ui.notice
    else -> null
  } ?: return
  Text(
    text.uppercase(),
    color = when {
      ui.ordering -> Dim
      ui.error != null -> Alarm
      else -> Good
    },
    fontSize = 8.sp,
    textAlign = TextAlign.Center,
    maxLines = 3,
    modifier = Modifier.fillMaxWidth().padding(vertical = 3.dp),
  )
}

/** A one-line notice across the page. */
@Composable
internal fun Banner(text: String, color: Color = Warn) {
  Text(
    text,
    color = color,
    fontSize = 11.sp,
    textAlign = TextAlign.Center,
    modifier = Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 4.dp),
  )
}

/** 12400 -> 12K. The same thresholds the widget card uses, so one number
 *  does not read as two different sizes on two surfaces. */
internal fun compact(n: Long): String = when {
  n >= 1_000_000 -> String.format("%.1fM", n / 1_000_000.0)
  n >= 10_000 -> "${Math.round(n / 1000.0)}K"
  n >= 1000 -> String.format("%.1fK", n / 1000.0)
  n <= -1000 -> "-" + compact(-n)
  else -> n.toString()
}
