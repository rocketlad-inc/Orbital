// ============================================================
// LobbyMapPreview — solar-system map shown BEHIND the lobby panel
// while the host is still setting up a game.
//
// Fills the pre-game lobby backdrop so players can SEE where the
// starting worlds are, not just read them off the card grid. Renders
// the Sol system from the shared client-side body catalog (positions
// are deterministic from angle0, so no server data is needed for the
// geometry) and overlays:
//   - a faint ring on every CLAIMABLE starting world
//   - a bold teal ring + "✓ YOU" on the world the local player claimed
//   - a bold amber ring + player name on worlds others claimed
//
// THE CAMERA DOES NOT MOVE WHEN YOU PICK. It used to fly in and zoom
// to the claimed world (and its moons), which read well once and badly
// every time after: comparing candidates means seeing where they sit
// relative to each other, and the fly-in threw that away on every
// click. Worse, picking also reset the manual zoom/pan, so a player who
// had deliberately pulled out to compare got yanked back in and had to
// zoom out again — per playtest feedback, "every time".
//
// So the map frames the whole startable system and stays wherever the
// player put it. Claim state is carried entirely by the overlay rings,
// which are drawn in SCREEN space at a fixed pixel size and so stay
// legible at any zoom. Anyone wanting a close look can scroll or drag,
// and that view now survives the next pick.
//
// Purely visual: pointer-events are off so it never intercepts clicks
// meant for the panel. The card picker (StartingBodyPicker) remains
// the actual claim control.
// ============================================================

