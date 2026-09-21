package com.orbitalempire.wear

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.wear.compose.material.Chip
import androidx.wear.compose.material.ChipDefaults
import androidx.wear.compose.material.CircularProgressIndicator
import androidx.wear.compose.material.Text

/**
 * The one screen a watch that has never been connected can show.
 *
 * IT ASKS THE PHONE TO DO THE PART A WATCH CANNOT. A token is minted
 * only by a signed-in session, the session is a cookie in a browser,
 * and a watch has neither a browser nor a keyboard anyone would type an
 * email address on. So the button hands the phone a URL -- the game
 * itself, carrying this watch's pairing code -- and the game's own
 * shell binds it while it loads. The watch then polls for the token the
 * binding mints.
 *
 * THE PLAYER IS TOLD TO LOOK AT THEIR PHONE, because they will not
 * otherwise. The phone lights up somewhere in a pocket and the watch
 * would sit here looking broken for the thirty seconds it takes them to
 * notice.
 *
 * NO CODE IS SHOWN. An earlier shape of this displayed the pairing code
 * for the player to type; it is 32 characters of base64, which is a
 * cruel thing to ask of anyone and impossible on a watch. The code
 * never leaves the device except inside the URL the device itself sends.
 */
@Composable
fun PairingScreen(ui: WearViewModel.UiState, vm: WearViewModel) {
  Column(
    modifier = Modifier
      .fillMaxSize()
      .verticalScroll(rememberScrollState())
      .padding(horizontal = 16.dp, vertical = 28.dp),
    horizontalAlignment = Alignment.CenterHorizontally,
  ) {
    Text(
      "ORBITAL",
      color = Ink,
      fontSize = 16.sp,
      fontWeight = FontWeight.Bold,
      textAlign = TextAlign.Center,
    )

    when {
      ui.pairing -> {
        CircularProgressIndicator(
          modifier = Modifier.padding(top = 12.dp).size(24.dp),
          indicatorColor = Ink,
          strokeWidth = 2.dp,
        )
        Text(
          ui.notice ?: "Connecting…",
          color = Warn,
          fontSize = 12.sp,
          textAlign = TextAlign.Center,
          modifier = Modifier.padding(top = 10.dp),
        )
        Text(
          "Open Orbital on your phone and sign in if it asks.",
          color = Dim,
          fontSize = 11.sp,
          textAlign = TextAlign.Center,
          modifier = Modifier.padding(top = 6.dp),
        )
      }

      else -> {
        Text(
          "Connect this watch to your empire.",
          color = Dim,
          fontSize = 12.sp,
          textAlign = TextAlign.Center,
          modifier = Modifier.padding(top = 8.dp, bottom = 12.dp),
        )
        Chip(
          onClick = { vm.connect() },
          colors = ChipDefaults.primaryChipColors(),
          label = {
            Text("OPEN ON PHONE", fontSize = 12.sp, fontWeight = FontWeight.Bold)
          },
          modifier = Modifier.fillMaxWidth(),
        )
      }
    }

    val error = ui.error
    if (error != null) {
      Text(
        error,
        color = Alarm,
        fontSize = 11.sp,
        textAlign = TextAlign.Center,
        modifier = Modifier.padding(top = 10.dp),
      )
    }
  }
}
