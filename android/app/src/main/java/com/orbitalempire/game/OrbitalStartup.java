package com.orbitalempire.game;

import android.app.Activity;
import android.app.Application;
import android.content.ContentProvider;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Bundle;
import android.util.Log;

/**
 * Hooks the game being opened, and uses that moment for the two things
 * the widget cannot do by itself.
 *
 * WHY THIS IS A CONTENT PROVIDER AND NOT AN APPLICATION SUBCLASS, which
 * is what it obviously wants to be: GOOGLE PLAY REWRITES THE
 * APPLICATION CLASS. Play's automatic integrity protection repackages
 * the uploaded bundle and replaces android:name on <application> with
 * com.pairip.application.Application, and it does not delegate to or
 * even mention the class it displaced. Our Application subclass was
 * therefore never constructed on a single phone that installed from the
 * store, while every emulator in CI -- which installs the untransformed
 * debug APK -- ran it perfectly. Decoded from the Play-signed APK for
 * versionCode 11, where the only trace of the old class was its own
 * name in the type table.
 *
 * A provider survives that transformation untouched, and its onCreate
 * runs after attachBaseContext and before any activity, which is
 * earlier than this needs. It registers the same callbacks on whatever
 * Application object the process ended up with. This is how AndroidX
 * App Startup works, for the same reason.
 *
 * ONE: CONNECT THE WIDGET, INVISIBLY. Only a signed-in page can mint a
 * widget token, so when a widget is waiting to be paired and the player
 * opens the game, the launch URL is quietly changed to the connect page
 * for this device's code. The page binds it with its own same-site
 * fetch and redirects into the game, so the player sees an ordinary
 * launch. Nothing runs while the widget is being placed, which is the
 * whole point: a configuration activity that opened the game lost the
 * placement.
 *
 * TWO: REFRESH THE CARD. A foreground service may be started freely
 * while an activity of ours is on screen, so an app open is the one
 * moment the widget is guaranteed a network path whatever the phone's
 * background policy.
 *
 * NOTHING HERE MAY THROW: it runs before anything else in the process.
 */
public class OrbitalStartup extends ContentProvider {

  private static final String TAG = "OrbitalWidget";

  /** A tap on the widget opens the game; do not refetch for that. */
  private static final long STALE_MS = 2L * 60L * 1000L;

  @Override
  public boolean onCreate() {
    // Before anything else, so the rest of this method is covered too.
    if (getContext() != null) LaunchReport.install(getContext());
    try {
      Context c = getContext();
      Context app = c == null ? null : c.getApplicationContext();
      if (!(app instanceof Application)) {
        Log.w(TAG, "no Application to hook");
        return true;
      }
      ((Application) app).registerActivityLifecycleCallbacks(new Application.ActivityLifecycleCallbacks() {

        @Override
        public void onActivityPreCreated(Activity a, Bundle b) {
          LaunchReport.mark("preCreated " + a.getClass().getSimpleName());
          if (!isLauncher(a)) return;
          try {
            Intent i = a.getIntent();
            // Only a plain launch: an intent that already carries a URL
            // is someone opening a particular page (a link, or the
            // widget's own tap), and that must win.
            if (i == null || i.getData() != null) return;
            if (WidgetWork.hasToken(a)) return;
            // Either card waiting to be connected is reason enough.
            if (WidgetWork.widgetIds(a, WidgetWork.MAIN).length == 0
                && WidgetWork.widgetIds(a, WidgetWork.BATTLE).length == 0) return;
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
          LaunchReport.mark("started " + a.getClass().getSimpleName());
          if (!isLauncher(a)) return;
          OrbitalWidget.refreshIfStale(a.getApplicationContext(), STALE_MS);
        }

        // Each of these REPORTS as it happens (LaunchReport.step): the
        // phone that "crashes" keeps its process, so only a live report
        // shows where an open stops.
        @Override public void onActivityCreated(Activity a, Bundle b) {
          Intent i = a.getIntent();
          LaunchReport.step(a, "created " + a.getClass().getSimpleName()
              + " data=" + (i == null ? null : i.getDataString())
              + " restored=" + (b != null)
              + " " + LaunchReport.notifState(a));
        }
        @Override public void onActivityResumed(Activity a) { LaunchReport.step(a, "resumed " + a.getClass().getSimpleName()); }
        @Override public void onActivityPaused(Activity a) { LaunchReport.step(a, "paused " + a.getClass().getSimpleName()); }
        @Override public void onActivityStopped(Activity a) { LaunchReport.step(a, "stopped " + a.getClass().getSimpleName()); }
        @Override public void onActivitySaveInstanceState(Activity a, Bundle b) {}
        @Override public void onActivityDestroyed(Activity a) {
          LaunchReport.step(a, "destroyed " + a.getClass().getSimpleName()
              + " finishing=" + a.isFinishing());
        }
      });
      Log.i(TAG, "startup hook installed");
      LaunchReport.mark("startup hook installed");
    } catch (Throwable t) {
      Log.w(TAG, "startup hook failed", t);
    }
    return true;
  }

  private static boolean isLauncher(Activity a) {
    return a instanceof com.google.androidbrowserhelper.trusted.LauncherActivity;
  }

  // Not a real provider. It exists only to be created early.
  @Override public Cursor query(Uri u, String[] p, String s, String[] a, String o) { return null; }
  @Override public String getType(Uri u) { return null; }
  @Override public Uri insert(Uri u, ContentValues v) { return null; }
  @Override public int delete(Uri u, String s, String[] a) { return 0; }
  @Override public int update(Uri u, ContentValues v, String s, String[] a) { return 0; }
}
