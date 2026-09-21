package com.orbitalempire.game;

import android.app.Activity;
import android.app.Application;
import android.os.Bundle;
import android.util.Log;

/**
 * The application object exists for one reason: to notice the game
 * being opened and refresh the widget while the app is in the
 * foreground.
 *
 * WHY HERE AND NOT A LAUNCHER SUBCLASS. The launcher is
 * androidbrowserhelper's LauncherActivity, and its component name is
 * what every home screen holds the app icon by; renaming it (which a
 * subclass would) makes the icon vanish from existing home screens
 * until the app is re-added. A lifecycle callback sees the same event
 * without touching the name.
 *
 * WHY IT MATTERS. A foreground service may be started freely while an
 * activity of ours is on screen, on every Android version. So the
 * moment the launcher appears is the one moment the widget is
 * guaranteed a network path, whatever the phone's background policy.
 * "Keeps itself current" is therefore: every open of the game, plus the
 * half-hourly tick when the OS allows it.
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
        public void onActivityStarted(Activity a) {
          if (a instanceof com.google.androidbrowserhelper.trusted.LauncherActivity) {
            OrbitalWidget.refreshIfStale(a.getApplicationContext(), STALE_MS);
          }
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
}
