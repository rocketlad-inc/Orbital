package com.orbitalempire.game;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.util.Log;

import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Does the widget's network work as a FOREGROUND service, because that
 * is the only kind of process Android reliably lets talk to the network.
 *
 * THE PROBLEM IT SOLVES. The widget receiver ran its HTTP in the
 * background, and background network is what Data Saver, the per-app
 * "background data" switch and App Standby all cut on a real phone (the
 * emulator's network is unmetered, so Data Saver never bit there). The
 * first thing to fail is DNS, so the phone showed UnknownHostException
 * while Chrome, foreground, played the game happily. A foreground
 * service is exempt from every one of those.
 *
 * WHY shortService. It is the one foreground-service type that needs no
 * type-specific permission and no Play Console declaration: it may run
 * for three minutes and is then told to stop. A pairing poll plus one
 * image fetch is well inside that, and this app has no business running
 * longer in the background anyway.
 *
 * WHO STARTS IT. Activities while they are visible (widget placement,
 * the link handler, the game launcher) -- allowed on every Android. The
 * receiver too, which works on Android 11 and below and is refused on
 * 12+ when the app is in the background; then the receiver does the work
 * in-process as before. So the service is a better path, never the only
 * one.
 *
 * NOTHING IN HERE MAY THROW. Same process as the game.
 */
public class WidgetFetchService extends Service {

  private static final String TAG = "OrbitalWidget";
  private static final String CHANNEL = "widget";
  private static final int NOTIF_ID = 0x0b17a3;
  static final String EXTRA_IDS = "ids";
  static final String EXTRA_REASON = "reason";

  /** Hard ceiling on one run, under the 3-minute shortService limit. */
  private static final long MAX_RUN_MS = 150_000L;

  private final AtomicBoolean running = new AtomicBoolean(false);
  private volatile boolean stopped = false;

  /**
   * Start the service for these widgets. True if the OS accepted the
   * start; false means the caller must do the work another way.
   */
  static boolean launch(Context c, int[] ids, String reason) {
    if (ids == null || ids.length == 0) return true;
    try {
      Intent i = new Intent(c, WidgetFetchService.class);
      i.putExtra(EXTRA_IDS, ids);
      i.putExtra(EXTRA_REASON, reason);
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        c.startForegroundService(i);
      } else {
        c.startService(i);
      }
      return true;
    } catch (Throwable t) {
      // ForegroundServiceStartNotAllowedException on 12+ from the
      // background, or anything else: not our problem to solve here.
      Log.i(TAG, "service start refused (" + reason + "): " + t.getClass().getSimpleName());
      return false;
    }
  }

  @Override
  public IBinder onBind(Intent intent) {
    return null;
  }

  @Override
  public int onStartCommand(Intent intent, int flags, int startId) {
    // Foreground FIRST, every time: a startForegroundService that is not
    // followed by startForeground within seconds is itself a crash.
    try {
      Notification n = buildNotification();
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
        startForeground(NOTIF_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SHORT_SERVICE);
      } else {
        startForeground(NOTIF_ID, n);
      }
    } catch (Throwable t) {
      Log.w(TAG, "startForeground failed", t);
      stopSelf();
      return START_NOT_STICKY;
    }

    final int[] ids = intent == null ? null : intent.getIntArrayExtra(EXTRA_IDS);
    final String reason = intent == null ? "?" : String.valueOf(intent.getStringExtra(EXTRA_REASON));
    if (ids == null || ids.length == 0) {
      stopSelf();
      return START_NOT_STICKY;
    }
    if (!running.compareAndSet(false, true)) {
      // A run is already in progress and covers every widget; let it.
      return START_NOT_STICKY;
    }
    final Context app = getApplicationContext();
    Thread t = new Thread(() -> {
      try {
        Log.i(TAG, "service run (" + reason + ") net: " + WidgetWork.netDiag(app));
        work(app, ids);
      } catch (Throwable e) {
        Log.e(TAG, "service work failed", e);
      } finally {
        running.set(false);
        try {
          stopForeground(true);
        } catch (Throwable ignored) {
        }
        stopSelf();
      }
    }, "orbital-widget");
    t.setDaemon(true);
    t.start();
    return START_NOT_STICKY;
  }

  private void work(Context app, int[] ids) {
    long deadline = System.currentTimeMillis() + MAX_RUN_MS;
    if (!WidgetWork.hasToken(app)) {
      // Give this device a pairing code if it has none. It is born here
      // rather than in a configuration activity, because a configure
      // activity runs while the launcher is still placing the widget.
      WidgetWork.ensurePendingCode(app);
      if (!WidgetWork.pairingInFlight(app)) {
        // A code, but no reason to think a page is about to bind it.
        // Only a signed-in page can, so wait to be opened rather than
        // polling a server that has nothing for us.
        WidgetWork.showHint(app, ids);
        return;
      }
      WidgetWork.showConnecting(app, ids);
      // Poll for the pairing until it lands or this run is out of time.
      // The connect page binds within seconds when the player is signed
      // in; if they have to sign in first this waits for them.
      while (!stopped && System.currentTimeMillis() < deadline - 20_000L) {
        if (WidgetWork.pollPairing(app)) break;
        try {
          Thread.sleep(2500);
        } catch (InterruptedException ie) {
          break;
        }
      }
      if (!WidgetWork.hasToken(app)) {
        WidgetWork.pairingMissed(app, ids);
        return;
      }
    }
    if (stopped) return;
    WidgetWork.refresh(app, ids);
  }

  /** Android 14+: the shortService clock ran out. */
  @Override
  public void onTimeout(int startId) {
    stopped = true;
    try {
      stopForeground(true);
    } catch (Throwable ignored) {
    }
    stopSelf();
  }

  @Override
  public void onDestroy() {
    stopped = true;
    super.onDestroy();
  }

  private Notification buildNotification() {
    NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && nm != null) {
      NotificationChannel ch = new NotificationChannel(CHANNEL,
          getString(R.string.widget_channel), NotificationManager.IMPORTANCE_MIN);
      ch.setShowBadge(false);
      nm.createNotificationChannel(ch);
    }
    Notification.Builder b = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
        ? new Notification.Builder(this, CHANNEL)
        : new Notification.Builder(this);
    b.setSmallIcon(R.mipmap.ic_launcher)
        .setContentTitle(getString(R.string.widget_updating))
        .setOngoing(true)
        .setShowWhen(false);
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
      b.setPriority(Notification.PRIORITY_MIN);
    }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      b.setForegroundServiceBehavior(Notification.FOREGROUND_SERVICE_DEFERRED);
    }
    return b.build();
  }
}
