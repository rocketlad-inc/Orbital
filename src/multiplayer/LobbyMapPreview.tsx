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
// When the local player has claimed a world (focusBodyId), the camera
// animates to centre + zoom on that world (and its moons), so picking
// a capital on the panel visibly flies the backdrop in to it. With no
// claim, it frames the whole inner system.
//
// Purely visual: pointer-events are off so it never intercepts clicks
// meant for the panel. The card picker (StartingBodyPicker) remains
// the actual claim control.
// ============================================================

import React, { useEffect, useRef } from 'react';
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
      let fit = 200;
      for (const o of options) {
        fit = Math.max(fit, solDistance(o.id));
        if (o.parent) fit = Math.max(fit, solDistance(o.parent));
      }
      fit *= 1.25;
      const fullScale = (Math.min(w, h) * 0.46) / fit;

      const focus = focusBodyId ? BY_ID.get(focusBodyId) : undefined;
      if (!focus) {
        return { x: 0, y: 0, scale: fullScale };
      }

      // Focus framing: centre on the body, zoom so the body + its moons
      // fill the view. A moon-less world uses its own radius; a planet
      // with moons frames the widest moon orbit.
      const wp = bodyPosition(focus, 0, SOL_BODIES);
      let moonSpan = focus.radius * 8;
      for (const b of SOL_BODIES) {
        if (b.parent === focus.id) moonSpan = Math.max(moonSpan, b.orbitRadius * 1.4);
      }
      const focusScale = (Math.min(w, h) * 0.40) / Math.max(moonSpan, 1);
      return { x: wp.x, y: wp.y, scale: focusScale };
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

      clearCanvas(ctx);
      for (const b of SOL_BODIES) {
        if (b.type === 'star') continue;
        drawOrbit(b, ctx, 'rgba(120, 150, 180, 0.18)', 1);
      }
      for (const b of SOL_BODIES) {
        drawBody(b, ctx);
      }

      // Claim overlays.
      const claimedBy = new Map<string, string>();
      for (const m of snap.members) {
        if (m.chosen_starting_body) claimedBy.set(m.chosen_starting_body, m.userId);
      }
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
          ctx2d.font = '600 11px "JetBrains Mono", monospace';
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

    kick();
    const ro = new ResizeObserver(kick);
    ro.observe(canvas);
    window.addEventListener('resize', kick);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
      ro.disconnect();
      window.removeEventListener('resize', kick);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [claimsKey, optionsKey, myUserId, focusBodyId]);

  return (
    <div className="lobby-map-preview" aria-hidden="true">
      <canvas ref={canvasRef} className="lobby-map-preview__canvas" />
      <div className="lobby-map-preview__legend">
        <span><i className="dot dot--claimable" /> claimable</span>
        <span><i className="dot dot--mine" /> your pick</span>
        <span><i className="dot dot--other" /> taken</span>
      </div>
    </div>
  );
};
