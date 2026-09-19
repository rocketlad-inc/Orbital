package com.orbitalempire.game;

import android.appwidget.AppWidgetHost;
import android.appwidget.AppWidgetManager;
import android.content.ComponentName;
import android.content.Context;
import android.os.Bundle;
import android.util.Log;

import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;

import org.junit.Test;
import org.junit.runner.RunWith;

import static org.junit.Assert.assertTrue;

/**
 * Bind a REAL widget to OrbitalWidget and let the system drive it.
 *
 * A fake appWidgetId gets an empty options bundle and a silently dropped
 * update, so broadcasting APPWIDGET_UPDATE at the receiver by hand
 * exercised almost none of what runs against an actual launcher. This
 * is an AppWidgetHost, which is what a launcher is: it allocates an id,
 * binds it to our provider, and hands it phone-sized options. The system
 * then delivers the real APPWIDGET_UPDATE and APPWIDGET_OPTIONS_CHANGED
 * broadcasts, with real ids and real sizes, into THIS process.
 *
 * Needs BIND_APPWIDGET, which a test cannot hold in its manifest but can
 * be granted from the shell:
 *   adb shell appwidget grantbind --package com.orbitalempire.game --user 0
 *
 * The assertion is weak on purpose. The failure this is for is the
 * process dying, and a dead process fails an instrumentation run on its
 * own ("Process crashed"), with the stack trace in AndroidRuntime:E.
 */
@RunWith(AndroidJUnit4.class)
public class RealWidgetTest {

  private static final String TAG = "RealWidgetTest";
  private static final int HOST_ID = 0x0b17a1;

  @Test
  public void bindARealWidgetAndLetItRender() throws Exception {
    Context ctx = InstrumentationRegistry.getInstrumentation().getTargetContext();
    AppWidgetManager mgr = AppWidgetManager.getInstance(ctx);
    AppWidgetHost host = new AppWidgetHost(ctx, HOST_ID);
    host.startListening();

    int id = host.allocateAppWidgetId();
    ComponentName provider = new ComponentName(ctx, OrbitalWidget.class);

    // Phone-shaped options, in dp, the way a 4x3 slot reports them.
    Bundle opts = new Bundle();
    opts.putInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, 320);
    opts.putInt(AppWidgetManager.OPTION_APPWIDGET_MAX_WIDTH, 360);
    opts.putInt(AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT, 210);
    opts.putInt(AppWidgetManager.OPTION_APPWIDGET_MAX_HEIGHT, 300);

    boolean bound = mgr.bindAppWidgetIdIfAllowed(id, provider, opts);
    Log.i(TAG, "bound=" + bound + " id=" + id);
    assertTrue("bindAppWidgetIdIfAllowed refused; run appwidget grantbind first", bound);

    // The bind itself makes the system send APPWIDGET_UPDATE. Give the
    // receiver time to fetch and paint.
    Thread.sleep(15000);
    Log.i(TAG, "after first render; process still here");

    // Now the size a big 4x4 slot reports, which is the largest image the
    // widget will ever request. A resize is a refetch, not a rescale.
    Bundle big = new Bundle();
    big.putInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, 400);
    big.putInt(AppWidgetManager.OPTION_APPWIDGET_MAX_WIDTH, 420);
    big.putInt(AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT, 400);
    big.putInt(AppWidgetManager.OPTION_APPWIDGET_MAX_HEIGHT, 460);
    mgr.updateAppWidgetOptions(id, big);
    Thread.sleep(15000);
    Log.i(TAG, "after resize render; process still here");

    host.stopListening();
  }
}
