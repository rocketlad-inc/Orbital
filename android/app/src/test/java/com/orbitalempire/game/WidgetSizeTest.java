package com.orbitalempire.game;

import org.junit.Test;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

/**
 * The widget card was cropped because it was asked for in a different
 * shape than the slot it was shown in. These pin the two halves of the
 * fix: the slot is read from what the launcher says (exact sizes first),
 * and bounding it never changes its shape inside the range the server
 * can draw.
 */
public class WidgetSizeTest {

  @Test
  public void exactSizesWinAndPortraitTakesTheTallOne() {
    // A Pixel-style 4x3 slot: portrait 352x323, landscape 600x218. The
    // min/max numbers are deliberately misleading; the list must win.
    float[] w = { 600f, 352f };
    float[] h = { 218f, 323f };
    assertArrayEquals(new int[] { 352, 323 }, WidgetSize.slot(100, 900, 100, 900, w, h, true));
    assertArrayEquals(new int[] { 600, 218 }, WidgetSize.slot(100, 900, 100, 900, w, h, false));
  }

  @Test
  public void aStaleListLeftByAMergedBundleLosesToMinMax() {
    // Bound at 320x300 / 360x210, then resized by a host that only
    // updated min/max to 400..420 x 400..460. The old list survives the
    // merge; asking for 320x300 would put a wrong-shaped card in it.
    float[] w = { 320f, 360f };
    float[] h = { 300f, 210f };
    assertArrayEquals(new int[] { 400, 460 }, WidgetSize.slot(400, 420, 400, 460, w, h, true));
  }

  @Test
  public void oneExactSizeIsUsedInEitherOrientation() {
    float[] w = { 380f };
    float[] h = { 300f };
    assertArrayEquals(new int[] { 380, 300 }, WidgetSize.slot(0, 0, 0, 0, w, h, true));
    assertArrayEquals(new int[] { 380, 300 }, WidgetSize.slot(0, 0, 0, 0, w, h, false));
  }

  @Test
  public void garbageInTheListFallsBackToTheConvention() {
    float[] w = { 0f, -1f };
    float[] h = { 200f, 0f };
    assertArrayEquals(new int[] { 320, 300 }, WidgetSize.slot(320, 360, 210, 300, w, h, true));
  }

  @Test
  public void withoutTheListPortraitIsMinWidthByMaxHeight() {
    assertArrayEquals(new int[] { 320, 300 }, WidgetSize.slot(320, 360, 210, 300, null, null, true));
    assertArrayEquals(new int[] { 360, 210 }, WidgetSize.slot(320, 360, 210, 300, null, null, false));
    // A launcher that fills only one of each pair.
    assertArrayEquals(new int[] { 360, 210 }, WidgetSize.slot(0, 360, 210, 0, null, null, true));
  }

  @Test
  public void boundingKeepsTheShape() {
    // Every slot from 60dp to 3000dp a side whose shape the server can
    // draw (between 1:2 and 4:1) comes back in the same shape, to a
    // pixel of rounding, and inside the server's box.
    for (int w = 60; w <= 3000; w += 37) {
      for (int h = 60; h <= 3000; h += 41) {
        double r = w / (double) h;
        int[] b = WidgetSize.bound(w, h);
        inBox(b);
        if (r >= 0.5 && r <= 4.0) {
          double got = b[0] / (double) b[1];
          double tol = (1.0 / b[1] + 1.0 / b[0]) * r + 1e-9;
          assertEquals("shape of " + w + "x" + h + " -> " + b[0] + "x" + b[1], r, got, tol * 1.5);
        }
      }
    }
  }

  @Test
  public void slotsThatAlreadyFitAreAskedForExactly() {
    assertArrayEquals(new int[] { 352, 323 }, WidgetSize.bound(352, 323));
    assertArrayEquals(new int[] { 240, 120 }, WidgetSize.bound(240, 120));
  }

  @Test
  public void aNarrowSlotGrowsOnBothAxes() {
    // minResizeWidth is 180dp: the old per-axis clamp asked 240x110 ->
    // 240x120 for a 180x110 slot, a different shape, and cropped it.
    int[] b = WidgetSize.bound(180, 110);
    assertEquals(240, b[0]);
    assertEquals(147, b[1]);
  }

  @Test
  public void aWholeScreenReportIsBoundedNotTrusted() {
    // THE LIMIT THAT KILLED THE PROCESS: a launcher reporting its whole
    // screen. The request must stay inside MAX on both axes, so the 2x
    // server image stays a bounded bitmap.
    int[] b = WidgetSize.bound(1440, 2560);
    inBox(b);
    assertTrue(b[0] <= WidgetSize.MAX_W && b[1] <= WidgetSize.MAX_H);
    long pxAt2x = (long) (b[0] * 2) * (b[1] * 2);
    assertTrue("2x card " + pxAt2x + "px", pxAt2x <= 4L * WidgetSize.MAX_W * WidgetSize.MAX_H);
  }

  @Test
  public void nothingKnownGetsADefaultCard() {
    int[] b = WidgetSize.bound(0, 0);
    inBox(b);
  }

  private static void inBox(int[] b) {
    assertTrue(b[0] + "w", b[0] >= WidgetSize.MIN_W && b[0] <= WidgetSize.MAX_W);
    assertTrue(b[1] + "h", b[1] >= WidgetSize.MIN_H && b[1] <= WidgetSize.MAX_H);
  }
}
