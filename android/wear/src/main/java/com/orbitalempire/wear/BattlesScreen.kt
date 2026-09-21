package com.orbitalempire.wear

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.wear.compose.foundation.lazy.ScalingLazyColumn
import androidx.wear.compose.foundation.lazy.items
import androidx.wear.compose.foundation.lazy.rememberScalingLazyListState
import androidx.wear.compose.material.Text

/**
 * What is burning, and what is on its way.
 *
 * IT BORROWS THE SITUATION LOG'S GRAMMAR, because the log already
 * solved "how do you draw a fight" and a wrist is an even worse place
 * than a home screen to invent a second visual language for the same
 * thing. Taken straight across from SituationLog.tsx and the battle
 * widget:
 *
 *   - THE SHAPE OF THE FIGHT FIRST, as one bar split between the sides
 *     and weighted by DAMAGE rather than hull count, because fifty
 *     freighters are not a fleet.
 *   - EACH SIDE IN ITS OWN LIVERY on the label, never on the hulls.
 *   - HULLS WEAR THEIR HEALTH, in the same green/amber/red ramp the log
 *     and the outliner use, so a colour means one thing everywhere.
 *   - AND GREY WHERE WE CANNOT SEE. Rival strength is gated behind
 *     Sensors research, and the server withholds the health rather than
 *     the presence: you get the size of the force and not its
 *     condition, which is what fog of war is supposed to feel like.
 *
 * WHAT IT DOES NOT DO IS DRAW THE SHIPS. The battle card renders each
 * hull as the game's own ShipIcon, rasterised server-side from the
 * component's exact SVG. That is right for a 512px card and wrong here:
 * at the size a hull gets on a watch an icon is four grey pixels, and
 * the player learns less from it than from a bar of the right colour.
 */
@Composable
fun BattlesScreen(ui: WearViewModel.UiState) {
  val s = ui.state
  val listState = rememberScalingLazyListState()

  ScalingLazyColumn(
    state = listState,
    modifier = Modifier.fillMaxWidth(),
    horizontalAlignment = Alignment.CenterHorizontally,
  ) {
    item {
      Text(
        "SITUATION",
        color = Ink,
        fontSize = 12.sp,
        fontWeight = FontWeight.Bold,
        fontFamily = FontFamily.Monospace,
      )
    }

    if (!s.isLive) {
      item { Banner("NOTHING TO REPORT", Dim) }
      return@ScalingLazyColumn
    }

    if (s.battles.isEmpty() && s.threats.isEmpty()) {
      item { Banner("NO CONTACT", Dim) }
    }

    items(s.battles) { BattleCard(it) }

    if (s.threats.isNotEmpty()) {
      item {
        Text(
          "INBOUND",
          color = Warn,
          fontSize = 10.sp,
          fontFamily = FontFamily.Monospace,
          modifier = Modifier.padding(top = 8.dp),
        )
      }
      items(s.threats) { ThreatRow(it) }
    }
  }
}

@Composable
private fun BattleCard(b: Battle) {
  Column(
    modifier = Modifier
      .fillMaxWidth()
      .padding(horizontal = 4.dp, vertical = 5.dp),
  ) {
    Row(
      modifier = Modifier.fillMaxWidth(),
      horizontalArrangement = Arrangement.SpaceBetween,
      verticalAlignment = Alignment.CenterVertically,
    ) {
      Text(
        b.body.uppercase(),
        color = Ink,
        fontSize = 12.sp,
        fontWeight = FontWeight.Bold,
        fontFamily = FontFamily.Monospace,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
        modifier = Modifier.weight(1f, fill = false),
      )
      // Kills and losses, in the colours they deserve. The battle card
      // reports the same pair; a player who has both surfaces should
      // read the same fight the same way.
      Text(
        "+${b.kills} −${b.lost}",
        color = if (b.lost > b.kills) Alarm else Good,
        fontSize = 10.sp,
        fontFamily = FontFamily.Monospace,
      )
    }

    DamageBar(b.sides)

    b.sides.forEach { side -> SideRow(side, known = b.known || side.mine) }

    if (!b.known) {
      Text(
        "NO SENSOR COVERAGE",
        color = Dim,
        fontSize = 8.sp,
        fontFamily = FontFamily.Monospace,
      )
    }
  }
}

