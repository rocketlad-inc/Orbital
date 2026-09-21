package com.orbitalempire.game;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.widget.Toast;

/**
 * Catches orbital://widget?token=… and hands the token to the widget.
 *
 * WHY A CUSTOM SCHEME AND NOT THE HTTPS LINK. The app already claims
 * https://orbital-empire.com with an autoVerify filter, and that filter
 * belongs to the TWA launcher — every path on the domain opens the game.
 * Adding a second activity on the same host would put two components in
 * a race for the same URL, and the one that won would decide whether a
 * player got their widget connected or just got the game reopened. A
 * private scheme has no such argument: nothing else claims it.
 *
 * WHY A HAND-OFF AT ALL. The widget is native code; the session lives in
 * Chrome inside the Trusted Web Activity. Native cannot read that cookie
 * and must not be given anything that could stand in for it — so what
 * crosses this boundary is the narrowest thing that works: a token that
 * renders one image (see migration 0134).
 *
 * The activity has no UI. It stores, refreshes, says so, and finishes.
 */
public class WidgetLinkActivity extends Activity {

  @Override
  protected void onCreate(Bundle saved) {
    super.onCreate(saved);
    handle(getIntent());
    finish();
  }

  /** singleTask, so a second tap arrives here rather than as a new
   *  instance stacked on the first. */
  @Override
  protected void onNewIntent(Intent intent) {
    super.onNewIntent(intent);
    handle(intent);
    finish();
  }

  private void handle(Intent intent) {
    Uri data = intent == null ? null : intent.getData();
    String token = data == null ? null : data.getQueryParameter("token");

    // Validated against the same shape the server's route accepts. A
    // token is put straight into a URL, so anything outside this
    // alphabet has no business being stored.
    if (token == null || !token.matches("[A-Za-z0-9_-]{8,64}")) {
      Toast.makeText(this, "That widget link was not valid.", Toast.LENGTH_LONG).show();
      return;
    }

    OrbitalWidget.setToken(this, token);
    OrbitalWidget.refreshAll(this, "link");
    Toast.makeText(this, "Widget connected.", Toast.LENGTH_SHORT).show();
  }
}
