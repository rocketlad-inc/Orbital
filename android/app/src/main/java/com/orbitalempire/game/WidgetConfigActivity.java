package com.orbitalempire.game;

import android.appwidget.AppWidgetManager;
import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;

/**
 * Runs the moment the widget is dropped on the home screen, and connects
 * it without the player being asked to do anything.
 *
 * WHAT THIS REPLACES: opening the game, finding Notifications, and
 * pressing "Send to widget". That was three steps too many for something
 * the phone can do by itself, and it is the bit that made a simple
 * feature feel convoluted.
 *
 * WHAT IT CANNOT REPLACE is the token. The game runs in Chrome — that is
 * what a Trusted Web Activity is — so the session cookie lives in
 * Chrome's process under Chrome's sandbox, and no Android API hands it to
 * the host app. This activity therefore does the one thing that does
 * work: it opens a page in the browser, which carries the session the way
 * any page does, and that page bounces straight back here on orbital://
 * with a credential scoped to rendering one image.
 *
 * IT RETURNS RESULT_OK BEFORE THE ROUND TRIP, deliberately. A
 * configuration activity that returns anything else makes the launcher
 * throw the widget away — so waiting for the browser and reporting the
 * outcome would mean a player who takes too long, or is signed out,
 * loses the widget they just placed. Instead the widget is placed
 * immediately, shows its hint, and fills in when the token lands.
 */
public class WidgetConfigActivity extends Activity {

  @Override
  protected void onCreate(Bundle saved) {
    super.onCreate(saved);

    int id = AppWidgetManager.INVALID_APPWIDGET_ID;
    Bundle extras = getIntent() == null ? null : getIntent().getExtras();
    if (extras != null) {
      id = extras.getInt(AppWidgetManager.EXTRA_APPWIDGET_ID, AppWidgetManager.INVALID_APPWIDGET_ID);
    }

    Intent result = new Intent().putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, id);
    setResult(RESULT_OK, result);

    // A second widget does not need a second round trip: one token feeds
    // every instance, and re-minting would quietly orphan the first.
    if (OrbitalWidget.hasToken(this)) {
      OrbitalWidget.refreshAll(this);
      finish();
      return;
    }

    // ACTION_VIEW on our own verified host, so this opens inside the app
    // rather than in a separate browser the player then has to dismiss.
    Intent connect = new Intent(Intent.ACTION_VIEW,
        Uri.parse("https://orbital-empire.com/widget/connect"));
    connect.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
    try {
      startActivity(connect);
    } catch (Exception ignored) {
      // No browser at all is not a state worth crashing over; the widget
      // is already placed and still says how to connect it by hand.
    }
    finish();
  }
}
