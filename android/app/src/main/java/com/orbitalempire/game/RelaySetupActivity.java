package com.orbitalempire.game;

import android.app.Activity;
import android.content.ComponentName;
import android.content.Intent;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import android.service.notification.NotificationListenerService;
import android.widget.Toast;

/**
 * Catches orbital://watch-relay -- sent from the watch's "set up on your
 * phone" button -- and opens the one Settings screen the relay needs:
 * notification access for Orbital (OrbitalNotificationRelay).
 *
 * A private scheme for the same reason as WidgetLinkActivity: the https
 * domain belongs to the game's launcher. No UI of its own.
 */
public class RelaySetupActivity extends Activity {

  @Override
  protected void onCreate(Bundle saved) {
    super.onCreate(saved);
    open();
    finish();
  }

  @Override
  protected void onNewIntent(Intent intent) {
    super.onNewIntent(intent);
    open();
    finish();
  }

  private void open() {
    ComponentName relay = new ComponentName(this, OrbitalNotificationRelay.class);
    if (granted(relay)) {
      // Already on: ask the system to reconnect it, which says hello to the
      // watch again, so a watch still showing the setup row catches up.
      if (Build.VERSION.SDK_INT >= 24) {
        try { NotificationListenerService.requestRebind(relay); } catch (Throwable ignored) { }
      }
      Toast.makeText(this, "Orbital watch alerts are on.", Toast.LENGTH_SHORT).show();
      return;
    }
    Intent settings;
    if (Build.VERSION.SDK_INT >= 30) {
      // Straight to Orbital's own switch.
      settings = new Intent(Settings.ACTION_NOTIFICATION_LISTENER_DETAIL_SETTINGS)
          .putExtra(Settings.EXTRA_NOTIFICATION_LISTENER_COMPONENT_NAME, relay.flattenToString());
    } else {
      settings = new Intent("android.settings.ACTION_NOTIFICATION_LISTENER_SETTINGS");
    }
    settings.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
    try {
      startActivity(settings);
      Toast.makeText(this, "Turn on Orbital to send its alerts to your watch.", Toast.LENGTH_LONG).show();
    } catch (Throwable t) {
      // Some phones have no detail screen: the list of listeners instead.
      try {
        startActivity(new Intent("android.settings.ACTION_NOTIFICATION_LISTENER_SETTINGS").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
      } catch (Throwable ignored) {
        Toast.makeText(this, "Open Settings > Notifications > Notification access, and turn on Orbital.", Toast.LENGTH_LONG).show();
      }
    }
  }

  private boolean granted(ComponentName relay) {
    String on = Settings.Secure.getString(getContentResolver(), "enabled_notification_listeners");
    return on != null && on.contains(relay.flattenToString());
  }
}
