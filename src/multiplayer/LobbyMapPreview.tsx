// ============================================================
// LobbyMapPreview — solar-system map shown behind the lobby dock
// while the host is still setting up a game.
//
// Fills the otherwise-blank central viewport during the pre-game
// lobby so players can SEE where the starting worlds are, not just
// read them off the card grid. Renders the Sol system from the
// shared client-side body catalog (positions are deterministic from
// angle0, so no server data is needed for the geometry) and overlays:
//   - a faint ring on every CLAIMABLE starting world
//   - a bold teal ring + "YOU" on the world the local player claimed
//   - a bold amber ring + player name on worlds others claimed
//
// Purely visual: pointer-events are off so it never intercepts
// clicks meant for the dock or the card picker. The card picker
// (StartingBodyPicker) remains the actual claim control — the map
// is spatial context, especially useful for telling "Earth vs Mars
// vs a Jovian moon" apart at a glance.
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
 *  plus its own). Used to pick a camera scale that frames every
 *  startable world. */
function solDistance(bodyId: string, depth = 0): number {
  if (depth > 6) return 0;  // cycle guard
  const b = BY_ID.get(bodyId);
  if (!b) return 0;
  if (!b.parent || b.parent === 'sol') return b.orbitRadius;
  return solDistance(b.parent, depth + 1) + b.orbitRadius;
}

interface Props {
  snap: RoomSnapshot;
  myUserId?: string;
}

export const LobbyMapPreview: React.FC<Props> = ({ snap, myUserId }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Stable-ish dependency: re-render when the set of claims changes.
  const claimsKey = snap.members
    .map(m => `${m.userId}:${m.chosen_starting_body ?? ''}`)
    .join('|');
  const optionsKey = (snap.starting_body_options ?? []).map(o => o.id).join(',');

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx2d = canvas.getContext('2d');
    if (!ctx2d) return;

    const draw = () => {
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (w === 0 || h === 0) return;
      // Match the backing store to the CSS size (DPR-aware for crisp text).
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);

      const options = snap.starting_body_options ?? [];
      const startIds = new Set(options.map(o => o.id));
      // Frame to fit every startable world (+ its parent) with margin.
      let fit = 200;
      for (const o of options) {
        fit = Math.max(fit, solDistance(o.id));
        if (o.parent) fit = Math.max(fit, solDistance(o.parent));
      }
      fit *= 1.25;
      const scale = (Math.min(w, h) * 0.46) / fit;

      const ctx: RenderContext = {
        ctx: ctx2d,
        canvas: { width: w, height: h } as HTMLCanvasElement, // worldToCanvas only reads width/height
        camera: { x: 0, y: 0, scale },
        t: 0,
        bodies: SOL_BODIES,
      };

      clearCanvas(ctx);
      // Orbits first (faint), then bodies on top.
      for (const b of SOL_BODIES) {
        if (b.type === 'star') continue;
        drawOrbit(b, ctx, 'rgba(120, 150, 180, 0.18)', 1);
      }
      for (const b of SOL_BODIES) {
        drawBody(b, ctx);
      }

      // Claim overlays.
      const claimedBy = new Map<string, string>();           // bodyId -> userId
      for (const m of snap.members) {
        if (m.chosen_starting_body) claimedBy.set(m.chosen_starting_body, m.userId);
      }
      const nameOf = (uid: string) =>
        snap.members.find(m => m.userId === uid)?.displayName ?? 'player';

      for (const bodyId of startIds) {
        const b = BY_ID.get(bodyId);
        if (!b) continue;
        const wp = bodyPosition(b, 0, SOL_BODIES);
        const cp = worldToCanvas(wp.x, wp.y, ctx);
        const owner = claimedBy.get(bodyId);
        const isMine = !!owner && owner === myUserId;

        if (!owner) {
          // Claimable — quiet cyan ring.
          ctx2d.strokeStyle = 'rgba(78, 205, 196, 0.55)';
          ctx2d.lineWidth = 1.25;
          ctx2d.beginPath();
          ctx2d.arc(cp.x, cp.y, 9, 0, Math.PI * 2);
          ctx2d.stroke();
        } else {
          // Claimed — bold ring + name. Teal for you, amber for others.
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

    draw();
    // Redraw on viewport resize so the system stays framed.
    const ro = new ResizeObserver(draw);
    ro.observe(canvas);
    window.addEventListener('resize', draw);
    return () => { ro.disconnect(); window.removeEventListener('resize', draw); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [claimsKey, optionsKey, myUserId]);

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
