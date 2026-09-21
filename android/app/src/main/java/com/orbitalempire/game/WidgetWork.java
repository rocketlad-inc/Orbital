package com.orbitalempire.game;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.os.Build;
import android.os.Bundle;
import android.os.PowerManager;
import android.os.SystemClock;
import android.provider.Settings;
import android.util.DisplayMetrics;
import android.util.Log;
import android.view.View;
import android.widget.RemoteViews;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.BufferedInputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/**
 * Everything the widget does that touches the network or its prefs, in
 * one place, so it can be run from whichever context the OS will grant
 * network to: the foreground service by preference (WidgetFetchService),
 * the receiver in-process as the fallback.
 *
 * IT NEVER THROWS. Every entry point catches Throwable, because this
 * runs inside the same process as the game, and an uncaught
 * OutOfMemoryError from a bitmap already took the app down once.
 */
final class WidgetWork {

  private static final String TAG = "OrbitalWidget";
  static final String PREFS = "orbital_widget";
  static final String KEY_TOKEN = "token";
  static final String KEY_DREW = "drew_once";
  static final String KEY_CODE = "pending_code";
  static final String KEY_CODE_SINCE = "pending_since";
  static final String KEY_TRIES = "pending_tries";
  static final String KEY_LAST_PAINT = "last_paint_ms";
  static final String BASE = "https://orbital-empire.com";

  /** Layout units (dp) asked of the server. A phone widget is never
   *  wider than a phone; a launcher that reports its whole screen as the
   *  maximum must not turn into a 2400x1600 image. */
  private static final int MIN_W = 240, MIN_H = 120;
  private static final int MAX_W = 480, MAX_H = 480;

  /** Decoded bitmap budget, in pixels. 4 bytes each, so 3.2MB. */
  private static final long MAX_PIXELS = 800L * 1000L;

  /** Pairing: how long a code stays worth polling, how many alarm
   *  retries before the manual instructions, and the retry gap. */
  static final long PAIR_TTL_MS = 10L * 60L * 1000L;
  static final int PAIR_MAX_TRIES = 30;
  private static final long PAIR_RETRY_MS = 15_000L;

  private WidgetWork() {}

  // ---- prefs -------------------------------------------------------

  static SharedPreferences prefs(Context c) {
    return c.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
  }

  static boolean hasToken(Context c) {
    return prefs(c).getString(KEY_TOKEN, null) != null;
  }

  /** drew_once resets with the token: a new token has never painted, so
   *  its first failure should say so. A landed token ends any pairing. */
  static void setToken(Context c, String token) {
    prefs(c).edit()
        .putString(KEY_TOKEN, token).putBoolean(KEY_DREW, false)
        .remove(KEY_CODE).remove(KEY_CODE_SINCE).remove(KEY_TRIES)
        .apply();
  }

  static void setPendingCode(Context c, String code) {
    prefs(c).edit()
        .putString(KEY_CODE, code)
        .putLong(KEY_CODE_SINCE, System.currentTimeMillis())
        .putInt(KEY_TRIES, 0)
        .apply();
  }

  static boolean pairingInFlight(Context c) {
    SharedPreferences p = prefs(c);
    return p.getString(KEY_TOKEN, null) == null
        && p.getString(KEY_CODE, null) != null
        && System.currentTimeMillis() - p.getLong(KEY_CODE_SINCE, 0) < PAIR_TTL_MS
        && p.getInt(KEY_TRIES, 0) < PAIR_MAX_TRIES;
  }

  static long lastPaintMs(Context c) {
    return prefs(c).getLong(KEY_LAST_PAINT, 0);
  }

  static void clearAll(Context c) {
    prefs(c).edit()
        .remove(KEY_TOKEN).remove(KEY_DREW).remove(KEY_LAST_PAINT)
        .remove(KEY_CODE).remove(KEY_CODE_SINCE).remove(KEY_TRIES)
        .apply();
  }

  static int[] widgetIds(Context c) {
    try {
      int[] ids = AppWidgetManager.getInstance(c)
          .getAppWidgetIds(new ComponentName(c, OrbitalWidget.class));
      return ids == null ? new int[0] : ids;
    } catch (Throwable t) {
      return new int[0];
    }
  }

  // ---- painting ----------------------------------------------------

