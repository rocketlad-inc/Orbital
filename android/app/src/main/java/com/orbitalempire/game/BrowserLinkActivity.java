package com.orbitalempire.game;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.net.Uri;
import android.os.Bundle;
import android.widget.Toast;

import java.util.List;

/**
 * Catches orbital://browser?url=… and opens that page in the phone's own
 * browser: the Commission's "get it in your browser" (Lorne, 2026-10-08:
 * "make sure the app doesnt try to do this and instead links the customer
 * to the browser").
 *
 * WHY NATIVE. The game cannot get there by itself. Every link to
 * orbital-empire.com opens the APP (the launcher's autoVerify filter), and
 * a TWA navigating its own origin stays in the TWA. Only an intent with a
 * browser named as its package skips the app link.
 *
 * WHICH BROWSER. The player's default one, found by asking who would open
 * a page that is not ours. When that answer is the system chooser (no
 * default set) or this app, Chrome is preferred, then any other browser.
 *
 * Only https://orbital-empire.com pages are opened: anything on the web
 * can fire this scheme, and it must not become a way to throw arbitrary
 * pages at the player.
 */
public class BrowserLinkActivity extends Activity {

  private static final String SITE_HOST = "orbital-empire.com";
  private static final String CHROME = "com.android.chrome";

  @Override
  protected void onCreate(Bundle saved) {
    super.onCreate(saved);
    handle(getIntent());
    finish();
  }

  @Override
  protected void onNewIntent(Intent intent) {
    super.onNewIntent(intent);
    handle(intent);
    finish();
  }

  private void handle(Intent intent) {
    Uri data = intent == null ? null : intent.getData();
    String raw = data == null ? null : data.getQueryParameter("url");
    Uri target = raw == null ? null : Uri.parse(raw);
    if (target == null
        || !"https".equals(target.getScheme())
        || !SITE_HOST.equals(target.getHost())) {
      Toast.makeText(this, "That link was not valid.", Toast.LENGTH_LONG).show();
      return;
    }

    String browser = browserPackage();
    if (browser == null) {
      Toast.makeText(this, "Open orbital-empire.com in your browser.", Toast.LENGTH_LONG).show();
      return;
    }
    Intent view = new Intent(Intent.ACTION_VIEW, target)
        .addCategory(Intent.CATEGORY_BROWSABLE)
        .setPackage(browser)
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
    try {
      startActivity(view);
    } catch (ActivityNotFoundException e) {
      Toast.makeText(this, "Open orbital-empire.com in your browser.", Toast.LENGTH_LONG).show();
    }
  }

  /** The browser to hand the page to, never this app. */
  private String browserPackage() {
    PackageManager pm = getPackageManager();
    Intent probe = new Intent(Intent.ACTION_VIEW, Uri.parse("https://example.com/"))
        .addCategory(Intent.CATEGORY_BROWSABLE);
    ResolveInfo def = pm.resolveActivity(probe, PackageManager.MATCH_DEFAULT_ONLY);
    String self = getPackageName();
    if (def != null && def.activityInfo != null) {
      String pkg = def.activityInfo.packageName;
      // "android" is the chooser: no default browser is set.
      if (pkg != null && !pkg.equals("android") && !pkg.equals(self)) return pkg;
    }
    List<ResolveInfo> all = pm.queryIntentActivities(probe, 0);
    String fallback = null;
    for (ResolveInfo ri : all) {
      if (ri.activityInfo == null) continue;
      String pkg = ri.activityInfo.packageName;
      if (pkg == null || pkg.equals(self)) continue;
      if (pkg.equals(CHROME)) return pkg;
      if (fallback == null) fallback = pkg;
    }
    return fallback;
  }
}
