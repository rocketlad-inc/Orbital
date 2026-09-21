package com.orbitalempire.game;

import android.app.Activity;
import android.app.Application;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.util.Log;

/**
 * Watches the game being opened, and uses that moment for the two
 * things the widget cannot do by itself.
 *
 * ONE: CONNECT THE WIDGET, INVISIBLY. Only a signed-in page can mint a
 * widget token -- the session is a Strict cookie inside Chrome, which
 * native cannot read and must not be handed. So when a widget is
 * waiting to be paired and the player opens the game, the launch URL is
 * quietly changed to the connect page for this device's code. The page
 * binds the code with its own same-site fetch, redirects into the game,
 * and the player sees an ordinary launch. Nothing is tapped, nothing is
 * asked, and NOTHING RUNS WHILE THE WIDGET IS BEING PLACED -- which is
 * the whole point, because a configuration activity that opened the
 * game lost the placement.
 *
 * TWO: REFRESH THE CARD. A foreground service may be started freely
 * while an activity of ours is on screen, on every Android version, so
 * an app open is the one moment the widget is guaranteed a network
 * path whatever the phone's background policy.
 *
 * WHY A LIFECYCLE HOOK AND NOT A LAUNCHER SUBCLASS. Every home screen
 * holds the app icon by the launcher's component name; subclassing
 * renames it and makes the icon vanish until the app is re-added.
 * onActivityPreCreated runs before the activity reads its intent, which
 * is all this needs, and costs nothing. It arrived in API 29; below
 * that the URL cannot be changed in time and pairing falls back to
 * tapping the widget, which opens the same page.
 *
 * NOTHING HERE MAY THROW: this runs before any activity.
 */
public class OrbitalApp extends Application {

  private static final String TAG = "OrbitalWidget";

  /** A tap on the widget opens the game; do not refetch for that. */
  private static final long STALE_MS = 2L * 60L * 1000L;

  @Override
  public void onCreate() {
    super.onCreate();
    try {
      registerActivityLifecycleCallbacks(new ActivityLifecycleCallbacks() {

        @Override
        public void onActivityPreCreated(Activity a, Bundle b) {
          if (!isLauncher(a)) return;
          try {
            Intent i = a.getIntent();
            // Only a plain launch: an intent that already carries a URL
            // is someone opening a particular page (a link, or the
            // widget's own tap), and that must win.
            if (i == null || i.getData() != null) return;
            if (WidgetWork.hasToken(a) || WidgetWork.widgetIds(a).length == 0) return;
            String url = WidgetWork.connectUrl(a);
            if (url == null) return;
            i.setAction(Intent.ACTION_VIEW);
            i.setData(Uri.parse(url));
            Log.i(TAG, "launch carries the pairing code");
          } catch (Throwable t) {
            Log.w(TAG, "could not attach the pairing code", t);
          }
        }

        @Override
        public void onActivityStarted(Activity a) {
          if (!isLauncher(a)) return;
          OrbitalWidget.refreshIfStale(a.getApplicationContext(), STALE_MS);
        }

        @Override public void onActivityCreated(Activity a, Bundle b) {}
        @Override public void onActivityResumed(Activity a) {}
        @Override public void onActivityPaused(Activity a) {}
        @Override public void onActivityStopped(Activity a) {}
        @Override public void onActivitySaveInstanceState(Activity a, Bundle b) {}
        @Override public void onActivityDestroyed(Activity a) {}
      });
    } catch (Throwable t) {
      Log.w(TAG, "lifecycle hook failed", t);
    }
  }

  private static boolean isLauncher(Activity a) {
    return a instanceof com.google.androidbrowserhelper.trusted.LauncherActivity;
  }
}
