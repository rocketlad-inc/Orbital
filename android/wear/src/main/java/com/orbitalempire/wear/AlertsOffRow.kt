package com.orbitalempire.wear

import android.Manifest
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.LifecycleResumeEffect
import androidx.wear.compose.material.Text

/**
 * "ALERTS ARE OFF", for as long as they are.
 *
 * The first-run prompt asks once and never again, which is right for a
 * nag but left a watch whose one prompt was dismissed collecting every
 * alert and posting none, with nothing on screen to say why. This row is
 * the way back: it shows only while the watch cannot post, re-asks on a
 * tap, and when Android will no longer show the prompt (refused twice),
 * opens Orbital's notification settings instead. Checked again on every
 * resume, so it disappears the moment they are turned on.
 */
@Composable
fun AlertsOffRow() {
  val ctx = LocalContext.current
  var allowed by remember { mutableStateOf(WatchAlerts.allowed(ctx)) }
  LifecycleResumeEffect(Unit) {
    allowed = WatchAlerts.allowed(ctx)
    onPauseOrDispose { }
  }
  val ask = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
    allowed = WatchAlerts.allowed(ctx)
    if (granted && allowed) {
      // The watch posts its own now: stop mirroring the phone's copies
      // and collect whatever is waiting.
      WatchAlerts.bridging(ctx)
      AlertWorker.kick(ctx)
    } else {
      openNotificationSettings(ctx)
    }
  }
  if (allowed) return

  Column(
    modifier = Modifier
      .fillMaxWidth()
      .padding(horizontal = 10.dp, vertical = 4.dp)
      .clickable {
        val permitted = Build.VERSION.SDK_INT < 33 ||
          ctx.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) ==
          android.content.pm.PackageManager.PERMISSION_GRANTED
        // Permission granted but notifications switched off for the app:
        // the prompt cannot help, only the settings screen can.
        if (permitted) openNotificationSettings(ctx)
        else ask.launch(Manifest.permission.POST_NOTIFICATIONS)
      },
    horizontalAlignment = Alignment.CenterHorizontally,
  ) {
    Text(
      "ALERTS ARE OFF",
      color = Alarm,
      fontSize = 11.sp,
      fontWeight = FontWeight.Bold,
      fontFamily = GameFont,
      textAlign = TextAlign.Center,
    )
    Text(
      "Tap to turn on",
      color = Dim,
      fontSize = 10.sp,
      textAlign = TextAlign.Center,
    )
  }
}

private fun openNotificationSettings(c: Context) {
  val app = Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
    .putExtra(Settings.EXTRA_APP_PACKAGE, c.packageName)
    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
  try {
    c.startActivity(app)
  } catch (t: Throwable) {
    // Some Wear builds lack the per-app notification screen; the app's
    // own details page always exists and links to it.
    try {
      c.startActivity(
        Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${c.packageName}"))
          .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
      )
    } catch (_: Throwable) {
    }
  }
}