/**
 * The headline: one bar, split by damage dealt.
 *
 * WEIGHTED BY DAMAGE AND NOT BY HULLS, which is the whole reason the
 * log draws it this way. A fleet of freighters does not shoot, and a
 * bar that counted them would tell a player they were winning a fight
 * they are losing.
 */
@Composable
private fun DamageBar(sides: List<Side>) {
  val total = sides.sumOf { it.damage }.coerceAtLeast(1)
  Canvas(
    modifier = Modifier
      .fillMaxWidth()
      .height(6.dp)
      .padding(vertical = 1.dp),
  ) {
    drawRoundRect(
      color = Trough,
      cornerRadius = CornerRadius(size.height / 2f),
    )
    var x = 0f
    sides.forEach { side ->
      val w = size.width * (side.damage.toFloat() / total)
      if (w > 0f) {
        drawRoundRect(
          color = factionColor(side.color),
          topLeft = Offset(x, 0f),
          size = Size(w, size.height),
          cornerRadius = CornerRadius(size.height / 2f),
        )
      }
      x += w
    }
  }
}

/** One side: its livery, who it is, and its order of battle as pips
 *  coloured by each hull's own health. */
@Composable
private fun SideRow(side: Side, known: Boolean) {
  Row(
    modifier = Modifier.fillMaxWidth().padding(top = 2.dp),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    // The rail. Empire identity lives here and on the label, never on
    // the hulls -- the same rule the situation log follows.
    Canvas(Modifier.width(6.dp).height(10.dp).padding(end = 3.dp)) {
      drawRoundRect(
        color = factionColor(side.color),
        cornerRadius = CornerRadius(size.width / 2f),
      )
    }
    Text(
      side.name.uppercase(),
      color = if (side.mine) Ink else Dim,
      fontSize = 9.sp,
      fontFamily = FontFamily.Monospace,
      maxLines = 1,
      overflow = TextOverflow.Ellipsis,
      modifier = Modifier.weight(1f),
    )
    HullPips(side.hulls, known)
    Text(
      " ${side.alive}",
      color = Dim,
      fontSize = 9.sp,
      fontFamily = FontFamily.Monospace,
    )
  }
}

/** Up to eight pips, each the colour of that hull's health. More than
 *  eight and they stop being countable, so the count beside them does
 *  the work instead. */
@Composable
private fun HullPips(hulls: List<Double?>, known: Boolean) {
  val shown = hulls.take(8)
  Canvas(
    Modifier
      .width(40.dp)
      .height(8.dp)
      .padding(horizontal = 1.dp),
  ) {
    // In device pixels via the density this DrawScope carries, not raw
    // floats: a hard-coded 4f is two pixels on one watch and four on
    // another, and the pips are the smallest thing on the screen.
    val pip = 3.dp.toPx()
    val gap = 2.dp.toPx()
    shown.forEachIndexed { i, hp ->
      drawRoundRect(
        color = healthColor(if (known) hp else null),
        topLeft = Offset(i * (pip + gap), size.height / 2f - pip / 2f),
        size = Size(pip, pip),
        cornerRadius = CornerRadius(pip / 3f),
      )
    }
  }
}

@Composable
private fun ThreatRow(t: Threat) {
  Row(
    modifier = Modifier.fillMaxWidth().padding(horizontal = 6.dp, vertical = 2.dp),
    horizontalArrangement = Arrangement.SpaceBetween,
  ) {
    Text(
      t.body,
      color = Ink,
      fontSize = 11.sp,
      fontFamily = FontFamily.Monospace,
      maxLines = 1,
      overflow = TextOverflow.Ellipsis,
      modifier = Modifier.weight(1f),
    )
    Text(
      // TICKS, NOT MINUTES. A player plans in ticks and an arrival is
      // recorded in them; converting to wall-clock here would invent a
      // precision the game does not have.
      "${t.ships} · ${etaText(t.eta)}",
      color = if ((t.eta ?: 99) <= 1) Alarm else Warn,
      fontSize = 11.sp,
      fontFamily = FontFamily.Monospace,
    )
  }
}

private fun etaText(t: Int?) = when {
  t == null -> "?"
  t <= 0 -> "NOW"
  else -> "IN ${t}T"
}
