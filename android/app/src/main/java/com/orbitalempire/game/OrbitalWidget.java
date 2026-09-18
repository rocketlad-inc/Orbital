package com.orbitalempire.game;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.os.Build;
import android.os.Bundle;
import android.util.Log;
import android.view.View;
import android.widget.RemoteViews;

import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * The home-screen widget.
 *
 * IT CONTAINS NO LAYOUT AND NO GAME KNOWLEDGE, ON PURPOSE. The entire
 * card — map, status bar, colours, wording — is rendered by the Worker
 * and arrives as a PNG. This class downloads that PNG and puts it in an
 * ImageView. That is the whole job.
 *
 * The reason is that a widget's layout lives in the APK, so anything
 * drawn here could only be changed by shipping a new build through
 * review. Anything drawn on the server can be changed by a deploy. So
 * the dumbest possible client is the correct one: the card can be
 * redesigned forever without anybody updating the app.
 *
 * WHAT IT NEEDS: a widget token, which arrives via WidgetLinkActivity
 * when the player taps "Send to widget" in the game. Until then the
 * widget shows an instruction rather than an error, because an empty
 * black rectangle on a home screen reads as broken software.
 */
public class OrbitalWidget extends AppWidgetProvider {

  private static final String TAG = "OrbitalWidget";
  private static final String PREFS = "orbital_widget";
  private static final String KEY_TOKEN = "token";
  private static final String BASE = "https://orbital-empire.com";

  /** The strip is drawn for roughly 4:3; below this a phone reports a
   *  silly size before it has measured, and the card would be requested
   *  at a shape the server cannot lay out well. */
  private static final int MIN_W = 240, MIN_H = 120;
  private static final int MAX_W = 1200, MAX_H = 800;

  /** One shared pool. onUpdate can be called for several widget ids at
   *  once, and each does one short HTTP GET. */
  private static final ExecutorService IO = Executors.newFixedThreadPool(2);

  static SharedPreferences prefs(Context c) {
    return c.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
  }

  static void setToken(Context c, String token) {
    prefs(c).edit().putString(KEY_TOKEN, token).apply();
  }

  /** Redraw every instance now. Called after the token arrives. */
  static void refreshAll(Context c) {
    AppWidgetManager m = AppWidgetManager.getInstance(c);
    int[] ids = m.getAppWidgetIds(new android.content.ComponentName(c, OrbitalWidget.class));
    if (ids != null && ids.length > 0) new OrbitalWidget().onUpdate(c, m, ids);
  }

  @Override
  public void onUpdate(Context context, AppWidgetManager manager, int[] ids) {
    for (int id : ids) render(context, manager, id);
  }

  /**
   * A resize is a new image, not a rescale. The card is laid out by the
   * server for the size it is asked for — text included — so stretching
   * a 4x2 render into a 4x4 slot would blur the one thing the widget
   * exists to show.
   */
  @Override
  public void onAppWidgetOptionsChanged(Context context, AppWidgetManager manager,
                                        int id, Bundle newOptions) {
    render(context, manager, id);
  }

  private void render(Context context, AppWidgetManager manager, int id) {
    RemoteViews views = new RemoteViews(context.getPackageName(), R.layout.widget_orbital);

    // Tapping anywhere opens the game. A widget that reports a problem
    // and cannot be acted on is worse than one that does nothing.
    Intent open = new Intent(context, LauncherRelayActivity.class);
    int flags = PendingIntent.FLAG_UPDATE_CURRENT;
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_IMMUTABLE;
    views.setOnClickPendingIntent(R.id.widget_root,
        PendingIntent.getActivity(context, 0, open, flags));

    String token = prefs(context).getString(KEY_TOKEN, null);
    if (token == null) {
      views.setViewVisibility(R.id.widget_image, View.GONE);
      views.setViewVisibility(R.id.widget_message, View.VISIBLE);
      manager.updateAppWidget(id, views);
      return;
    }

    // Ask for the size the widget actually occupies. Android reports dp;
    // the server lays out in the same units, so they can be passed
    // straight through.
    Bundle opts = manager.getAppWidgetOptions(id);
    int w = clamp(opts.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, 0), MIN_W, MAX_W);
    int h = clamp(opts.getInt(AppWidgetManager.OPTION_APPWIDGET_MAX_HEIGHT, 0), MIN_H, MAX_H);
    final String url = BASE + "/widget/" + token + ".png?w=" + w + "&h=" + h;

    // goAsync keeps the broadcast alive while the fetch runs. A widget
    // update has roughly ten seconds, which is ample for a ~100KB image
    // and is why this does not need WorkManager and its dependency.
    final PendingResult pending = goAsync();
    IO.execute(() -> {
      Bitmap bmp = null;
      try {
        bmp = fetch(url);
      } catch (Exception e) {
        Log.w(TAG, "widget fetch failed", e);
      }
      try {
        if (bmp != null) {
          views.setImageViewBitmap(R.id.widget_image, bmp);
          views.setViewVisibility(R.id.widget_image, View.VISIBLE);
          views.setViewVisibility(R.id.widget_message, View.GONE);
          manager.updateAppWidget(id, views);
        }
        // On failure LEAVE THE PREVIOUS IMAGE ALONE. A phone that lost
        // signal for one refresh should show a slightly old empire, not
        // an error where the empire used to be.
      } finally {
        pending.finish();
      }
    });
  }

  private static int clamp(int v, int lo, int hi) {
    return v < lo ? lo : (v > hi ? hi : v);
  }

  private static Bitmap fetch(String url) throws Exception {
    HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
    try {
      conn.setConnectTimeout(8000);
      conn.setReadTimeout(8000);
      conn.setRequestProperty("Accept", "image/png");
      if (conn.getResponseCode() != 200) {
        Log.w(TAG, "widget http " + conn.getResponseCode());
        return null;
      }
      try (InputStream in = conn.getInputStream()) {
        return BitmapFactory.decodeStream(in);
      }
    } finally {
      conn.disconnect();
    }
  }

  /** The last instance was removed, so the token has nothing left to
   *  feed. Dropping it means a reinstalled widget asks to be connected
   *  again rather than silently reusing a credential the player may have
   *  revoked on the server in the meantime. */
  @Override
  public void onDisabled(Context context) {
    prefs(context).edit().remove(KEY_TOKEN).apply();
  }
}
