// ============================================================
// PlanetIcon — the map's procedural planet art, at list size.
//
// Reuses getPlanetTexture (src/render/planetTexture.ts) — the exact
// same seeded canvas the map renderer draws — so a body looks the same
// in the Outliner as it does in space. A flat colour dot couldn't tell
// Mars from Ceres; this shows the actual continents/bands/craters.
//
// TERRAFORM-AWARE: a flipped world draws the terraformed face and one
// mid-transformation crossfades toward it, mirroring the map exactly
// (see terraformFraction). A world can't read as a garden in space and
// a dead rock in the Outliner.
//
// ATMOSPHERE: worlds that have air get a drifting cloud deck. That
// includes terrestrials and giants always, and any other world in
// proportion to how terraformed it is — so an airless raw moon has bare
// rock and gaining weather is the visible payoff of terraforming.
//
// Perf: the 256px textures are painted ONCE per body and cached by
// planetTexture's LRU. Animation is one shared rAF for the whole list
// (see cloudClock) rather than a timer per icon, throttled, and only
// subscribed to by icons that actually have a cloud deck.
// ============================================================

import React, { useEffect, useRef, useState } from 'react';
import type { Body } from '../types';
import {
  getPlanetTexture, getTerraformedTexture, getCloudTexture, terraformFraction,
} from '../render/planetTexture';
import { COLORS } from '../render/colors';
import { isLightweight } from '../render/lightweightMode';
import { StructureIcon, StructureScaffold } from './StructureIcons';
import { MEGASTRUCTURES, progressOf } from '../game/megastructures';
import { useGameContext } from '../state/gameContext';

// ---------- shared cloud clock ----------
//
// One requestAnimationFrame for every icon on screen. A per-icon timer
// would mean 20+ independent rAF loops in a full Outliner, all doing the
// same arithmetic; this does it once and hands the same timestamp to
// everyone, which also keeps every world's weather in step.
//
// Throttled well below display rate: these are 16px discs, and cloud
// drift is a slow atmospheric effect — past ~12fps the extra frames are
// invisible and cost real battery on a laptop.
const CLOUD_FPS = 12;
const subscribers = new Set<(t: number) => void>();
let rafId: number | null = null;
let lastEmit = 0;

function pump(now: number) {
  rafId = requestAnimationFrame(pump);
  if (now - lastEmit < 1000 / CLOUD_FPS) return;
  lastEmit = now;
  for (const fn of subscribers) fn(now);
}

