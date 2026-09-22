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
import androidx.wear.compose.material.Text
import kotlinx.coroutines.launch

/**
 * HOLD TO CONFIRM, for the orders a stray touch must not give: retreat,
 * detonate, send, accept, build. The bar fills over [holdMs]; let go
 * early and nothing happens; reach the end and the watch buzzes and the
 * order goes. Not a confirm dialog: that doubles every order's length
 * to guard against a tap, and a hold guards against the tap by itself.
 * Changeable settings (stance, thresholds) are plain taps -- the next
 * tap undoes them, the same reasoning the senate vote made.
 */
@Composable
fun HoldButton(
  label: String,
  tint: Color,
  modifier: Modifier = Modifier,
  enabled: Boolean = true,
  holdMs: Int = 900,
  onConfirm: () -> Unit,
) {
  val progress = remember { Animatable(0f) }
  val scope = rememberCoroutineScope()
  val view = LocalView.current
  Box(
    modifier
      .fillMaxWidth()
      .height(36.dp)
      .clip(RoundedCornerShape(18.dp))
      .background(Trough)
      .drawBehind {
        drawRect(tint.copy(alpha = 0.5f), size = Size(size.width * progress.value, size.height))
      }
      .pointerInput(enabled) {
        if (!enabled) return@pointerInput
        detectTapGestures(onPress = {
          val job = scope.launch {
            progress.snapTo(0f)
            progress.animateTo(1f, tween(holdMs, easing = LinearEasing))
            view.performHapticFeedback(HapticFeedbackConstants.LONG_PRESS)
            onConfirm()
            progress.snapTo(0f)
          }
          tryAwaitRelease()
          if (job.isActive) {
            job.cancel()
            scope.launch { progress.animateTo(0f, tween(150)) }
          }
        })
      },
    contentAlignment = Alignment.Center,
  ) {
    Text(
      if (enabled) "HOLD · $label" else label,
      color = if (enabled) tint else Dim,
      fontSize = 10.sp,
      textAlign = TextAlign.Center,
      maxLines = 1,
    )
  }
}

/** A plain-tap button, for things the next tap undoes. */
@Composable
fun TapButton(label: String, tint: Color, modifier: Modifier = Modifier, onClick: () -> Unit) {
  Box(
    modifier
      .fillMaxWidth()
      .height(32.dp)
      .clip(RoundedCornerShape(16.dp))
      .background(Trough)
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
