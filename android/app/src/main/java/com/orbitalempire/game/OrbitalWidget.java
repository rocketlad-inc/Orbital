package com.orbitalempire.game;

import android.content.Context;
import android.util.Log;

/**
 * The main card: the system map with your own status painted over its
 * footer. All the behaviour is in OrbitalWidgetBase; this names the
 * card and owns the shared helpers the rest of the app calls.
 *
 * ITS CLASS NAME IS LOAD-BEARING. Every home screen that already has
 * this widget holds it by this component name, so renaming it would
 * make existing widgets vanish rather than update.
 */
public class OrbitalWidget extends OrbitalWidgetBase {

  private static final String TAG = "OrbitalWidget";
  static final String BASE = WidgetWork.BASE;

  @Override
  WidgetWork.Kind kind() {
    return WidgetWork.MAIN;
  }

  static boolean hasToken(Context c) {
    return WidgetWork.hasToken(c);
  }

  static void setToken(Context c, String token) {
    WidgetWork.setToken(c, token);
  }

  /**
   * Redraw everything now, BOTH cards. A token arriving, or the game
   * being opened, is news to every widget on the home screen and not
   * just to the one that happened to ask.
   *
   * Service first; failing that, a broadcast to ourselves so the
   * receiver gets a real goAsync window (calling onUpdate directly
   * would give it none).
   */
  static void refreshAll(Context c, String reason) {
    for (WidgetWork.Kind k : new WidgetWork.Kind[] { WidgetWork.MAIN, WidgetWork.BATTLE }) {
      int[] ids = WidgetWork.widgetIds(c, k);
      if (ids.length == 0) continue;
      if (WidgetFetchService.launch(c, k, ids, reason)) continue;
      c.sendBroadcast(WidgetWork.updateIntent(c, k, ids));
    }
  }

  static void refreshAll(Context c) {
    refreshAll(c, "refreshAll");
  }

  /** Refresh any card older than maxAgeMs. The game launcher calls this
   *  on every open, so a player who plays gets current widgets on the
   *  way out without a fetch per tap. */
  static void refreshIfStale(Context c, long maxAgeMs) {
    try {
      boolean any = false;
      for (WidgetWork.Kind k : new WidgetWork.Kind[] { WidgetWork.MAIN, WidgetWork.BATTLE }) {
        if (WidgetWork.widgetIds(c, k).length == 0) continue;
        long age = System.currentTimeMillis() - WidgetWork.lastPaintMs(c, k);
        if (!WidgetWork.hasToken(c) || age >= maxAgeMs) any = true;
      }
      if (any) refreshAll(c, "app-open");
    } catch (Throwable t) {
      Log.w(TAG, "refreshIfStale failed", t);
    }
  }
}
