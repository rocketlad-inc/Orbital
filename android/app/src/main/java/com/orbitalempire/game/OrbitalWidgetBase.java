package com.orbitalempire.game;

import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.Context;
import android.os.Bundle;
import android.util.Log;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Everything both home-screen widgets do. The subclasses supply one
 * thing: which card they are.
 *
 * THEY CONTAIN NO LAYOUT AND NO GAME KNOWLEDGE, ON PURPOSE. Each card is
 * rendered whole by the Worker and arrives as a PNG; this class gets
 * that PNG into an ImageView. Anything drawn here could only change by
 * shipping a build through review; anything drawn on the server changes
 * with a deploy. That is also why a second widget costs a manifest entry
 * and not a second renderer.
 *
 * THEY DO NOT DO THE NETWORK WORK THEMSELVES IF THEY CAN HELP IT. A
 * broadcast receiver is a background component, and background network
 * is what Data Saver, the per-app background-data switch and App Standby
 * cut on a real phone -- the widget said "UnknownHostException" while
 * the game in Chrome played on. So every update is handed to
 * WidgetFetchService, a foreground service the OS lets talk to the
 * network, and only a refused start falls back to in-process work.
 *
 * THEY MUST NEVER TAKE THE PROCESS DOWN. Same process as the game; the
 * work thread catches Throwable, not Exception, because OutOfMemoryError
 * is an Error and a bitmap is the one thing here big enough to raise it.
 *
 * PLACEMENT RUNS NOTHING BUT THE RECEIVER. There is deliberately no
 * configuration activity: one runs while the launcher is still placing
 * the widget and waiting for its result, and ours opened the game, which
 * took the screen away and left the widget never placed at all.
 */
abstract class OrbitalWidgetBase extends AppWidgetProvider {

  private static final String TAG = "OrbitalWidget";

  /** In-process fallback pool, shared by both providers: each update is
   *  one short HTTP GET and there is never much in flight. */
  private static final ExecutorService IO = Executors.newFixedThreadPool(2);

  /** Which card this provider draws. */
  abstract WidgetWork.Kind kind();

  @Override
  public void onUpdate(Context context, AppWidgetManager manager, int[] ids) {
    final WidgetWork.Kind k = kind();
    // SAY SOMETHING BEFORE DOING ANYTHING. Fetching a card takes a
    // moment at best, and on a phone that throttles us it may take much
    // longer or never happen; until it lands the widget shows whatever
    // the launcher last drew. This is a local RemoteViews update with no
    // network in it, so it always wins the race.
    try {
      if (!WidgetWork.hasToken(context) && !WidgetWork.drewOnce(context, k)) {
        if (WidgetWork.pairingInFlight(context)) WidgetWork.showConnecting(context, k, ids);
        else WidgetWork.showHint(context, k, ids);
      }
    } catch (Throwable t) {
      Log.w(TAG, "could not paint the placeholder", t);
    }
    if (WidgetFetchService.launch(context, k, ids, "update")) return;
    inProcess(context, k, ids);
  }

  /** A resize is a new image, not a rescale: the card is laid out by the
   *  server for the size it is asked for, text included. */
  @Override
  public void onAppWidgetOptionsChanged(Context context, AppWidgetManager manager,
                                        int id, Bundle newOptions) {
    final WidgetWork.Kind k = kind();
    int[] ids = new int[] { id };
    if (WidgetFetchService.launch(context, k, ids, "resize")) return;
    inProcess(context, k, ids);
  }

  /**
   * The fallback: the same work inside this broadcast goAsync window
   * (about ten seconds). Pairing gets three polls here rather than the
   * service two minutes, then an alarm retry.
   */
  private void inProcess(final Context context, final WidgetWork.Kind k, final int[] ids) {
    final PendingResult pending = goAsync();
    final Context app = context.getApplicationContext();
    IO.execute(() -> {
      try {
        Log.i(TAG, "in-process run (" + k.name + ") net: " + WidgetWork.netDiag(app));
        if (!WidgetWork.hasToken(app)) {
          WidgetWork.ensurePendingCode(app);
          if (!WidgetWork.pairingInFlight(app)) {
            WidgetWork.showHint(app, k, ids);
            return;
          }
          WidgetWork.showConnecting(app, k, ids);
          boolean got = false;
          for (int i = 0; i < 3 && !got; i++) {
            if (i > 0) Thread.sleep(2500);
            got = WidgetWork.pollPairing(app);
          }
          if (!got) {
            WidgetWork.pairingMissed(app, k, ids);
            return;
          }
        }
        WidgetWork.refresh(app, k, ids);
      } catch (Throwable t) {
        Log.e(TAG, "widget update failed", t);
      } finally {
        if (pending != null) pending.finish();
      }
    });
  }

  /**
   * The last instance of THIS provider was removed.
   *
   * THE TOKEN IS SHARED, so it may only be dropped once nothing of ours
   * is left anywhere. onDisabled fires per provider, and taking the
   * pairing away because the battle card was removed would strand the
   * main card still sitting on the home screen -- it would go back to
   * "tap to finish connecting" for no reason the player could see.
   */
  @Override
  public void onDisabled(Context context) {
    try {
      if (WidgetWork.noWidgetsLeft(context)) {
        Log.i(TAG, "last widget removed; forgetting the pairing");
        WidgetWork.clearAll(context);
      }
    } catch (Throwable t) {
      Log.w(TAG, "onDisabled failed", t);
    }
  }
}
