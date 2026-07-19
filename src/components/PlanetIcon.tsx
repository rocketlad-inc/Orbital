// ============================================================
// PlanetIcon — the map's procedural planet art, at list size.
//
// Reuses getPlanetTexture (src/render/planetTexture.ts) — the exact
// same seeded canvas the map renderer draws — so a body looks the same
// in the Outliner as it does in space. A flat colour dot couldn't tell
// Mars from Ceres; this shows the actual continents/bands/craters.
//
// Perf: the 256px texture is painted ONCE per body and cached by
// planetTexture's LRU. This component only does a clipped drawImage
// into a small canvas, and only when the body or size changes.
// ============================================================

import React, { useEffect, useRef } from 'react';
import type { Body } from '../types';
import { getPlanetTexture } from '../render/planetTexture';
import { COLORS } from '../render/colors';

interface Props {
  body: Body;
  /** CSS pixel diameter. Backed by a DPR-scaled canvas so it stays
   *  crisp on retina. */
  size?: number;
  className?: string;
}

export const PlanetIcon: React.FC<Props> = ({ body, size = 16, className }) => {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const px = Math.round(size * dpr);
    canvas.width = px;
    canvas.height = px;
    const c = canvas.getContext('2d');
    if (!c) return;
    c.clearRect(0, 0, px, px);

    const r = px / 2;
    c.save();
    c.beginPath();
    c.arc(r, r, r, 0, Math.PI * 2);
    c.clip();

    const tex = getPlanetTexture(body);
    if (tex) {
      c.drawImage(tex, 0, 0, px, px);
    } else {
      // Texture unavailable (SSR / no document, or a body type with no
      // recipe) — fall back to the flat colour the outliner used before
      // so an icon never renders as an empty hole.
      c.fillStyle = body.color || COLORS.planetDefault;
      c.fillRect(0, 0, px, px);
    }

    // Terminator hint: a soft shadow on the lower-right so the disk
    // reads as a lit sphere rather than a flat sticker. The map's real
    // terminator tracks the sun; at 16px that precision is invisible,
    // so a fixed light direction is the honest simplification.
    const g = c.createLinearGradient(0, 0, px, px);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(0.55, 'rgba(0,0,0,0)');
    g.addColorStop(1, 'rgba(2,6,12,0.55)');
    c.fillStyle = g;
    c.fillRect(0, 0, px, px);
    c.restore();

    // Thin rim so the disk separates from the dark panel background.
    c.strokeStyle = 'rgba(255,255,255,0.18)';
    c.lineWidth = Math.max(1, dpr * 0.5);
    c.beginPath();
    c.arc(r, r, r - c.lineWidth / 2, 0, Math.PI * 2);
    c.stroke();
  }, [body, size]);

  return (
    <canvas
      ref={ref}
      className={className}
      style={{ width: size, height: size, borderRadius: '50%', display: 'block', flexShrink: 0 }}
      aria-hidden
    />
  );
};
