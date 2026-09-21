package com.orbitalempire.game;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.util.Log;

/**
 * Tapping the widget opens the game.
 *
 * It goes through a relay rather than pointing the PendingIntent
 * straight at the TWA launcher because that launcher is a third-party
 * class (androidbrowserhelper's LauncherActivity) whose launch mode and
 * flags are not ours to reason about. Starting it from an activity of
 * our own with CLEAR_TOP means a tap reuses the running game instead of
 * stacking a second copy of it behind the first -- the symptom of which
 * is Back appearing to do nothing.
 *
 * AN UNPAIRED WIDGET CONNECTS ITSELF FROM HERE. The tap is a real user
 * gesture in our own activity, so it may open anything; it opens the
 * connect page, which binds this device's code and then drops the
 * player into the game. So the widget's one instruction, "tap to
 * finish", is also the whole of the work. CLEAR_TOP alone would hand
 * the tap to a game already running and never navigate, so the connect
 * launch clears the task instead.
 */
public class LauncherRelayActivity extends Activity {

  private static final String TAG = "OrbitalWidget";

  @Override
  protected void onCreate(Bundle saved) {
    super.onCreate(saved);
    Intent game = new Intent(this,
        com.google.androidbrowserhelper.trusted.LauncherActivity.class);

    String connect = null;
    try {
      if (!WidgetWork.hasToken(this)) connect = WidgetWork.connectUrl(this);
    } catch (Throwable t) {
      Log.w(TAG, "could not build the connect url", t);
    }

    if (connect != null) {
      Log.i(TAG, "tap opens the connect page");
      game.setAction(Intent.ACTION_VIEW);
      game.setData(Uri.parse(connect));
      game.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK);
      OrbitalWidget.refreshAll(this, "tap-connect");
    } else {
      game.setAction(Intent.ACTION_MAIN);
      game.addCategory(Intent.CATEGORY_LAUNCHER);
      game.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
    }

    try {
      startActivity(game);
    } catch (Throwable t) {
      Log.w(TAG, "could not open the game", t);
    }
    finish();
  }
}
