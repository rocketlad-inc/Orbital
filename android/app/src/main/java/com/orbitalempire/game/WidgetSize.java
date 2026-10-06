package com.orbitalempire.game;

/**
 * What size of card to ask the server for, in dp. Pure arithmetic with no
 * Android types, so it runs under a plain JVM unit test (WidgetSizeTest).
 *
 * THE CARD WAS CROPPED ("all widgets are cropped quite a bit on my screen
 * size", playtester, 2026-10). Three things stacked:
 *
 *  1. The size came from OPTION_APPWIDGET_MIN_WIDTH x MAX_HEIGHT. That
 *     pairing is only the documented PORTRAIT convention, and launchers
 *     differ in how they fill the four numbers -- it is a guess at the
 *     real slot, not the slot. Android 12+ hands over the exact sizes
 *     (OPTION_APPWIDGET_SIZES) and nothing read them.
 *  2. Each axis was clamped on its own (240..480 x 120..480), so any slot
 *     narrower than 240dp or wider than 480dp was asked for in a
 *     DIFFERENT SHAPE than it is.
 *  3. The ImageView was centerCrop, so any shape mismatch at all was cut
 *     off the edges of a card that is mostly text at the edges.
 *
 * Now: the exact sizes when the launcher gives them, the orientation's
 * own pair when it does not, a bound that scales both axes together, and
 * fitCenter in the layout, so a guess that is still wrong letterboxes a
 * few dp of background instead of cutting a row off.
 */
final class WidgetSize {

  /** Smallest card the server lays out (both renderers floor at 240x120;
   *  below that their text collides). */
  static final int MIN_W = 240, MIN_H = 120;
  /** Largest card asked for. The servers supersample 2x, so 480x480dp is
   *  a 960x960 PNG -- already over the decode budget and sampled down.
   *  A launcher that reports its whole screen must not become a
   *  2400x1600 request (that OOM'd the process once). */
  static final int MAX_W = 480, MAX_H = 480;

  private WidgetSize() {}

  /**
   * The slot this widget actually occupies right now, in dp, before any
   * bounding. Returns {w, h}; either may be 0 if the launcher said
   * nothing useful.
   *
   * @param sizesW,sizesH OPTION_APPWIDGET_SIZES (Android 12+), parallel
   *        arrays, or null/empty when the launcher did not supply them.
   *        A phone launcher lists one size per orientation it can show;
   *        the tallest is the portrait one, the widest the landscape one.
   */
  static int[] slot(int minW, int maxW, int minH, int maxH,
                    float[] sizesW, float[] sizesH, boolean portrait) {
    if (sizesW != null && sizesH != null) {
      int n = Math.min(sizesW.length, sizesH.length);
      int best = -1;
      double bestRatio = 0;
      for (int i = 0; i < n; i++) {
        if (!(sizesW[i] > 0) || !(sizesH[i] > 0)) continue;
        double r = sizesH[i] / (double) sizesW[i];
        if (best < 0 || (portrait ? r > bestRatio : r < bestRatio)) {
          best = i;
          bestRatio = r;
        }
      }
      if (best >= 0) return new int[] { Math.round(sizesW[best]), Math.round(sizesH[best]) };
    }
    // The documented convention: portrait shows the narrow-and-tall
    // extreme (min width, max height), landscape the wide-and-short one.
    int w = portrait ? first(minW, maxW) : first(maxW, minW);
    int h = portrait ? first(maxH, minH) : first(minH, maxH);
    return new int[] { w, h };
  }

  private static int first(int a, int b) {
    return a > 0 ? a : (b > 0 ? b : 0);
  }

  /**
   * Bound a slot to what the server will draw, KEEPING ITS SHAPE. Scale
   * both axes down together to fit MAX, then up together toward MIN
   * without passing MAX. Only a slot more extreme than MAX_W:MIN_H (4:1)
   * or MIN_W:MAX_H (1:2) is clamped out of shape, and fitCenter
   * letterboxes that remainder rather than cropping it.
   */
  static int[] bound(int w, int h) {
    if (w <= 0 || h <= 0) return new int[] { 360, 270 };
    double W = w, H = h;
    double down = Math.min(1.0, Math.min(MAX_W / W, MAX_H / H));
    W *= down;
    H *= down;
    double up = Math.max(1.0, Math.max(MIN_W / W, MIN_H / H));
    up = Math.min(up, Math.min(MAX_W / W, MAX_H / H));
    W *= up;
    H *= up;
    int bw = clamp((int) Math.round(W), MIN_W, MAX_W);
    int bh = clamp((int) Math.round(H), MIN_H, MAX_H);
    return new int[] { bw, bh };
  }

  private static int clamp(int v, int lo, int hi) {
    return v < lo ? lo : (v > hi ? hi : v);
  }
}
