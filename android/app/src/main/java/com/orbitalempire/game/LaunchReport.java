package com.orbitalempire.game;

import android.app.ActivityManager;
import android.app.ApplicationExitInfo;
import android.content.Context;
import android.content.SharedPreferences;
import android.os.Build;
import android.os.SystemClock;
import android.util.Log;

import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.PrintWriter;
import java.io.StringWriter;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.List;

/**
 * The app's own crash and launch report, sent to /api/app-report.
 *
 * WHY: a launch that dies before the page loads is invisible to every
 * other signal we have. The web error boundary never runs, a perf
 * heartbeat is never sent, and Play's crash console is not readable by
 * the API from here. "Opens and closes" was reported from a real phone
 * while every emulator scenario passed, and there was nothing to read.
 *
 * WHAT IT SENDS, on the start AFTER a launch:
 *   - the trail: every lifecycle step the last run reached, with ms
 *     since the process began, so "it got to X and stopped" is visible
 *     even when nothing threw (Play's license gate, a Chrome handoff);
 *   - any uncaught Java exception, which is ALSO posted immediately
 *     from the dying process with a bounded wait;
 *   - Android's own ApplicationExitInfo (API 30+) for every process
 *     death since the last report: the reason code, the description,
 *     and the native tombstone or ANR trace when there is one. This is
 *     the only way to see a native crash or a kill from inside the app.
 *
 * NOTHING HERE MAY THROW, and nothing blocks the main thread except the
 * dying one, which has nothing left to lose.
 */
final class LaunchReport {

  private static final String TAG = "OrbitalWidget";
  private static final String TRAIL = "launch_trail.txt";
  private static final String PREFS = "orbital_launch_report";
  private static final String LAST_EXIT = "last_exit_ms";

  private static volatile File trail;
  private static volatile String device = "";
  private static volatile String version = "";

  private LaunchReport() {}

  /** First thing the process does. Sends the previous run's report. */
  static void install(Context c) {
    try {
      final Context app = c.getApplicationContext() != null ? c.getApplicationContext() : c;
      device = Build.MANUFACTURER + " " + Build.MODEL + " / Android " + Build.VERSION.RELEASE
          + " (API " + Build.VERSION.SDK_INT + ")";
      try {
        version = String.valueOf(app.getPackageManager()
            .getPackageInfo(app.getPackageName(), 0).versionCode);
      } catch (Throwable ignored) { }

      File f = new File(app.getFilesDir(), TRAIL);
      final String previous = read(f);
      //noinspection ResultOfMethodCallIgnored
      f.delete();
      trail = f;
      mark("process start");

      final Thread.UncaughtExceptionHandler prior = Thread.getDefaultUncaughtExceptionHandler();
      Thread.setDefaultUncaughtExceptionHandler((thread, e) -> {
        try {
          String stack = stackOf(e);
          mark("UNCAUGHT on " + thread.getName() + ": " + e);
          Thread send = new Thread(() -> post("crash", String.valueOf(e), stack, read(trail)));
          send.start();
          send.join(3000);
        } catch (Throwable ignored) { }
        if (prior != null) prior.uncaughtException(thread, e);
      });

      // WAITED FOR, bounded. Sent from a background thread and left
      // alone, this never arrived from the phone it was built for: a
      // launch that dies inside a second takes the unsent report with
      // it, every time. The trail file survives (it is written line by
      // line), so the NEXT start sends it -- but only if that start
      // lives long enough, which it does not either. So hold this start
      // until the report is out: 2s at most, ~200ms on a live network.
      // A "start" beacon goes with it, so a phone that never reports at
      // all proves our code never ran.
      Thread send = new Thread(() -> {
        post("start", "process start", null, read(trail));
        sendPrevious(app, previous);
      }, "launch-report");
      send.start();
      try { send.join(2000); } catch (Throwable ignored) { }
      mark("report sent");
    } catch (Throwable t) {
      Log.w(TAG, "launch report not installed", t);
    }
  }

  /** One line on the trail. Cheap, append-only, never throws. */
  static void mark(String what) {
    File f = trail;
    if (f == null) return;
    try (OutputStream o = new FileOutputStream(f, true)) {
      o.write(("+" + (SystemClock.elapsedRealtime() - startMs()) + "ms " + what + "\n")
          .getBytes(StandardCharsets.UTF_8));
    } catch (Throwable ignored) { }
  }

  private static long startMs() {
    if (Build.VERSION.SDK_INT >= 24) return android.os.Process.getStartElapsedRealtime();
    return 0;
  }

