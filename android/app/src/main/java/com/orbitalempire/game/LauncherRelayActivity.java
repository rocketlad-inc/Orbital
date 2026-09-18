package com.orbitalempire.game;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;

/**
 * Tapping the widget opens the game.
 *
 * It goes through a relay rather than pointing the PendingIntent
 * straight at the TWA launcher because that launcher is a third-party
 * class (androidbrowserhelper's LauncherActivity) whose launch mode and
 * flags are not ours to reason about. Starting it from an activity of
 * our own with CLEAR_TOP means a tap reuses the running game instead of
 * stacking a second copy of it behind the first — the symptom of which
 * is Back appearing to do nothing.
 */
public class LauncherRelayActivity extends Activity {

  @Override
  protected void onCreate(Bundle saved) {
    super.onCreate(saved);
    Intent game = new Intent(this,
        com.google.androidbrowserhelper.trusted.LauncherActivity.class);
    game.setAction(Intent.ACTION_MAIN);
    game.addCategory(Intent.CATEGORY_LAUNCHER);
    game.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
    startActivity(game);
    finish();
  }
}