function subscribeClouds(fn: (t: number) => void): () => void {
  subscribers.add(fn);
  if (rafId === null) rafId = requestAnimationFrame(pump);
  return () => {
    subscribers.delete(fn);
    // Nothing left to animate — stop burning frames entirely.
    if (subscribers.size === 0 && rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
  };
}

/** Does this world have air to show? Mirrors drawCloudDeck's rule in the
 *  map renderer: terrestrials and giants always, everything else only
 *  once terraforming has taken hold. */
function cloudAlphaFor(body: Body, tfF: number): number {
  if (body.type === 'terrestrial') return 0.45;
  if (body.type === 'gas_giant') return 0.55;
  if (body.type === 'ice_giant') return 0.38;
  return tfF > 0.25 ? 0.45 * tfF : 0;
}

interface Props {
  body: Body;
  /** CSS pixel diameter. Backed by a DPR-scaled canvas so it stays
   *  crisp on retina. */
  size?: number;
  className?: string;
  /** Current tick — only needed to place a world inside its terraform
   *  crossfade. A terraformed or raw world resolves without it, so this
   *  stays optional for callers that don't have game state to hand. */
  currentTick?: number;
  /** Opt out of the drifting cloud deck (static contexts, tests). */
  animate?: boolean;
}

export const PlanetIcon: React.FC<Props> = ({
  body, size = 16, className, currentTick = 0, animate = true,
}) => {
  const ref = useRef<HTMLCanvasElement>(null);
  // Build state for megastructure rows. Read here rather than passed
  // in, because every existing caller draws worlds and should not
  // have to learn about structures to keep compiling.
  const { gameState: pgs } = useGameContext();
  const mega = pgs.megastructures;
  // How terraformed this world should LOOK — the same function the map
  // and the world-menu closeup call, so a world can't read as a lush
  // garden in space and a dead rock in the Outliner.
  const tfF = terraformFraction(body, currentTick);
  const cloudAlpha = cloudAlphaFor(body, tfF);
  const animated = animate && cloudAlpha > 0;
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    if (!animated) return;
    return subscribeClouds((t) => setFrame(t));
  }, [animated]);

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

    // A MEGASTRUCTURE IS NOT A WORLD, so it does not get a planet face.
    // The outliner was drawing a site as a coloured disc — the same
    // generic sphere every planet gets — while the map showed a truss
    // frame, so the list and the map disagreed about what the thing
    // even was. Draw the actual sprite instead, at the same build stage
    // the map is showing.
    c.save();
    c.beginPath();
    c.arc(r, r, r, 0, Math.PI * 2);
    c.clip();

    // Terraform-aware face selection, mirroring the map renderer: a
    // flipped world draws the terraformed texture outright, and a world
    // mid-transformation crossfades raw → terraformed so the icon
    // visibly becomes green as the payload lands. Both faces are painted
    // from the same seed stream, so continents and craters stay put and
    // only the surface is reinterpreted.
    // Lightweight: flat disc. These icons appear once per row in the
    // Empire/Fleet lists, so a list of thirty worlds is thirty texture
    // blits on every re-render.
    const tex = isLightweight() ? null : (tfF >= 1
      ? (getTerraformedTexture(body) ?? getPlanetTexture(body))
      : getPlanetTexture(body));
    if (tex) {
      c.drawImage(tex, 0, 0, px, px);
      if (tfF > 0 && tfF < 1) {
        const tfTex = getTerraformedTexture(body);
        if (tfTex) {
          c.save();
          c.globalAlpha = tfF;
          c.drawImage(tfTex, 0, 0, px, px);
          c.restore();
        }
      }
    } else {
      // Texture unavailable (SSR / no document, or a body type with no
      // recipe) — fall back to the flat colour the outliner used before
      // so an icon never renders as an empty hole.
      c.fillStyle = body.color || COLORS.planetDefault;
      c.fillRect(0, 0, px, px);
    }

    // Drifting cloud deck. Scrolled horizontally and wrapped, which is
    // why paintClouds draws every puff three times across the seam — the
    // wrap is invisible. Speed is per-body so two worlds side by side
    // don't turn in lockstep, and slow enough to read as weather rather
    // than as a spinning texture.
    if (cloudAlpha > 0) {
      const clouds = getCloudTexture(body);
      if (clouds) {
        const speed = 0.004 + (body.id.charCodeAt(0) % 7) * 0.0006;
        const off = animated ? ((frame * speed) % px) : 0;
        c.save();
        c.globalAlpha = cloudAlpha;
        c.drawImage(clouds, off, 0, px, px);
        c.drawImage(clouds, off - px, 0, px, px);
        c.restore();
      }
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

    // Atmospheric rim: a bright arc on the sunward limb, only on worlds
    // that have air. It's what separates "planet with a sky" from "bare
    // rock" at icon size, where the cloud deck alone is a few pixels.
    if (cloudAlpha > 0) {
      c.save();
      c.globalCompositeOperation = 'lighter';
      const rim = c.createRadialGradient(r, r, r * 0.72, r, r, r);
      rim.addColorStop(0, 'rgba(150, 210, 255, 0)');
      rim.addColorStop(0.85, `rgba(150, 210, 255, ${0.30 * Math.min(1, cloudAlpha / 0.45)})`);
      rim.addColorStop(1, 'rgba(150, 210, 255, 0)');
      c.fillStyle = rim;
      c.beginPath();
      c.arc(r, r, r, 0, Math.PI * 2);
      c.fill();
      c.restore();
    }

    // Thin rim so the disk separates from the dark panel background.
    c.strokeStyle = 'rgba(255,255,255,0.18)';
    c.lineWidth = Math.max(1, dpr * 0.5);
    c.beginPath();
    c.arc(r, r, r - c.lineWidth / 2, 0, Math.PI * 2);
    c.stroke();
    // `mega` is in the deps so a site's icon redraws as freight lands —
  // otherwise the row would show the keel forever while the map showed
  // it plating up.
  }, [body, size, tfF, cloudAlpha, animated, frame, mega]);

  // Placed AFTER every hook on purpose: an early return above them
  // changes the hook order between a structure row and a planet row,
  // which is the one thing React will not forgive. The canvas effect
  // still runs for a structure and simply finds no canvas to draw on.
  // A MEGASTRUCTURE IS AN SVG NOW, not canvas art.
  //
  // The map moved to the shared ship frame and this did not, so the
  // outliner went on drawing the old procedural hardware next to a map
  // showing the new silhouettes — the list and the map disagreeing
  // about what a thing looks like, which is the exact problem the
  // canvas branch below was originally added to fix.
  //
  // Rendered directly rather than through the raster cache: this is a
  // React tree, the icons ARE components, and going via an
  // HTMLImageElement would mean an async load and a blank first frame
  // for no benefit.
  const site = body.type === 'megastructure' ? pgs.megastructures?.[body.id] : undefined;
  if (body.type === 'megastructure') {
    // The owner's colours, matching the map. A structure drawn in
    // catalogue grey in the list and faction magenta on the map reads
    // as two different objects.
    const owner = body.ownedBy && body.ownedBy !== 'player'
      ? (pgs.factions ?? []).find(f => f.id === body.ownedBy)
      : (pgs.factions ?? []).find(f => f.id === 'player');
    const tint = owner?.color ?? MEGASTRUCTURES[site?.kind ?? 'warp_gate']?.color ?? '#9fb4c4';
    const trim = owner?.color2;
    if (site && site.status !== 'complete') {
      const stage = Math.min(3, Math.floor(progressOf(site) * 4));
      return (
        <StructureScaffold
          stage={stage} size={size} color={tint} color2={trim} className={className}
        />
      );
    }
    return (
      <StructureIcon
        kind={site?.kind ?? 'warp_gate'}
        variant={site?.variant ?? undefined}
        size={size}
        color={tint}
        color2={trim}
        className={className}
      />
    );
  }

  return (
    <canvas
      ref={ref}
      className={className}
      style={{ width: size, height: size, borderRadius: '50%', display: 'block', flexShrink: 0 }}
      aria-hidden
    />
  );
};
