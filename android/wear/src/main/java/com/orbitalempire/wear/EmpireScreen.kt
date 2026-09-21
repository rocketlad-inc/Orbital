package com.orbitalempire.wear

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.wear.compose.foundation.lazy.ScalingLazyColumn
import androidx.wear.compose.foundation.lazy.rememberScalingLazyListState
import androidx.wear.compose.material.CircularProgressIndicator
import androidx.wear.compose.material.CompactChip
import androidx.wear.compose.material.Text
import kotlinx.coroutines.delay
import kotlin.math.abs
import kotlin.math.roundToLong

/**
 * What the empire holds, and what it is making.
 *
 * THE RATE IS THE POINT, NOT THE BALANCE. A stockpile answers "can I
 * afford this", which is a question you ask with the game open in front
 * of you. On a wrist, between meetings, the question is "is it going
 * up" -- so every row carries its per-tick figure, and the countdown to
 * the next tick sits at the top because it is how long the answer has
 * left to be true.
 */
@Composable
fun EmpireScreen(ui: WearViewModel.UiState, vm: WearViewModel) {
  val s = ui.state
  val listState = rememberScalingLazyListState()
  // Bound out of the state object before the list builder runs: a
  // nullable property read inside a lambda does not smart-cast, and the
  // failure is a compile error rather than anything subtle.
  val error = ui.error

  // NET IS ONLY SHOWN WHEN IT IS BAD NEWS, and that is the whole reason
  // the document carries it. Income says what the empire earns; net
  // says what the pool actually did after upkeep and spending. When
  // they agree, the rate beside each resource has already said it, and
  // a second identical number is noise. When they disagree -- earning
  // 40 metal a tick and still going backwards -- that is the one thing
  // a player wants to have caught from a wrist, and it is invisible
  // from the balance until the pool runs out.
  val deficits = buildList {
    val m = s.perTick.netMetal
    val c = s.perTick.netCredits
    if (m != null && m < 0) add("METAL")
    if (c != null && c < 0) add("CREDITS")
  }

  ScalingLazyColumn(
    state = listState,
    modifier = Modifier.fillMaxWidth(),
    horizontalAlignment = Alignment.CenterHorizontally,
  ) {
    item { Header(s) }

    if (ui.loading && s.tick == 0) {
      item { CircularProgressIndicator(modifier = Modifier.padding(16.dp)) }
    }

    if (!s.isLive) {
      item { Banner(phaseLine(s.phase)) }
    }

    item {
      ResourceRow("METAL", s.metal, s.perTick.metal, MetalInk, live = s.isLive)
    }
    item {
      ResourceRow("CREDITS", s.credits, s.perTick.credits, CreditInk, live = s.isLive)
    }
    item {
      // SCIENCE HAS NO UPKEEP AND IS NOT SPENDABLE, so its rate is
      // simply its delta and there is no net figure to disagree with it.
      ResourceRow("SCIENCE", s.science, s.perTick.science, ScienceInk, live = s.isLive)
    }

    if (s.isLive && s.perTick.samples == 0) {
      item {
        Text(
          "RATES NEED A FEW TICKS",
          color = Dim,
          fontSize = 10.sp,
          textAlign = TextAlign.Center,
          modifier = Modifier.padding(top = 4.dp),
        )
      }
    }

    if (s.isLive && deficits.isNotEmpty()) {
      item {
        Text(
          "${deficits.joinToString(" & ")} FALLING",
          color = Alarm,
          fontSize = 10.sp,
          fontFamily = FontFamily.Monospace,
          textAlign = TextAlign.Center,
          modifier = Modifier.padding(top = 4.dp),
        )
      }
    }

    if (s.isLive) {
      item { AttentionLine(s) }
    }

    if (error != null) {
      item { Banner(error, Alarm) }
    }

    item {
      CompactChip(
        onClick = { vm.refresh() },
        label = { Text(if (ui.loading) "…" else "REFRESH", fontSize = 11.sp) },
        modifier = Modifier.padding(top = 6.dp),
      )
    }
  }
}

@Composable
private fun Header(s: WearState) {
  Column(horizontalAlignment = Alignment.CenterHorizontally) {
    Text(
      s.faction.ifEmpty { "ORBITAL" }.uppercase(),
      color = factionColor(s.color),
      fontSize = 13.sp,
      fontWeight = FontWeight.Bold,
      textAlign = TextAlign.Center,
    )
    Text(
      if (s.isLive) "TICK ${s.tick} · ${countdownText(s)}" else "TICK ${s.tick}",
      color = Dim,
      fontSize = 10.sp,
      fontFamily = FontFamily.Monospace,
    )
  }
}

