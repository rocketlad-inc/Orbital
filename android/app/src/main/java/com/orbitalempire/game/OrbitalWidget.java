package com.orbitalempire.game;

import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.Context;
import android.os.Bundle;
import android.util.Log;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * The home-screen widget.
 *
 * IT CONTAINS NO LAYOUT AND NO GAME KNOWLEDGE, ON PURPOSE. The entire
 * card is rendered by the Worker and arrives as a PNG; this class gets
 * that PNG into an ImageView. Anything drawn here could only change by
 * shipping a build through review; anything drawn on the server changes
 * with a deploy.
 *
 * IT DOES NOT DO THE NETWORK WORK ITSELF IF IT CAN HELP IT. A broadcast
 * receiver is a background component, and background network is what
 * Data Saver, the per-app background-data switch and App Standby cut on
 * a real phone -- the widget said "UnknownHostException" while the game
 * in Chrome played on. So every update is handed to WidgetFetchService,
 * a foreground service the OS lets talk to the network. Only when the
 * OS refuses to start it (Android 12+ from the background) does the
 * receiver do the work in-process, under goAsync, as it used to.
 *
 * IT MUST NEVER TAKE THE PROCESS DOWN. Same process as the game; the
 * work thread catches Throwable, not Exception, because OutOfMemoryError
 * is an Error and a bitmap is the one thing here big enough to raise it.
 *
 * PLACEMENT RUNS NOTHING BUT THIS RECEIVER. There is deliberately no
 * configuration activity: one runs while the launcher is still placing
 * the widget and waiting for its result, and ours opened the game --
 * which took the screen away and left the widget never placed at all.
 * So the pairing code is invented here, and the page that binds it is
 * opened later: on the player's next launch of the game, whose URL
 * OrbitalStartup rewrites, or on a tap of the widget. Only a signed-in
 * page can mint the token; see migration 0135.
 */
public class OrbitalWidget extends AppWidgetProvider {

  private static final String TAG = "OrbitalWidget";
  static final String BASE = WidgetWork.BASE;

  /** In-process fallback pool. */
  private static final ExecutorService IO = Executors.newFixedThreadPool(2);

  static boolean hasToken(Context c) {
    return WidgetWork.hasToken(c);
  }

  static void setToken(Context c, String token) {
    WidgetWork.setToken(c, token);
  }

  /**
   * Redraw every instance now. Service first; failing that, a broadcast
   * to ourselves so the receiver gets a real goAsync window (calling
   * onUpdate directly would give it none).
   */
  static void refreshAll(Context c, String reason) {
    int[] ids = WidgetWork.widgetIds(c);
    if (ids.length == 0) return;
    if (WidgetFetchService.launch(c, ids, reason)) return;
    c.sendBroadcast(WidgetWork.updateIntent(c, ids));
  }

  static void refreshAll(Context c) {
    refreshAll(c, "refreshAll");
  }

  /** Refresh only if the card is older than `maxAgeMs`. The game
   *  launcher calls this on every open, so a player who plays gets a
   *  current widget on the way out without a fetch per tap. */
  static void refreshIfStale(Context c, long maxAgeMs) {
    try {
      int[] ids = WidgetWork.widgetIds(c);
      if (ids.length == 0) return;
      long age = System.currentTimeMillis() - WidgetWork.lastPaintMs(c);
      if (WidgetWork.hasToken(c) && age < maxAgeMs) return;
      refreshAll(c, "app-open");
    } catch (Throwable t) {
      Log.w(TAG, "refreshIfStale failed", t);
    }
  }

  @Override
  public void onUpdate(Context context, AppWidgetManager manager, int[] ids) {
    if (WidgetFetchService.launch(context, ids, "update")) return;
    inProcess(context, ids);
  }

  /** A resize is a new image, not a rescale: the card is laid out by the
   *  server for the size it is asked for. */
  @Override
  public void onAppWidgetOptionsChanged(Context context, AppWidgetManager manager,
                                        int id, Bundle newOptions) {
    int[] ids = new int[] { id };
    if (WidgetFetchService.launch(context, ids, "resize")) return;
    inProcess(context, ids);
  }

  /**
   * The fallback: the same work, inside this broadcast's goAsync window
   * (about ten seconds). Pairing gets three polls here rather than the
   * service's two minutes, then an alarm retry.
   */
  private void inProcess(final Context context, final int[] ids) {
    final PendingResult pending = goAsync();
    final Context app = context.getApplicationContext();
    IO.execute(() -> {
      try {
        Log.i(TAG, "in-process run net: " + WidgetWork.netDiag(app));
        if (!WidgetWork.hasToken(app)) {
          WidgetWork.ensurePendingCode(app);
          if (!WidgetWork.pairingInFlight(app)) {
            WidgetWork.showHint(app, ids);
            return;
          }
          WidgetWork.showConnecting(app, ids);
          boolean got = false;
          for (int i = 0; i < 3 && !got; i++) {
            if (i > 0) Thread.sleep(2500);
            got = WidgetWork.pollPairing(app);
          }
          if (!got) {
            WidgetWork.pairingMissed(app, ids);
            return;
          }
        }
        WidgetWork.refresh(app, ids);
      } catch (Throwable t) {
        Log.e(TAG, "widget update failed", t);
      } finally {
        if (pending != null) pending.finish();
      }
    });
  }

  /** The last instance was removed, so the token has nothing left to
   *  feed. A re-added widget pairs afresh rather than reusing a
   *  credential the player may have revoked on the server. */
  @Override
  public void onDisabled(Context context) {
    WidgetWork.clearAll(context);
  }
}