  /** The RemoteViews every paint starts from: the tap target is wired
   *  here so no paint can lose it. */
  static RemoteViews baseViews(Context c) {
    RemoteViews views = new RemoteViews(c.getPackageName(), R.layout.widget_orbital);
    Intent open = new Intent(c, LauncherRelayActivity.class);
    int flags = PendingIntent.FLAG_UPDATE_CURRENT;
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_IMMUTABLE;
    views.setOnClickPendingIntent(R.id.widget_root, PendingIntent.getActivity(c, 0, open, flags));
    return views;
  }

  static void showMessage(Context c, int id, CharSequence text) {
    try {
      RemoteViews v = baseViews(c);
      v.setViewVisibility(R.id.widget_image, View.GONE);
      v.setViewVisibility(R.id.widget_message, View.VISIBLE);
      v.setTextViewText(R.id.widget_message, text);
      AppWidgetManager.getInstance(c).updateAppWidget(id, v);
    } catch (Throwable t) {
      Log.w(TAG, "showMessage failed", t);
    }
  }

  /** Nothing to fetch with and nothing in flight: say how to connect. */
  static void showHint(Context c, int[] ids) {
    SharedPreferences p = prefs(c);
    if (p.getString(KEY_CODE, null) != null) {
      p.edit().remove(KEY_CODE).remove(KEY_CODE_SINCE).remove(KEY_TRIES).apply();
    }
    for (int id : ids) showMessage(c, id, c.getString(R.string.widget_connect_hint));
  }

  /** Something is happening; the poll replaces it. Never over a card
   *  that has already painted. */
  static void showConnecting(Context c, int[] ids) {
    if (prefs(c).getBoolean(KEY_DREW, false)) return;
    for (int id : ids) showMessage(c, id, c.getString(R.string.widget_connecting));
  }

  // ---- pairing -----------------------------------------------------

  /** One poll. True if a token is now stored. */
  static boolean pollPairing(Context c) {
    try {
      String code = prefs(c).getString(KEY_CODE, null);
      if (code == null) return hasToken(c);
      String tok = claimPairing(code);
      if (tok == null) return false;
      Log.i(TAG, "pairing complete");
      setToken(c, tok);
      return true;
    } catch (Throwable t) {
      Log.w(TAG, "pairing poll failed", t);
      return false;
    }
  }

  /** A run ended with no token: count it and come back on an alarm. */
  static void pairingMissed(Context c, int[] ids) {
    try {
      SharedPreferences p = prefs(c);
      int tries = p.getInt(KEY_TRIES, 0) + 1;
      p.edit().putInt(KEY_TRIES, tries).apply();
      Log.i(TAG, "pairing not ready (try " + tries + ")");
      if (pairingInFlight(c)) scheduleRetry(c, ids);
      else showHint(c, ids);
    } catch (Throwable t) {
      Log.w(TAG, "pairingMissed failed", t);
    }
  }

  static Intent updateIntent(Context c, int[] ids) {
    Intent i = new Intent(c, OrbitalWidget.class);
    i.setAction(AppWidgetManager.ACTION_APPWIDGET_UPDATE);
    i.putExtra(AppWidgetManager.EXTRA_APPWIDGET_IDS, ids);
    return i;
  }

