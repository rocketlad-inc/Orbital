package com.orbitalempire.game;

import android.app.Activity;
import android.appwidget.AppWidgetManager;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.util.Base64;

import java.security.SecureRandom;

/**
 * Runs the moment the widget is dropped on the home screen, and connects
 * it without the player being asked to do anything.
 *
 * WHAT IT DOES: invents a pairing code, hands it to the receiver as
 * `pending_code`, opens the connect page with that code inside the game,
 * and asks the receiver to start polling. The page — signed in, because
 * its own fetch() carries the session cookie — binds the code to a
 * token; the receiver's poll collects it and paints. See migration 0135
 * for why this is pairing and not a redirect: a redirect back into the
 * app needs a user gesture Chrome will not grant to a page-load, and the
 * page itself arrives without the Strict cookie on an app-launched
 * navigation. Both silently produced nothing on a real phone.
 *
 * IT RETURNS RESULT_OK BEFORE ANY OF THAT, deliberately. A configuration
 * activity that returns anything else makes the launcher throw the
 * widget away — so a player who is signed out, or slow, would lose the
 * widget they just placed. Instead the widget is placed immediately,
 * shows "Connecting…", and fills in when the token lands.
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
    setResult(RESULT_OK, new Intent().putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, id));

    // A second widget does not need a second round trip: one token feeds
    // every instance, and re-pairing would quietly orphan the first.
    if (OrbitalWidget.hasToken(this)) {
      OrbitalWidget.refreshAll(this);
      finish();
      return;
    }

    // 24 random bytes, URL-safe. The code is the only secret in the
    // pairing and it never leaves this device except in the URL the
    // device itself opens.
    byte[] raw = new byte[24];
    new SecureRandom().nextBytes(raw);
    String code = Base64.encodeToString(raw, Base64.URL_SAFE | Base64.NO_PADDING | Base64.NO_WRAP);
    OrbitalWidget.setPendingCode(this, code);

    // Start polling NOW, from this activity while it is on screen: a
    // foreground service started from a visible activity is allowed on
    // every Android, and it is the service that has network access on a
    // phone whose background data is restricted. The receiver's
    // half-hourly tick would neither be soon enough nor, on such a
    // phone, able to reach the server at all.
    OrbitalWidget.refreshAll(this, "placed");

    // Open the connect page INSIDE OUR OWN LAUNCHER, explicitly. An
    // implicit ACTION_VIEW on our host would depend on Digital Asset
    // Links having verified on this device, and on there being no
    // chooser; naming the activity removes both questions. The TWA
    // launcher accepts a data URI and opens it in place of DEFAULT_URL.
    Intent connect = new Intent(this,
        com.google.androidbrowserhelper.trusted.LauncherActivity.class);
    connect.setAction(Intent.ACTION_VIEW);
    connect.setData(Uri.parse(OrbitalWidget.BASE + "/widget/connect?code=" + code));
    connect.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
    try {
      startActivity(connect);
    } catch (Exception ignored) {
      // The widget is already placed and the receiver will keep polling
      // for the TTL; if the page never opened it falls back to the
      // manual instructions on its own.
    }

    finish();
  }
}