import React, { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { SHARED_BODIES, BINARY_SYSTEM_BODY_IDS, BLACK_HOLE_SYSTEM_BODY_IDS } from '../state/mockGameState';
import { bodyPosition } from '../physics/orbitalMechanics';
import {
  clearCanvas, drawOrbit, drawBody, worldToCanvas, RenderContext,
} from '../render/mapRenderer';
import type { RoomSnapshot } from './api';

// Sol-system bodies only — exclude the far Centauri / Cygnus systems
// (their barycenters sit 265K–340K out and would crush the inner
// system to a dot). Computed once at module load.
const SOL_BODIES = SHARED_BODIES.filter(
  b => !BINARY_SYSTEM_BODY_IDS.has(b.id) && !BLACK_HOLE_SYSTEM_BODY_IDS.has(b.id),
);
const BY_ID = new Map(SOL_BODIES.map(b => [b.id, b]));

/** Distance of a body from Sol (a moon's ≈ its parent's orbit radius
 *  plus its own). */
function solDistance(bodyId: string, depth = 0): number {
  if (depth > 6) return 0;  // cycle guard
  const b = BY_ID.get(bodyId);
  if (!b) return 0;
  if (!b.parent || b.parent === 'sol') return b.orbitRadius;
  return solDistance(b.parent, depth + 1) + b.orbitRadius;
}

interface Camera { x: number; y: number; scale: number; }

interface Props {
  snap: RoomSnapshot;
  myUserId?: string;
  /** Body id the local player has claimed. When set, the camera flies
   *  in to centre + zoom on it. Null/undefined → whole-system view. */
  focusBodyId?: string | null;
}

export const LobbyMapPreview: React.FC<Props> = ({ snap, myUserId, focusBodyId }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Animated camera: `cam` is the current (lerps toward `target`).
  const camRef = useRef<Camera | null>(null);
  const rafRef = useRef<number>(0);
  // Manual zoom multiplier on top of the auto-framing. Scroll the map
  // to zoom out/in for context; the camera CENTRE stays on the focused
  // planet (or system centre) UNLESS the player has dragged.
  const userZoomRef = useRef<number>(1);
  // Manual pan offset (world units) added on top of the framed centre.
  // Dragging the exposed map shifts this; it's clamped so the startable
  // system can never be dragged fully off-screen.
  const panRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  // Framing basis published by computeTarget each frame, so the drag
  // handlers can clamp the pan against the current focus + fit without
  // recomputing them.
  const baseCenterRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const maxPanRef = useRef<number>(0);

  // Deliberately NO re-frame effect on focusBodyId. Picking a capital
  // used to reset zoom + pan back to a default framing; that is the
  // thing playtesters had to undo after every single click.

  const claimsKey = snap.members
    .map(m => `${m.userId}:${m.chosen_starting_body ?? ''}`)
    .join('|');
  const optionsKey = (snap.starting_body_options ?? []).map(o => o.id).join(',');

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx2d = canvas.getContext('2d');
    if (!ctx2d) return;

    // Compute the target camera for the current size + focus.
    const computeTarget = (w: number, h: number): Camera => {
      const options = snap.starting_body_options ?? [];

      // Whole-system framing: fit every startable world + its parent.
      // This is the most zoomed-OUT the camera is allowed to go.
      let fit = 200;
      for (const o of options) {
        fit = Math.max(fit, solDistance(o.id));
        if (o.parent) fit = Math.max(fit, solDistance(o.parent));
      }
      fit *= 1.25;
      const fullScale = (Math.min(w, h) * 0.46) / fit;

      // Framing is ALWAYS the whole startable system, regardless of what
      // the player has claimed. The selection is communicated by the
      // overlay rings below, not by moving the camera, so that comparing
      // candidate worlds stays possible at a glance.
      const center = { x: 0, y: 0 };
      const frameScale = fullScale;

      // Clamp the manual zoom by EFFECTIVE scale, not a fixed multiplier:
      //   - can't pull out past fullScale (the whole startable system)
      //   - can push in to 6× the default frame
      const minZoom = (fullScale * 0.92) / frameScale;
      const maxZoom = 6;
      userZoomRef.current = Math.max(minZoom, Math.min(maxZoom, userZoomRef.current));

      // Publish the framing basis + a pan bound, then clamp the current
      // pan so the framed centre + pan stays within `fit` of Sol — you
      // can drag around the startable system but never lose it entirely.
      baseCenterRef.current = { x: center.x, y: center.y };
      maxPanRef.current = fit;
      const clampAbs = (base: number, off: number) =>
        Math.max(-fit, Math.min(fit, base + off)) - base;
      panRef.current.x = clampAbs(center.x, panRef.current.x);
      panRef.current.y = clampAbs(center.y, panRef.current.y);

      return {
        x: center.x + panRef.current.x,
        y: center.y + panRef.current.y,
        scale: frameScale * userZoomRef.current,
      };
    };

    const draw = (cam: Camera, w: number, h: number) => {
      const dpr = window.devicePixelRatio || 1;
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
      }
      ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);

      const ctx: RenderContext = {
        ctx: ctx2d,
        canvas: { width: w, height: h } as HTMLCanvasElement, // worldToCanvas reads width/height only
        camera: { x: cam.x, y: cam.y, scale: cam.scale },
        t: 0,
        bodies: SOL_BODIES,
      };

      // Visible set: only worlds you can actually START on, plus the
      // parents that anchor a selectable moon (so e.g. Io's orbit has a
      // Jupiter to circle), plus Sol as the centre. Everything else —
      // belt dwarfs, KBOs, rogue asteroids — is hidden so the map shows
      // only the capital options, not clutter.
      const visible = new Set<string>(['sol']);
      for (const o of (snap.starting_body_options ?? [])) {
        visible.add(o.id);
        let cur = BY_ID.get(o.id);
        let guard = 0;
        while (cur && cur.parent && cur.parent !== 'sol' && guard++ < 6) {
          visible.add(cur.parent);
          cur = BY_ID.get(cur.parent);
        }
      }

      clearCanvas(ctx);
      for (const b of SOL_BODIES) {
        if (b.type === 'star') continue;
        if (!visible.has(b.id)) continue;
        drawOrbit(b, ctx, 'rgba(120, 150, 180, 0.18)', 1);
      }
      for (const b of SOL_BODIES) {
        if (!visible.has(b.id)) continue;
        drawBody(b, ctx);
      }

      // Claim overlays.
      // Everyone ELSE's claim comes from the snapshot; the local
      // player's comes from focusBodyId, which is the optimistic value
      // set the instant you click. That matters more now than it used
      // to: the camera fly-in used to be the immediate feedback that a
      // click registered, and without it, sourcing your own ring from
      // the snapshot would leave the map looking inert for a full PATCH
      // round-trip. Taking it from focusBodyId also means the old ring
      // can't linger on your previous pick while the server catches up.
      const claimedBy = new Map<string, string>();
      for (const m of snap.members) {
        if (m.userId === myUserId) continue;
        if (m.chosen_starting_body) claimedBy.set(m.chosen_starting_body, m.userId);
      }
      if (myUserId && focusBodyId) claimedBy.set(focusBodyId, myUserId);
      const nameOf = (uid: string) =>
        snap.members.find(m => m.userId === uid)?.displayName ?? 'player';

      const startIds = new Set((snap.starting_body_options ?? []).map(o => o.id));
      for (const bodyId of startIds) {
        const b = BY_ID.get(bodyId);
        if (!b) continue;
        const wp = bodyPosition(b, 0, SOL_BODIES);
        const cp = worldToCanvas(wp.x, wp.y, ctx);
        const owner = claimedBy.get(bodyId);
        const isMine = !!owner && owner === myUserId;

        if (!owner) {
          ctx2d.strokeStyle = 'rgba(78, 205, 196, 0.55)';
          ctx2d.lineWidth = 1.25;
          ctx2d.beginPath();
          ctx2d.arc(cp.x, cp.y, 9, 0, Math.PI * 2);
          ctx2d.stroke();
        } else {
          const col = isMine ? '#4ecdc4' : '#ffb84d';
          ctx2d.strokeStyle = col;
          ctx2d.lineWidth = 2;
          ctx2d.beginPath();
          ctx2d.arc(cp.x, cp.y, 11, 0, Math.PI * 2);
          ctx2d.stroke();
          ctx2d.fillStyle = col;
          ctx2d.font = '600 11px "Audiowide", monospace';
          ctx2d.textAlign = 'center';
          ctx2d.textBaseline = 'top';
          ctx2d.fillText(isMine ? '✓ YOU' : nameOf(owner), cp.x, cp.y + 14);
        }
      }
    };

    // Animate the current camera toward the target, redrawing each frame
    // until it settles. Cheap exponential ease.
    const tick = () => {
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (w === 0 || h === 0) { rafRef.current = requestAnimationFrame(tick); return; }

      const target = computeTarget(w, h);
      // First run: snap straight to target (no fly-in from nowhere).
      if (!camRef.current) camRef.current = { ...target };

      const cam = camRef.current;
      const k = 0.18;
      cam.x += (target.x - cam.x) * k;
      cam.y += (target.y - cam.y) * k;
      cam.scale += (target.scale - cam.scale) * k;

      draw(cam, w, h);

      const settled =
        Math.abs(target.x - cam.x) < 0.5 &&
        Math.abs(target.y - cam.y) < 0.5 &&
        Math.abs(target.scale - cam.scale) < target.scale * 0.002;
      if (settled) {
        // One last exact draw, then stop until something changes.
        cam.x = target.x; cam.y = target.y; cam.scale = target.scale;
        draw(cam, w, h);
        rafRef.current = 0;
        return;
      }
      rafRef.current = requestAnimationFrame(tick);
    };

    const kick = () => {
      if (!rafRef.current) rafRef.current = requestAnimationFrame(tick);
    };

    // Scroll-to-zoom. Adjusts the manual multiplier and re-kicks the
    // animation, which eases to the new scale while keeping the camera
    // centred on the focused planet. Clamped so you can pull out to the
    // whole system or push in close, but never invert or lose the map.
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.22 : 1 / 1.22;
      // Loose safety bound only; computeTarget re-clamps by effective
      // scale each frame (so you can zoom out to the whole system and
      // in to 6× the frame regardless of how tight the focus is).
      userZoomRef.current = Math.max(0.001, Math.min(50, userZoomRef.current * factor));
      kick();
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });

    // Drag-to-pan. Pointer events cover mouse + touch (canvas has
    // touch-action:none so the browser doesn't steal the gesture). We
    // move both the pan offset and the *current* camera by the same
    // world delta, so the map tracks the cursor 1:1 with no lerp lag and
    // no snap-back when the drag ends (target == current camera).
    let dragging = false;
    let lastX = 0;
    let lastY = 0;
    const onPointerDown = (e: PointerEvent) => {
      dragging = true;
      lastX = e.clientX;
      lastY = e.clientY;
      canvas.style.cursor = 'grabbing';
      try { canvas.setPointerCapture(e.pointerId); } catch { /* noop */ }
    };
    const onPointerMove = (e: PointerEvent) => {
      if (!dragging) return;
      const cam = camRef.current;
      if (!cam) return;
      e.preventDefault();
      const dx = (e.clientX - lastX) / cam.scale;
      const dy = (e.clientY - lastY) / cam.scale;
      lastX = e.clientX;
      lastY = e.clientY;
      // Drag right → content follows the cursor right → centre moves left.
      let px = panRef.current.x - dx;
      let py = panRef.current.y - dy;
      // Clamp against the framing basis published by computeTarget.
      const b = baseCenterRef.current;
      const m = maxPanRef.current;
      px = Math.max(-m, Math.min(m, b.x + px)) - b.x;
      py = Math.max(-m, Math.min(m, b.y + py)) - b.y;
      panRef.current.x = px;
      panRef.current.y = py;
      cam.x = b.x + px;
      cam.y = b.y + py;
      draw(cam, canvas.clientWidth, canvas.clientHeight);
    };
    const onPointerUp = (e: PointerEvent) => {
      dragging = false;
      canvas.style.cursor = 'grab';
      try { canvas.releasePointerCapture(e.pointerId); } catch { /* noop */ }
    };
    canvas.style.cursor = 'grab';
    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointercancel', onPointerUp);

    kick();
    const ro = new ResizeObserver(kick);
    ro.observe(canvas);
    window.addEventListener('resize', kick);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
      ro.disconnect();
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerUp);
      window.removeEventListener('resize', kick);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [claimsKey, optionsKey, myUserId, focusBodyId]);

  // PORTAL TO BODY — required, not a nicety.
  //
  // This component is rendered from LobbyView, which lives inside the
  // dock panel (.mp-dock). That panel carries BOTH a `transform` (the
  // slide-in animation, identity matrix once open) and a
  // `backdrop-filter: blur()`. Either one alone makes the panel the
  // containing block for position:fixed descendants — so `inset: 0` was
  // resolving against the 440px dock instead of the viewport, and the
  // "full-screen backdrop" was quietly squeezed into a ~358px column
  // inside the panel it was supposed to sit behind.
  //
  // Portaling out to <body> puts it back under the real viewport. Keep
  // it here rather than moving the component up to App: `snap` and the
  // player's current pick both live in LobbyView, and lifting them just
  // to reach the DOM root would be a lot of plumbing for a layout fix.
  return createPortal(
    <div className="lobby-map-preview" aria-hidden="true">
      <canvas ref={canvasRef} className="lobby-map-preview__canvas" />
      <div className="lobby-map-preview__legend">
        <span><i className="dot dot--claimable" /> claimable</span>
        <span><i className="dot dot--mine" /> your pick</span>
        <span><i className="dot dot--other" /> taken</span>
        <span className="lobby-map-preview__hint">drag to pan · scroll to zoom</span>
      </div>
    </div>,
    document.body,
  );
};
