package com.orbitalempire.wear

import android.Manifest
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.wear.compose.foundation.lazy.ScalingLazyColumn
import androidx.wear.compose.foundation.lazy.items
import androidx.wear.compose.foundation.lazy.rememberScalingLazyListState
import androidx.wear.compose.material.CompactChip
import androidx.wear.compose.material.Text
import com.orbitalempire.wear.SkyEngine.Body
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlin.math.roundToInt

/**
 * THE SKY SCREEN: where the location is granted, and what is up.
 *
 * Every sky complication opens it. With no location it asks for one
 * (coarse is plenty: the sky does not change across a city). With one,
 * it lists every body: those above the horizon by compass direction and
 * height, brightest first; those below by when they next rise.
 */
class SkyActivity : ComponentActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    setContent { OrbitalWearTheme { SkyScreen() } }
  }
}

private val BODY_INK = mapOf(
  Body.SUN to Color(0xFFFFD75A), Body.MOON to Color(0xFFF0EFE6), Body.MERCURY to Color(0xFFC9BFAE),
  Body.VENUS to Color(0xFFFFF6D8), Body.MARS to Color(0xFFFF6B4A), Body.JUPITER to Color(0xFFF2DCB0),
  Body.SATURN to Color(0xFFEAD08A), Body.URANUS to Color(0xFF9FE6EA), Body.NEPTUNE to Color(0xFF7D9BFF),
)

private val POINTS = listOf("N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW")

private fun compass(az: Double): String = POINTS[((az / 22.5).roundToInt()) % 16]

private class SkyRow(val body: Body, val up: Boolean, val alt: Double, val az: Double, val next: Long?)

@Composable
private fun SkyScreen() {
  val c = LocalContext.current
  val scope = rememberCoroutineScope()
  var fix by remember { mutableStateOf(SkyLocation.saved(c)) }
  var granted by remember { mutableStateOf(SkyLocation.granted(c)) }
  var busy by remember { mutableStateOf(false) }
  var now by remember { mutableLongStateOf(System.currentTimeMillis()) }

  fun locate() {
    busy = true
    scope.launch {
      // Forced: someone who pressed the button wants a fix now.
      fix = SkyLocation.refresh(c, maxAgeMs = 0L)
      busy = false
      SkyComplications.refreshAll(c)
    }
  }

  val ask = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { ok ->
    granted = ok || SkyLocation.granted(c)
    if (granted) locate()
  }

  // Opening the screen refreshes a stale fix, and the list keeps time.
  LaunchedEffect(Unit) {
    if (granted) fix = SkyLocation.refresh(c)
    while (true) {
      delay(30_000)
      now = System.currentTimeMillis()
    }
  }

  val f = fix
  val rows = remember(f, now / 60_000) {
    if (f == null) emptyList()
    else Body.values().map { b ->
      val p = SkyEngine.position(b, now, f.lat, f.lon)
      val h0 = SkyEngine.horizonFor(b)
      val up = p.alt > 0
      SkyRow(b, up, p.alt, p.az, if (up) null else SkyEngine.nextCrossing(b, now, f.lat, f.lon, h0, rising = true))
    }.sortedWith(compareBy<SkyRow>({ !it.up }, { if (it.up) -it.alt else (it.next ?: Long.MAX_VALUE).toDouble() }))
  }

  ScalingLazyColumn(
    state = rememberScalingLazyListState(),
    modifier = Modifier.fillMaxSize().background(Ground),
    horizontalAlignment = Alignment.CenterHorizontally,
  ) {
    item { Text("ORBITAL SKY", color = Ink, fontSize = 13.sp, fontFamily = GameFont) }

    if (f == null) {
      item {
        Text(
          "The sky face draws the Sun, the Moon and the planets for where you stand.",
          color = Dim, fontSize = 11.sp, textAlign = TextAlign.Center,
          modifier = Modifier.padding(horizontal = 10.dp, vertical = 6.dp),
        )
      }
      item {
        CompactChip(
          onClick = { if (granted) locate() else ask.launch(Manifest.permission.ACCESS_COARSE_LOCATION) },
          label = { Text(if (busy) "FINDING YOU…" else "USE MY LOCATION", fontSize = 11.sp) },
        )
      }
      return@ScalingLazyColumn
    }

    item {
      val ph = SkyEngine.moonPhase(now)
      Text(
        "MOON ${(ph.fraction * 100).roundToInt()}% · ${ph.name}",
        color = Dim, fontSize = 9.sp, fontFamily = GameFont,
        modifier = Modifier.padding(bottom = 4.dp),
      )
    }

    items(rows) { r ->
      Row(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 2.dp),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
      ) {
        Text(
          r.body.label.uppercase(),
          color = if (r.up) BODY_INK.getValue(r.body) else Dim,
          fontSize = 11.sp,
          fontFamily = GameFont,
        )
        Text(
          when {
            r.up -> "${compass(r.az)} ${r.alt.roundToInt()}°"
            r.next != null -> "RISES ${SkyComplications.clock(c, r.next)}"
            else -> "BELOW"
          },
          color = if (r.up) Ink else Dim,
          fontSize = 10.sp,
          fontFamily = GameFont,
        )
      }
    }

    item {
      val ageMin = ((System.currentTimeMillis() - f.at) / 60_000L).toInt()
      Text(
        "LOCATION ${when { ageMin < 2 -> "JUST NOW"; ageMin < 120 -> "${ageMin}M AGO"; else -> "${ageMin / 60}H AGO" }}",
        color = Dim, fontSize = 8.sp, fontFamily = GameFont,
        modifier = Modifier.padding(top = 6.dp),
      )
    }
    item {
      CompactChip(
        onClick = { if (granted) locate() else ask.launch(Manifest.permission.ACCESS_COARSE_LOCATION) },
        label = { Text(if (busy) "…" else "UPDATE LOCATION", fontSize = 10.sp) },
        modifier = Modifier.padding(top = 2.dp),
      )
    }
  }
}
