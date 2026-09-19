package com.orbitalempire.game;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
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

import java.io.ByteArrayOutputStream;
import java.io.BufferedInputStream;
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
  private static final String KEY_DREW = "drew_once";
  private static final String BASE = "https://orbital-empire.com";

  private static final int MIN_W = 240, MIN_H = 120;
  private static final int MAX_W = 1200, MAX_H = 800;

  /** One shared pool. onUpdate can be called for several widget ids at
   *  once, and each does one short HTTP GET. */
  private static final ExecutorService IO = Executors.newFixedThreadPool(2);

  static SharedPreferences prefs(Context c) {
    return c.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
  }

  static void setToken(Context c, String token) {
    // drew_once resets with the token: a new token has never painted
    // anything, so its first failure should say so rather than sit on
    // the image a previous token left behind.
    prefs(c).edit().putString(KEY_TOKEN, token).putBoolean(KEY_DREW, false).apply();
  }

  /**
   * Redraw every instance now.
   *
   * SENDS A BROADCAST rather than calling onUpdate directly, and that is
   * not ceremony. Calling it directly means goAsync() returns null —
   * there is no broadcast to hold open — so nothing keeps the process
   * alive while the image downloads, and the caller here is an activity
   * that finishes immediately afterwards. The fetch would be racing
   * against its own process being reclaimed. Going through the system
   * gives the receiver a real PendingResult and the ten seconds that
   * come with it.
   */
  static void refreshAll(Context c) {
    AppWidgetManager m = AppWidgetManager.getInstance(c);
    int[] ids = m.getAppWidgetIds(new ComponentName(c, OrbitalWidget.class));
    if (ids == null || ids.length == 0) return;
    Intent i = new Intent(c, OrbitalWidget.class);
    i.setAction(AppWidgetManager.ACTION_APPWIDGET_UPDATE);
    i.putExtra(AppWidgetManager.EXTRA_APPWIDGET_IDS, ids);
    c.sendBroadcast(i);
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
    final RemoteViews views = new RemoteViews(context.getPackageName(), R.layout.widget_orbital);

    Intent open = new Intent(context, LauncherRelayActivity.class);
    int flags = PendingIntent.FLAG_UPDATE_CURRENT;
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_IMMUTABLE;
    views.setOnClickPendingIntent(R.id.widget_root,
        PendingIntent.getActivity(context, 0, open, flags));

    final String token = prefs(context).getString(KEY_TOKEN, null);
    if (token == null) {
      views.setViewVisibility(R.id.widget_image, View.GONE);
      views.setViewVisibility(R.id.widget_message, View.VISIBLE);
      manager.updateAppWidget(id, views);
      return;
    }

    Bundle opts = manager.getAppWidgetOptions(id);
    int w = clamp(opts.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, 0), MIN_W, MAX_W);
    int h = clamp(opts.getInt(AppWidgetManager.OPTION_APPWIDGET_MAX_HEIGHT, 0), MIN_H, MAX_H);
    final String url = BASE + "/widget/" + token + ".png?w=" + w + "&h=" + h;

    // goAsync keeps the broadcast alive while the fetch runs. A widget
    // update has roughly ten seconds, which is ample for a ~100KB image
    // and is why this does not need WorkManager and its dependency. It
    // is null if this was somehow reached outside a broadcast, hence the
    // guard at the end.
    final PendingResult pending = goAsync();
    final Context appContext = context.getApplicationContext();
    IO.execute(() -> {
      Bitmap bmp = null;
      String failure = null;
      try {
        Result r = fetch(url);
        bmp = r.bitmap;
        failure = r.failure;
      } catch (Exception e) {
        Log.w(TAG, "widget fetch failed", e);
        failure = e.getClass().getSimpleName();
      }
      try {
        if (bmp != null) {
          views.setImageViewBitmap(R.id.widget_image, bmp);
          views.setViewVisibility(R.id.widget_image, View.VISIBLE);
          views.setViewVisibility(R.id.widget_message, View.GONE);
          manager.updateAppWidget(id, views);
          prefs(appContext).edit().putBoolean(KEY_DREW, true).apply();
        } else if (!prefs(appContext).getBoolean(KEY_DREW, false)) {
          // NOTHING HAS EVER PAINTED HERE, so there is no old empire worth
          // protecting and silence would look identical to "not
          // connected". Say what went wrong: a widget that cannot be
          // diagnosed from the home screen cannot be diagnosed at all,
          // because nobody is going to attach a cable to read logcat.
          views.setViewVisibility(R.id.widget_image, View.GONE);
          views.setViewVisibility(R.id.widget_message, View.VISIBLE);
          views.setTextViewText(R.id.widget_message,
              "Orbital: could not load the card (" + failure + ")");
          manager.updateAppWidget(id, views);
        }
        // Once it has drawn once, a failed refresh LEAVES THE PREVIOUS
        // IMAGE ALONE. A phone that lost signal should show a slightly
        // old empire, not an error where the empire used to be.
      } catch (Exception e) {
        Log.w(TAG, "widget update failed", e);
      } finally {
        if (pending != null) pending.finish();
      }
    });
  }

  private static int clamp(int v, int lo, int hi) {
    return v < lo ? lo : (v > hi ? hi : v);
  }

  private static final class Result {
    Bitmap bitmap;
    String failure;
  }

  private static Result fetch(String url) throws Exception {
    Result out = new Result();
    HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
    try {
      conn.setConnectTimeout(8000);
      conn.setReadTimeout(8000);
      conn.setRequestProperty("Accept", "image/png");
      int code = conn.getResponseCode();
      if (code != 200) {
        Log.w(TAG, "widget http " + code);
        out.failure = "HTTP " + code;
        return out;
      }

      // READ THE WHOLE BODY FIRST, then decode. Handing a network stream
      // straight to BitmapFactory.decodeStream is the classic way to get
      // an intermittent null back: it does not always tolerate a chunked
      // or slow stream, and it fails by returning nothing rather than
      // throwing, so the symptom is a widget that just never paints.
      byte[] body;
      try (InputStream in = new BufferedInputStream(conn.getInputStream())) {
        ByteArrayOutputStream buf = new ByteArrayOutputStream(1 << 16);
        byte[] chunk = new byte[8192];
        int n;
        while ((n = in.read(chunk)) > 0) buf.write(chunk, 0, n);
        body = buf.toByteArray();
      }
      if (body.length == 0) {
        out.failure = "empty response";
        return out;
      }
      out.bitmap = BitmapFactory.decodeByteArray(body, 0, body.length);
      if (out.bitmap == null) out.failure = "not an image (" + body.length + "B)";
      return out;
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
    prefs(context).edit().remove(KEY_TOKEN).remove(KEY_DREW).apply();
  }
}
