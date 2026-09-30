package com.orbitalempire.game;

import android.app.Notification;
import android.os.Bundle;
import android.service.notification.NotificationListenerService;
import android.service.notification.StatusBarNotification;
import android.util.Log;

import com.google.android.gms.wearable.Node;
import com.google.android.gms.wearable.Wearable;

import org.json.JSONObject;

import java.nio.charset.StandardCharsets;

/**
 * THE WATCH RELAY: Orbital's own phone notifications, handed to the watch.
 *
 * WHY. A watch at rest on a wrist sleeps, and a sleeping watch gives
 * background apps no network, so the watch app's own look for news just
 * after each tick was held back until the player opened it (Lorne: the
 * watch's tick alert never came, only the phone's). The phone gets its
 * alerts reliably -- web push, through Chrome -- and the phone-to-watch
 * link reaches a sleeping watch without either needing the internet. So
 * the moment an Orbital notification lands here, its text goes to the
 * watch app, which posts it as its own: the right buzz, and a tap that
 * opens the watch app on the right card.
 *
 * WHAT IT READS. Android only grants a listener access to every app's
 * notifications, so the filter is the promise: ONLY this app's own
 * notifications whose tag names an Orbital event ("orbital:<event>",
 * worker/push.js) are touched; everything else returns on the first line
 * and is never read. What is sent goes to this phone's own paired watch,
 * over the Wear Data Layer, and nowhere else.
 */
public class OrbitalNotificationRelay extends NotificationListenerService {

  private static final String TAG = "OrbitalRelay";

  /** Data Layer paths; the watch's RelayListenerService listens on both. */
  static final String PATH_ALERT = "/orbital/alert";
  static final String PATH_HELLO = "/orbital/hello";

  /** Access granted (or the phone restarted with it granted): tell the
   *  watch the relay is on, so it stops offering to set it up. */
  @Override
  public void onListenerConnected() {
    super.onListenerConnected();
    send(PATH_HELLO, "{}");
  }

  @Override
  public void onNotificationPosted(StatusBarNotification sbn) {
    if (sbn == null) return;
    String tag = sbn.getTag();
    // Ours, and an Orbital event. Chrome posts the site's notifications on
    // this app's behalf (notification delegation), so the package is ours;
    // the tag may arrive wrapped by Chrome, so the event is found inside it.
    // Should Chrome ever post one itself (delegation off), its tag names
    // the site -- "p#https://orbital-empire.com#1orbital:..." -- and that
    // is the only notification of another app this ever reads.
    if (tag == null) return;
    boolean ours = getPackageName().equals(sbn.getPackageName())
        || tag.contains("https://orbital-empire.com");
    if (!ours) return;
    int at = tag.indexOf("orbital:");
    if (at < 0) return;
    String key = tag.substring(at);
    try {
      Notification n = sbn.getNotification();
      Bundle x = n == null ? null : n.extras;
      CharSequence title = x == null ? null : x.getCharSequence(Notification.EXTRA_TITLE);
      CharSequence big = x == null ? null : x.getCharSequence(Notification.EXTRA_BIG_TEXT);
      CharSequence text = big != null ? big : (x == null ? null : x.getCharSequence(Notification.EXTRA_TEXT));
      JSONObject o = new JSONObject()
          .put("key", key)
          .put("title", title == null ? "Orbital" : title.toString())
          .put("text", text == null ? "" : text.toString())
          .put("at", sbn.getPostTime());
      send(PATH_ALERT, o.toString());
    } catch (Throwable t) {
      Log.w(TAG, "could not relay " + key, t);
    }
  }

  /** To every connected watch; a watch without the Orbital app drops it. */
  private void send(String path, String json) {
    final byte[] bytes = json.getBytes(StandardCharsets.UTF_8);
    try {
      Wearable.getNodeClient(this).getConnectedNodes()
          .addOnSuccessListener(nodes -> {
            for (Node node : nodes) {
              Wearable.getMessageClient(this).sendMessage(node.getId(), path, bytes)
                  .addOnFailureListener(e -> Log.w(TAG, "relay to " + node.getDisplayName() + " failed", e));
            }
          })
          .addOnFailureListener(e -> Log.w(TAG, "no watch to relay to", e));
    } catch (Throwable t) {
      Log.w(TAG, "relay unavailable", t);
    }
  }
}
