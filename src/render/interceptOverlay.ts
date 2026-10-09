// ============================================================
// The intercept picker, on the map (state/interceptOverlay.ts).
//
//   - a ring on every group you can catch, in its standing colour, so
//     the picker's list and the map point at the same hulls;
//   - the meeting at the door, which had no mark at all (a match draws
//     its own through the rendezvous preview);
//   - while SHOW has the camera, a veil over everything outside the
//     course, so the framed course is what the eye lands on.
//
// Drawn last, over labels and fog: it is the answer to the question the
// player is asking right now.
// ============================================================

import type { RenderContext } from './mapRenderer';
import { worldToCanvas, farOffCanvas, TRAJECTORY_COLORS } from './mapRenderer';
import { withOpacity } from './colors';
import type { InterceptOverlay } from '../state/interceptOverlay';

type Hit = { x: number; y: number; r: number };

export function drawInterceptOverlay(
  rc: RenderContext,
  o: InterceptOverlay,
  hullAt: (shipId: string) => Hit | null,
  nowMs: number,
): void {
  const c = rc.ctx;
  const w = c.canvas.width, h = c.canvas.height;
  c.save();

  // ---- the veil ----------------------------------------------------
  if (o.focus) {
    const a = worldToCanvas(o.focus.minX, o.focus.minY, rc);
    const b = worldToCanvas(o.focus.maxX, o.focus.maxY, rc);
    // Clamped to a screen of margin: a box that runs off to a far system
    // must never hand the GPU a coordinate in the hundreds of millions
    // (orbital_far_coords_gpu).
    const clampX = (v: number) => Math.max(-w, Math.min(2 * w, v));
    const clampY = (v: number) => Math.max(-h, Math.min(2 * h, v));
    const pad = 56;
    const x0 = clampX(Math.min(a.x, b.x) - pad), x1 = clampX(Math.max(a.x, b.x) + pad);
    const y0 = clampY(Math.min(a.y, b.y) - pad), y1 = clampY(Math.max(a.y, b.y) + pad);
    if (Number.isFinite(x0) && Number.isFinite(y0) && Number.isFinite(x1) && Number.isFinite(y1)) {
      const r = Math.min(28, (x1 - x0) / 2, (y1 - y0) / 2);
      c.beginPath();
      c.rect(0, 0, w, h);
      // The hole, wound the other way so evenodd leaves it clear.
      c.moveTo(x0 + r, y0);
      c.arcTo(x0, y0, x0, y0 + r, r);
      c.lineTo(x0, y1 - r);
      c.arcTo(x0, y1, x0 + r, y1, r);
      c.lineTo(x1 - r, y1);
      c.arcTo(x1, y1, x1, y1 - r, r);
      c.lineTo(x1, y0 + r);
      c.arcTo(x1, y0, x1 - r, y0, r);
      c.closePath();
      c.fillStyle = 'rgba(3, 7, 13, 0.55)';
      c.fill('evenodd');
    }
  }

  // ---- rings on what you can catch -----------------------------------
  const pulse = 0.5 + 0.5 * Math.sin(nowMs * 0.004);
  const ringed = new Set<string>();
  for (const t of o.targets) {
    if (ringed.has(t.leadId)) continue;
    ringed.add(t.leadId);
    const hb = hullAt(t.leadId);
    if (!hb || farOffCanvas(rc, hb.x, hb.y, hb.r + 20)) continue;
    const r = Math.max(10, hb.r) + 6;
    if (t.selected) {
      c.strokeStyle = withOpacity(t.color, 0.25 + 0.3 * pulse);
      c.lineWidth = 6;
      c.beginPath();
      c.arc(hb.x, hb.y, r + 2 + 2 * pulse, 0, Math.PI * 2);
      c.stroke();
      c.strokeStyle = withOpacity(t.color, 0.95);
      c.lineWidth = 2.5;
    } else {
      c.strokeStyle = withOpacity(t.color, 0.7);
      c.lineWidth = 1.5;
    }
    c.beginPath();
    c.arc(hb.x, hb.y, r, 0, Math.PI * 2);
    c.stroke();
  }

  // ---- the meeting at the door ---------------------------------------
  // The rendezvous preview's own meeting mark, so a door meet and an
  // in-flight meet read as the same kind of thing.
  if (o.meet) {
    const mp = worldToCanvas(o.meet.x, o.meet.y, rc);
    if (!farOffCanvas(rc, mp.x, mp.y, 40)) {
      const p = 0.5 + 0.5 * Math.sin(nowMs * 0.0035);
      c.strokeStyle = withOpacity(TRAJECTORY_COLORS.mine, 0.25 + 0.35 * p);
      c.lineWidth = 1.5;
      c.beginPath();
      c.arc(mp.x, mp.y, 12 + 3 * p, 0, Math.PI * 2);
      c.stroke();
      c.strokeStyle = withOpacity(TRAJECTORY_COLORS.mine, 0.9);
      c.beginPath();
      c.arc(mp.x, mp.y, 8, 0, Math.PI * 2);
      c.stroke();
      c.beginPath();
      c.moveTo(mp.x - 14, mp.y); c.lineTo(mp.x - 10, mp.y);
      c.moveTo(mp.x + 10, mp.y); c.lineTo(mp.x + 14, mp.y);
      c.moveTo(mp.x, mp.y - 14); c.lineTo(mp.x, mp.y - 10);
      c.moveTo(mp.x, mp.y + 10); c.lineTo(mp.x, mp.y + 14);
      c.stroke();
      c.font = '10px var(--font-body), monospace';
      c.textAlign = 'center';
      c.fillStyle = 'rgba(6, 12, 20, 0.75)';
      c.fillText(o.meet.label, mp.x + 1, mp.y - 19);
      c.fillStyle = withOpacity(TRAJECTORY_COLORS.mine, 0.95);
      c.fillText(o.meet.label, mp.x, mp.y - 20);
    }
  }
  c.restore();
}