  @android.annotation.TargetApi(30)
  private static void sendPrevious(Context app, String previous) {
    try {
      StringBuilder exits = new StringBuilder();
      String worst = null;
      if (Build.VERSION.SDK_INT >= 30) {
        SharedPreferences p = app.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        long since = p.getLong(LAST_EXIT, 0);
        long newest = since;
        ActivityManager am = (ActivityManager) app.getSystemService(Context.ACTIVITY_SERVICE);
        List<ApplicationExitInfo> list = am.getHistoricalProcessExitReasons(null, 0, 8);
        for (ApplicationExitInfo x : list) {
          if (x.getTimestamp() <= since) continue;
          newest = Math.max(newest, x.getTimestamp());
          String line = "exit reason=" + reasonName(x.getReason()) + " status=" + x.getStatus()
              + " importance=" + x.getImportance() + " pss=" + x.getPss()
              + " at=" + x.getTimestamp() + " desc=" + x.getDescription();
          exits.append(line).append('\n');
          if (worst == null && isBad(x.getReason())) {
            worst = line;
            String trace = traceOf(x);
            if (trace != null) exits.append(trace).append('\n');
          }
        }
        p.edit().putLong(LAST_EXIT, newest).apply();
      }
      if ((previous == null || previous.isEmpty()) && exits.length() == 0) return;
      post(worst != null ? "exit" : "launch",
          worst != null ? worst : "previous launch trail",
          exits.length() > 0 ? exits.toString() : null,
          previous);
    } catch (Throwable t) {
      Log.w(TAG, "launch report send failed", t);
    }
  }

  @android.annotation.TargetApi(30)
  private static boolean isBad(int r) {
    return r == ApplicationExitInfo.REASON_CRASH
        || r == ApplicationExitInfo.REASON_CRASH_NATIVE
        || r == ApplicationExitInfo.REASON_ANR
        || r == ApplicationExitInfo.REASON_INITIALIZATION_FAILURE
        || r == ApplicationExitInfo.REASON_EXIT_SELF
        || r == ApplicationExitInfo.REASON_SIGNALED
        || r == ApplicationExitInfo.REASON_LOW_MEMORY
        || r == ApplicationExitInfo.REASON_EXCESSIVE_RESOURCE_USAGE
        || r == ApplicationExitInfo.REASON_DEPENDENCY_DIED;
  }

  @android.annotation.TargetApi(30)
  private static String reasonName(int r) {
    switch (r) {
      case ApplicationExitInfo.REASON_EXIT_SELF: return "EXIT_SELF";
      case ApplicationExitInfo.REASON_SIGNALED: return "SIGNALED";
      case ApplicationExitInfo.REASON_LOW_MEMORY: return "LOW_MEMORY";
      case ApplicationExitInfo.REASON_CRASH: return "CRASH";
      case ApplicationExitInfo.REASON_CRASH_NATIVE: return "CRASH_NATIVE";
      case ApplicationExitInfo.REASON_ANR: return "ANR";
      case ApplicationExitInfo.REASON_INITIALIZATION_FAILURE: return "INIT_FAILURE";
      case ApplicationExitInfo.REASON_PERMISSION_CHANGE: return "PERMISSION_CHANGE";
      case ApplicationExitInfo.REASON_EXCESSIVE_RESOURCE_USAGE: return "EXCESSIVE_RESOURCE";
      case ApplicationExitInfo.REASON_USER_REQUESTED: return "USER_REQUESTED";
      case ApplicationExitInfo.REASON_USER_STOPPED: return "USER_STOPPED";
      case ApplicationExitInfo.REASON_DEPENDENCY_DIED: return "DEPENDENCY_DIED";
      case ApplicationExitInfo.REASON_OTHER: return "OTHER";
      default: return "UNKNOWN(" + r + ")";
    }
  }

  /** The tombstone or ANR trace, when Android kept one. First 3 KB. */
  @android.annotation.TargetApi(30)
  private static String traceOf(ApplicationExitInfo x) {
    if (Build.VERSION.SDK_INT < 30) return null;
    try (InputStream in = x.getTraceInputStream()) {
      if (in == null) return null;
      byte[] buf = new byte[3072];
      int n = 0, r;
      while (n < buf.length && (r = in.read(buf, n, buf.length - n)) > 0) n += r;
      return new String(buf, 0, n, StandardCharsets.ISO_8859_1);
    } catch (Throwable t) {
      return null;
    }
  }

  private static void post(String kind, String message, String stack, String trail) {
    HttpURLConnection h = null;
    try {
      JSONObject o = new JSONObject();
      o.put("kind", kind);
      o.put("message", message);
      o.put("stack", stack);
      o.put("trail", trail);
      o.put("version", version);
      o.put("device", device);
      byte[] body = o.toString().getBytes(StandardCharsets.UTF_8);
      h = (HttpURLConnection) new URL(WidgetWork.BASE + "/api/app-report").openConnection();
      h.setConnectTimeout(4000);
      h.setReadTimeout(4000);
      h.setDoOutput(true);
      h.setRequestMethod("POST");
      h.setRequestProperty("Content-Type", "application/json");
      h.setFixedLengthStreamingMode(body.length);
      try (OutputStream out = h.getOutputStream()) { out.write(body); }
      h.getResponseCode();
    } catch (Throwable t) {
      Log.w(TAG, "app report post failed: " + t);
    } finally {
      if (h != null) h.disconnect();
    }
  }

  private static String stackOf(Throwable e) {
    StringWriter w = new StringWriter();
    e.printStackTrace(new PrintWriter(w));
    return w.toString();
  }

  private static String read(File f) {
    if (f == null || !f.exists()) return null;
    try (InputStream in = new java.io.FileInputStream(f)) {
      byte[] buf = new byte[4000];
      int n = 0, r;
      while (n < buf.length && (r = in.read(buf, n, buf.length - n)) > 0) n += r;
      return new String(buf, 0, n, StandardCharsets.UTF_8);
    } catch (Throwable t) {
      return null;
    }
  }
}
