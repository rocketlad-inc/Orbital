package com.orbitalempire.wear

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.wear.compose.foundation.lazy.ScalingLazyColumn
import androidx.wear.compose.foundation.lazy.items
import androidx.wear.compose.foundation.lazy.rememberScalingLazyListState
import androidx.wear.compose.material.ChipDefaults
import androidx.wear.compose.material.CircularProgressIndicator
import androidx.wear.compose.material.CompactChip
import androidx.wear.compose.material.Text

/**
 * The senate, and the only place this app changes the game.
 *
 * THREE BUTTONS AND NO CONFIRMATION STEP. A confirmation is the right
 * design when a mistap is expensive and irreversible; a senate vote is
 * neither. castVoteCore updates an existing vote rather than refusing
 * it, so the window stays open to a change of mind, and the row shows
 * what you voted the instant the server agrees. Adding "are you sure"
 * to a one-second interaction would double its length to protect
 * against something the next tap already fixes.
 *
 * THE TALLY IS SHOWN, AND IT IS WEIGHT AND NOT HEADS. Senate weight is
 * the currency of this system -- a large empire's yea is worth more
 * than a small one's -- and a watch showing "3 YEA" against a bill
 * carried by weight would be a different game's scoreboard.
 *
 * WHAT IS NOT HERE: proposing. A bill's title and summary are prose,
 * and there is no way to write prose on a watch that is not worse than
 * waiting until you have a phone. The watch votes on what the senate
 * has put in front of you and nothing more, which is also why the
 * token's scope stops exactly there (migration 0136).
 */
@Composable
fun SenateScreen(ui: WearViewModel.UiState, vm: WearViewModel) {
  val s = ui.state
  val listState = rememberScalingLazyListState()
  val error = ui.error

  ScalingLazyColumn(
    state = listState,
    modifier = Modifier.fillMaxWidth(),
    horizontalAlignment = Alignment.CenterHorizontally,
  ) {
    item {
      Text(
        "SENATE",
        color = Ink,
        fontSize = 12.sp,
        fontWeight = FontWeight.Bold,
        fontFamily = FontFamily.Monospace,
      )
    }

    if (!s.isLive) {
      item { Banner("NOT IN SESSION", Dim) }
      return@ScalingLazyColumn
    }

    if (error != null) {
      item { Banner(error, Alarm) }
    }

    if (s.senate.isEmpty()) {
      item { Banner("NO OPEN BILLS", Dim) }
      return@ScalingLazyColumn
    }

    items(s.senate) { bill ->
      BillCard(
        bill = bill,
        busy = ui.voting == bill.id,
        onVote = { choice -> vm.vote(bill, choice) },
      )
    }
  }
}

@Composable
private fun BillCard(bill: Bill, busy: Boolean, onVote: (String) -> Unit) {
  Column(
    modifier = Modifier
      .fillMaxWidth()
      .padding(vertical = 5.dp)
      .clip(RoundedCornerShape(12.dp))
      .background(Trough)
      .padding(horizontal = 8.dp, vertical = 6.dp),
    horizontalAlignment = Alignment.CenterHorizontally,
  ) {
    Text(
      bill.title.uppercase(),
      color = Ink,
      fontSize = 12.sp,
      fontWeight = FontWeight.Bold,
      textAlign = TextAlign.Center,
      maxLines = 2,
      overflow = TextOverflow.Ellipsis,
    )
    Text(
      // The summary is real prose written by the proposer, so it is
      // shown as written and clipped rather than upper-cased: this is
      // the one string on the watch that is somebody's argument.
      bill.summary,
      color = Dim,
      fontSize = 10.sp,
      textAlign = TextAlign.Center,
      maxLines = 3,
      overflow = TextOverflow.Ellipsis,
      modifier = Modifier.padding(top = 2.dp),
    )
    Text(
      if (bill.closesIn <= 0) "CLOSING NOW" else "CLOSES IN ${bill.closesIn}T",
      color = if (bill.closesIn <= 1) Alarm else Warn,
      fontSize = 9.sp,
      fontFamily = FontFamily.Monospace,
      modifier = Modifier.padding(top = 3.dp),
    )

    TallyBar(bill)

    if (busy) {
      // The buttons are REPLACED rather than merely disabled: a row of
      // greyed chips reads as "this bill cannot be voted on", which is
      // the wrong message when the truth is "your vote is on its way".
      CircularProgressIndicator(
        modifier = Modifier.padding(top = 6.dp).size(20.dp),
        indicatorColor = Ink,
        strokeWidth = 2.dp,
      )
    } else {
      Row(
        modifier = Modifier.fillMaxWidth().padding(top = 6.dp),
        horizontalArrangement = Arrangement.SpaceEvenly,
      ) {
        VoteChip("YEA", Good, bill.myVote == "yea") { onVote("yea") }
        VoteChip("NAY", Alarm, bill.myVote == "nay") { onVote("nay") }
        VoteChip("ABS", Dim, bill.myVote == "abstain") { onVote("abstain") }
      }
    }
  }
}

/**
 * Which way the bill is going, by weight.
 *
 * DRAWN EVEN WHEN NOBODY HAS VOTED, as an empty trough, because a bar
 * that appears only once the tally is non-zero makes the card jump
 * height the moment you vote on it -- on a scrolling list, under your
 * own finger.
 */
@Composable
private fun TallyBar(bill: Bill) {
  val total = (bill.yea + bill.nay).coerceAtLeast(1)
  Row(
    modifier = Modifier
      .fillMaxWidth()
      .padding(top = 5.dp)
      .height(4.dp)
      .clip(RoundedCornerShape(2.dp))
      .background(Trough),
  ) {
    if (bill.yea > 0) {
      Box(
        Modifier
          .weight(bill.yea.toFloat() / total)
          .fillMaxHeight()
          .background(Good),
      )
    }
    if (bill.nay > 0) {
      Box(
        Modifier
          .weight(bill.nay.toFloat() / total)
          .fillMaxHeight()
          .background(Alarm),
      )
    }
    if (bill.yea == 0 && bill.nay == 0) {
      Box(Modifier.weight(1f).fillMaxHeight().background(Trough))
    }
  }
  Text(
    "${bill.yea} / ${bill.nay}",
    color = Dim,
    fontSize = 9.sp,
    fontFamily = FontFamily.Monospace,
    modifier = Modifier.padding(top = 2.dp),
  )
}

/**
 * One vote button.
 *
 * THE CHOICE YOU ALREADY MADE IS FILLED IN, in its own colour; the
 * other two sit back against the page. On a screen too small for a
 * separate "you voted YEA" line, the button itself has to carry it --
 * and it is still a button, because changing your mind while the window
 * is open is a legal move the server supports.
 */
@Composable
private fun VoteChip(label: String, tint: Color, chosen: Boolean, onClick: () -> Unit) {
  CompactChip(
    onClick = onClick,
    colors = if (chosen) {
      ChipDefaults.primaryChipColors(backgroundColor = tint, contentColor = Ground)
    } else {
      ChipDefaults.secondaryChipColors(backgroundColor = Ground, contentColor = tint)
    },
    label = {
      Text(
        label,
        fontSize = 10.sp,
        fontWeight = if (chosen) FontWeight.Bold else FontWeight.Normal,
        fontFamily = FontFamily.Monospace,
      )
    },
  )
}