/**
 * "NEXT IN 4M12S", ticking down once a second.
 *
 * AGAINST THE SERVER'S CLOCK, NOT THE WATCH'S. The document carries the
 * server's own `now`; the difference between that and the watch's clock
 * at the moment it arrived is held as an offset and applied forever
 * after. A watch four minutes fast would otherwise count a tick as
 * already past while the game is still waiting for it, and the player
 * would believe the watch.
 */
@Composable
private fun countdownText(s: WearState): String {
  if (s.nextTickAt <= 0L) return "PAUSED"
  val skew = remember(s.serverNow) { s.serverNow - System.currentTimeMillis() }
  var now by remember { mutableLongStateOf(System.currentTimeMillis() + skew) }
  LaunchedEffect(s.nextTickAt, skew) {
    while (true) {
      now = System.currentTimeMillis() + skew
      delay(1_000)
    }
  }
  val ms = s.nextTickAt - now
  if (ms <= 0) return "ANY MOMENT"
  val total = ms / 1000
  val h = total / 3600
  val m = (total % 3600) / 60
  val sec = total % 60
  return when {
    h > 0 -> "NEXT IN ${h}H${m}M"
    m > 0 -> "NEXT IN ${m}M${sec.toString().padStart(2, '0')}S"
    else -> "NEXT IN ${sec}S"
  }
}

/**
 * One resource: what you hold, and what a tick adds.
 *
 * THE RATE IS DRAWN EVEN WHEN IT IS NULL, as a dash. A blank would read
 * as zero at this size, and "we have not got two ledger rows to
 * difference yet" is not the same news as "you are earning nothing".
 */
@Composable
private fun ResourceRow(
  label: String,
  amount: Long,
  perTick: Double?,
  ink: Color,
  live: Boolean,
) {
  Row(
    modifier = Modifier.fillMaxWidth().padding(horizontal = 6.dp, vertical = 3.dp),
    verticalAlignment = Alignment.CenterVertically,
    horizontalArrangement = Arrangement.SpaceBetween,
  ) {
    Column {
      Text(label, color = Dim, fontSize = 9.sp, fontFamily = FontFamily.Monospace)
      Text(
        compact(amount),
        color = ink,
        fontSize = 18.sp,
        fontWeight = FontWeight.Bold,
        fontFamily = FontFamily.Monospace,
      )
    }
    Text(
      when {
        !live -> "—"
        perTick == null -> "—"
        else -> "${sign(perTick)}${compact(abs(perTick).roundToLong())}/T"
      },
      color = when {
        !live || perTick == null -> Dim
        perTick < 0 -> Alarm
        perTick > 0 -> Good
        else -> Dim
      },
      fontSize = 12.sp,
      fontFamily = FontFamily.Monospace,
    )
  }
}

/** The counts the widget card carries, as one line. Only the ones that
 *  are non-zero: a row of zeroes is four pixels of nothing on a screen
 *  that has none to spare. */
@Composable
private fun AttentionLine(s: WearState) {
  val bits = buildList {
    if (s.attention.fighting > 0) add("${s.attention.fighting} FIGHTING" to Alarm)
    if (s.attention.inbound > 0) add("${s.attention.inbound} INBOUND" to Alarm)
    if (s.attention.bills > 0) add("${s.attention.bills} TO VOTE" to Warn)
    if (s.attention.offers > 0) add("${s.attention.offers} OFFERS" to Warn)
    if (s.attention.unread > 0) add("${s.attention.unread} UNREAD" to Dim)
  }
  if (bits.isEmpty()) {
    Text("ALL QUIET", color = Dim, fontSize = 10.sp, modifier = Modifier.padding(top = 6.dp))
    return
  }
  Column(
    horizontalAlignment = Alignment.CenterHorizontally,
    modifier = Modifier.padding(top = 6.dp),
  ) {
    bits.forEach { (text, color) ->
      Text(text, color = color, fontSize = 11.sp, fontFamily = FontFamily.Monospace)
    }
  }
}

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

private fun phaseLine(phase: String) = when (phase) {
  "eliminated" -> "ELIMINATED"
  "ended" -> "GAME OVER"
  "none" -> "NO GAME YET"
  else -> ""
}

private fun sign(v: Double) = if (v < 0) "−" else "+"

/** 12400 -> 12.4K. The same thresholds the widget card uses, so one
 *  number does not read as two different sizes on two surfaces. */
internal fun compact(n: Long): String = when {
  n >= 1_000_000 -> String.format("%.1fM", n / 1_000_000.0)
  n >= 10_000 -> "${(n / 1000.0).roundToLong()}K"
  n >= 1000 -> String.format("%.1fK", n / 1000.0)
  else -> n.toString()
}
