// ============================================================
// The intercept picker, on the map (state/interceptOverlay.ts).
//
//   - the pick bracketed in white with a TARGET tag, and its own course
//     to where it lands (a ring in its standing colour was lost among
//     allied sensor bubbles of the same teal);
//   - a ring on every other group you can catch, in its standing colour, so
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
import { worldToCanvas, farOffCanvas, safePolyline, TRAJECTORY_COLORS } from './mapRenderer';
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
  // The pick is not ringed: it gets the target treatment below.
  const ringed = new Set<string>(o.target ? [o.target.leadId] : []);
  for (const t of o.targets) {
    if (ringed.has(t.leadId)) continue;
    ringed.add(t.leadId);
    const hb = hullAt(t.leadId);
    if (!hb || farOffCanvas(rc, hb.x, hb.y, hb.r + 20)) continue;
    const r = Math.max(10, hb.r) + 6;
    c.strokeStyle = withOpacity(t.color, 0.7);
    c.lineWidth = 1.5;
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
      // Kept on screen: a SHOW frames the meeting near the edge often
      // enough (a phone is narrow) that a centred label lost its start.
      const half = c.measureText(o.meet.label).width / 2 + 4;
      const lx = Math.max(half, Math.min(w - half, mp.x));
      const ly = Math.max(14, mp.y - 20);
      c.fillStyle = 'rgba(6, 12, 20, 0.75)';
      c.fillText(o.meet.label, lx + 1, ly + 1);
      c.fillStyle = withOpacity(TRAJECTORY_COLORS.mine, 0.95);
      c.fillText(o.meet.label, lx, ly);
    }
  }

  if (o.target) drawTarget(rc, o.target, hullAt, nowMs);
  c.restore();
}

/**
 * The pick: its own course, from where it is now to where it lands, and
 * white brackets on its lead hull with a TARGET tag. White, not the
 * standing colour: at SHOW's zoom an allied target's teal ring vanished
 * among the allied sensor bubbles of the same teal. The course keeps the
 * standing colour, over a dark underlay so it reads across any wash, and
 * its dashes crawl toward the destination so the direction is plain.
 */
function drawTarget(
  rc: RenderContext,
  t: NonNullable<InterceptOverlay['target']>,
  hullAt: (shipId: string) => Hit | null,
  nowMs: number,
): void {
  const c = rc.ctx;
  const w = c.canvas.width, h = c.canvas.height;

  // ---- their course ----------------------------------------------------
  if (t.path.length >= 2) {
    const pts = t.path.map(p => worldToCanvas(p.x, p.y, rc));
    const trace = () => {
      c.beginPath();
      const pen = safePolyline(c, w, h);
      pen.move(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) pen.line(pts[i].x, pts[i].y);
    };
    c.save();
    c.lineCap = 'round';
    c.lineJoin = 'round';
    c.setLineDash([]);
    c.strokeStyle = 'rgba(3, 7, 13, 0.6)';
    c.lineWidth = 6;
    trace();
    c.stroke();
    c.setLineDash([9, 6]);
    c.lineDashOffset = -((nowMs / 40) % 15);
    c.strokeStyle = withOpacity(t.color, 0.95);
    c.lineWidth = 2.5;
    trace();
    c.stroke();
    c.setLineDash([]);
    // Where they land.
    const end = pts[pts.length - 1];
    if (!farOffCanvas(rc, end.x, end.y, 12)) {
      c.fillStyle = t.color;
      c.strokeStyle = '#ffffff';
      c.lineWidth = 1.5;
      c.beginPath();
      c.arc(end.x, end.y, 4.5, 0, Math.PI * 2);
      c.fill();
      c.stroke();
    }
    c.restore();
  }

  // ---- the hull --------------------------------------------------------
  const hb = hullAt(t.leadId);
  const at = hb ?? (t.path.length ? { ...worldToCanvas(t.path[0].x, t.path[0].y, rc), r: 10 } : null);
  if (!at || farOffCanvas(rc, at.x, at.y, 40)) return;
  const pulse = 0.5 + 0.5 * Math.sin(nowMs * 0.005);
  const R = Math.max(16, at.r + 8) + 2 * pulse;
  const arm = Math.max(6, R * 0.45);
  c.save();
  c.fillStyle = withOpacity(t.color, 0.14);
  c.beginPath();
  c.arc(at.x, at.y, R * 0.9, 0, Math.PI * 2);
  c.fill();
  const brackets = () => {
    c.beginPath();
    for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      const cx = at.x + sx * R, cy = at.y + sy * R;
      c.moveTo(cx, cy - sy * arm);
      c.lineTo(cx, cy);
      c.lineTo(cx - sx * arm, cy);
    }
  };
  c.lineCap = 'square';
  c.strokeStyle = 'rgba(3, 7, 13, 0.7)';
  c.lineWidth = 5;
  brackets();
  c.stroke();
  c.strokeStyle = '#ffffff';
  c.lineWidth = 2.5;
  brackets();
  c.stroke();

  // TARGET tag above it, kept on screen.
  c.font = 'bold 11px var(--font-body), monospace';
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  const tw = c.measureText(t.label).width;
  const bw = tw + 12, bh = 18;
  const lx = Math.max(bw / 2 + 4, Math.min(w - bw / 2 - 4, at.x));
  const ly = Math.max(bh / 2 + 4, at.y - R - 14);
  c.fillStyle = 'rgba(6, 12, 20, 0.88)';
  c.strokeStyle = t.color;
  c.lineWidth = 1;
  c.beginPath();
  c.rect(lx - bw / 2, ly - bh / 2, bw, bh);
  c.fill();
  c.stroke();
  c.fillStyle = '#ffffff';
  c.fillText(t.label, lx, ly + 0.5);
  c.restore();
}
