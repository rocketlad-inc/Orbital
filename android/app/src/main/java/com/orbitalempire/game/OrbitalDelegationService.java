package com.orbitalempire.game;

import android.app.Notification;
import android.content.ComponentName;
import android.provider.Settings;

import com.google.androidbrowserhelper.trusted.DelegationService;

/**
 * The service Chrome posts the site's notifications through (TWA
 * notification delegation), with one change: ONE ALERT ON THE WATCH, NOT TWO.
 *
 * With the watch relay on (OrbitalNotificationRelay), every Orbital alert
 * reaches the watch twice at once -- the watch app's own, relayed, and the
 * phone's copy mirrored by the watch's companion app (Lorne: "overlapping").
 * Samsung's Galaxy Wearable ignores the watch app's BridgingManager setting,
 * so the copy is stopped here instead: while the relay has notification
 * access, Orbital's notifications are marked LOCAL ONLY -- shown on the
 * phone, read by the relay, never mirrored. Without the relay nothing
 * changes, and the phone's copy is still the watch's only alert.
 */
public class OrbitalDelegationService extends DelegationService {

  @Override
  public boolean onNotifyNotificationWithChannel(
      String platformTag, int platformId, Notification notification, String channelName) {
    if (notification != null && platformTag != null && platformTag.contains("orbital:") && relayOn()) {
      notification.flags |= Notification.FLAG_LOCAL_ONLY;
    }
    return super.onNotifyNotificationWithChannel(platformTag, platformId, notification, channelName);
  }

  /** The relay holds notification access, so the watch gets its own copy. */
  private boolean relayOn() {
    try {
      String on = Settings.Secure.getString(getContentResolver(), "enabled_notification_listeners");
      return on != null && on.contains(new ComponentName(this, OrbitalNotificationRelay.class).flattenToString());
    } catch (Throwable t) {
      return false;
    }
  }
}