  /** Come back and poll again in a moment. Inexact on purpose: exact
   *  alarms need a permission on newer Android. */
  static void scheduleRetry(Context c, int[] ids) {
    try {
      AlarmManager am = (AlarmManager) c.getSystemService(Context.ALARM_SERVICE);
      if (am == null) return;
      int flags = PendingIntent.FLAG_UPDATE_CURRENT;
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_IMMUTABLE;
      PendingIntent pi = PendingIntent.getBroadcast(c, 0x0b17a2, updateIntent(c, ids), flags);
      long at = SystemClock.elapsedRealtime() + PAIR_RETRY_MS;
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
        am.setAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP, at, pi);
      } else {
        am.set(AlarmManager.ELAPSED_REALTIME_WAKEUP, at, pi);
      }
    } catch (Throwable t) {
      Log.w(TAG, "could not schedule pairing retry", t);
    }
  }

  // ---- fetching ----------------------------------------------------

  /**
   * Fetch and paint every widget in `ids` with the stored token. Returns
   * true if every one painted. Does not pair; callers handle that.
   */
  static boolean refresh(Context c, int[] ids) {
    if (ids == null || ids.length == 0) return true;
    boolean all = true;
    try {
      String token = prefs(c).getString(KEY_TOKEN, null);
      if (token == null) return false;
      for (int id : ids) all &= paintOne(c, id, token);
    } catch (Throwable t) {
      Log.e(TAG, "refresh failed", t);
      return false;
    }
    return all;
  }

  private static boolean paintOne(Context c, int id, String token) {
    SharedPreferences p = prefs(c);
    AppWidgetManager m = AppWidgetManager.getInstance(c);
    Bundle opts = m.getAppWidgetOptions(id);
    int w = clamp(opts.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, 0), MIN_W, MAX_W);
    int h = clamp(opts.getInt(AppWidgetManager.OPTION_APPWIDGET_MAX_HEIGHT, 0), MIN_H, MAX_H);
    String url = BASE + "/widget/" + token + ".png?w=" + w + "&h=" + h;

    Bitmap bmp = null;
    String failure;
    try {
      Result r = fetch(url, c);
      bmp = r.bitmap;
      failure = r.failure;
    } catch (Throwable t) {
      Log.w(TAG, "widget fetch failed: " + describe(t));
      failure = describe(t);
    }
    try {
      if (bmp != null) {
        RemoteViews v = baseViews(c);
        v.setImageViewBitmap(R.id.widget_image, bmp);
        v.setViewVisibility(R.id.widget_image, View.VISIBLE);
        v.setViewVisibility(R.id.widget_message, View.GONE);
        m.updateAppWidget(id, v);
        p.edit().putBoolean(KEY_DREW, true).putLong(KEY_LAST_PAINT, System.currentTimeMillis()).apply();
        Log.i(TAG, "painted " + id + " (" + w + "x" + h + ")");
        return true;
      }
      if (!p.getBoolean(KEY_DREW, false)) {
        // Nothing has ever painted here, so say what went wrong, and
        // say enough to tell the causes apart from the home screen,
        // because that is the only place anyone will read it.
        String diag = netDiag(c);
        Log.w(TAG, "first paint failed: " + failure + " net: " + diag);
        showMessage(c, id, "Orbital: " + failure + "\n" + diag);
      }
      // After a first paint, a failed refresh leaves the old image alone.
    } catch (Throwable t) {
      Log.w(TAG, "widget paint failed", t);
    }
    return false;
  }

  private static int clamp(int v, int lo, int hi) {
    return v < lo ? lo : (v > hi ? hi : v);
  }

  /** The class AND the message, trimmed to fit a widget: "Unable to
   *  resolve host" and "Network is unreachable" are different faults. */
  static String describe(Throwable t) {
    String msg = t.getMessage();
    String s = t.getClass().getSimpleName() + (msg != null ? ": " + msg : "");
    return s.length() > 90 ? s.substring(0, 90) + "..." : s;
  }

  /**
   * What the OS thinks of this process's network, in a line. bg= Data
   * Saver status for this app (ON/WL/off), net= the active network's
   * transport, dns= Private DNS mode, batt= battery optimisation. Each
   * is a different reason a widget can be told "unknown host" while
   * Chrome next door is fine.
   */
  static String netDiag(Context c) {
    // Each probe is guarded on its own, so one that throws (a missing
    // permission, a vendor quirk) costs one field, not the whole line.
    StringBuilder sb = new StringBuilder();
    ConnectivityManager cm = null;
    try {
      cm = (ConnectivityManager) c.getSystemService(Context.CONNECTIVITY_SERVICE);
    } catch (Throwable ignored) {
    }
    try {
      if (cm != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
        int rb = cm.getRestrictBackgroundStatus();
        sb.append("bg=").append(rb == ConnectivityManager.RESTRICT_BACKGROUND_STATUS_ENABLED ? "ON"
            : rb == ConnectivityManager.RESTRICT_BACKGROUND_STATUS_WHITELISTED ? "WL" : "off");
      }
    } catch (Throwable t) {
      sb.append("bg=?").append(t.getClass().getSimpleName());
    }
    try {
      if (cm != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
        Network n = cm.getActiveNetwork();
        NetworkCapabilities nc = n == null ? null : cm.getNetworkCapabilities(n);
        String tr = nc == null ? "none"
            : nc.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) ? "wifi"
            : nc.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) ? "cell"
            : nc.hasTransport(NetworkCapabilities.TRANSPORT_VPN) ? "vpn" : "other";
        boolean inet = nc != null && nc.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET);
        boolean metered = nc != null && !nc.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED);
        sb.append(" net=").append(tr).append(inet ? "" : "(no-inet)").append(metered ? "(metered)" : "");
      }
    } catch (Throwable t) {
      sb.append(" net=?").append(t.getClass().getSimpleName());
    }
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
        String mode = Settings.Global.getString(c.getContentResolver(), "private_dns_mode");
        if (mode != null && !"off".equals(mode)) sb.append(" dns=").append(mode);
      }
    } catch (Throwable ignored) {
    }
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
        PowerManager pm = (PowerManager) c.getSystemService(Context.POWER_SERVICE);
        if (pm != null) sb.append(" batt=").append(pm.isIgnoringBatteryOptimizations(c.getPackageName()) ? "exempt" : "opt");
      }
    } catch (Throwable ignored) {
    }
    return sb.toString().trim();
  }

  /** One poll of the pairing endpoint. Null until the page has bound the
   *  code; the server marks the pairing claimed on the first success. */
  static String claimPairing(String code) {
    HttpURLConnection conn = null;
    try {
      conn = (HttpURLConnection) new URL(BASE + "/widget/pair/" + code).openConnection();
      conn.setConnectTimeout(6000);
      conn.setReadTimeout(6000);
      conn.setRequestProperty("Accept", "application/json");
      if (conn.getResponseCode() != 200) return null;
      byte[] body;
      try (InputStream in = new BufferedInputStream(conn.getInputStream())) {
        ByteArrayOutputStream buf = new ByteArrayOutputStream(512);
        byte[] chunk = new byte[1024];
        int n;
        while ((n = in.read(chunk)) > 0) buf.write(chunk, 0, n);
        body = buf.toByteArray();
      }
      JSONObject j = new JSONObject(new String(body, StandardCharsets.UTF_8));
      String t = j.optString("token", "");
      return t.matches("[A-Za-z0-9_-]{8,64}") ? t : null;
    } catch (Throwable t) {
      Log.w(TAG, "pairing poll failed: " + describe(t));
      return null;
    } finally {
      if (conn != null) conn.disconnect();
    }
  }

  private static final class Result {
    Bitmap bitmap;
    String failure;
  }

  private static Result fetch(String url, Context ctx) throws Exception {
    Result out = new Result();
    HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
    try {
      conn.setConnectTimeout(8000);
      conn.setReadTimeout(8000);
      conn.setRequestProperty("Accept", "image/png");
      int code = conn.getResponseCode();
      if (code != 200) {
        out.failure = "HTTP " + code;
        return out;
      }
      // Read the whole body first, then decode: decodeStream on a
      // network stream returns null intermittently and says nothing.
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
      // Measure, then sample down to a budget bounded by the platform's
      // RemoteViews limit, so a big launcher-reported size can neither
      // OOM the decode nor make updateAppWidget throw.
      BitmapFactory.Options probe = new BitmapFactory.Options();
      probe.inJustDecodeBounds = true;
      BitmapFactory.decodeByteArray(body, 0, body.length, probe);
      if (probe.outWidth <= 0 || probe.outHeight <= 0) {
        out.failure = "not an image (" + body.length + "B)";
        return out;
      }
      long budget = MAX_PIXELS;
      DisplayMetrics dm = ctx.getResources().getDisplayMetrics();
      long platform = (long) (1.5 * dm.widthPixels * dm.heightPixels);
      if (platform > 0 && platform < budget) budget = platform;
      int sample = 1;
      while (((long) probe.outWidth / sample) * ((long) probe.outHeight / sample) > budget) sample *= 2;
      BitmapFactory.Options real = new BitmapFactory.Options();
      real.inSampleSize = sample;
      real.inPreferredConfig = Bitmap.Config.ARGB_8888;
      out.bitmap = BitmapFactory.decodeByteArray(body, 0, body.length, real);
      if (out.bitmap == null) out.failure = "decode failed (" + body.length + "B)";
      return out;
    } finally {
      conn.disconnect();
    }
  }
}
