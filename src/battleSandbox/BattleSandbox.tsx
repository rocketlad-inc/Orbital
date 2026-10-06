// ============================================================
// BattleSandbox — /?battle. Watch a fight laid out over a whole orbit.
//
// The test page for the cramped-fleet prototype (render/orbitBattleLayout).
// Everything except the LAYOUT is the map's own behaviour, ported rule
// for rule so the page shows what a live battle would look like:
//
//   ART      the real ship sprites and the designs players fly, capital
//            hulls from the structure sheet, fleet markers (flagship full
//            size, every other hull a small glyph in the escort block
//            behind it), drawShip's engine glow, the real globe textures.
//   ZOOM     a CAMERA on the battle (Lorne: "shrink and grow as you zoom,
//            keeping their formation relative to the planet"). The layout
//            is solved once, at full hull size around the world at its
//            normal size, and zoom scales the whole scene together: world,
//            places, hulls, escorts and fire. Nothing re-spreads, so a
//            formation that does not overlap never overlaps. Far out the
//            hulls fold into a count per side (bodyPresentation's reveal,
//            on the world's true size, as the map's badge).
//   FIRE     combatFx.drawEngagementFire: every engaged hull fires on its
//            own 3.15s cycle (bolt + reload), stretched once a world holds
//            more than six shooters; targets as the server stamps them
//            (top tier, held until dead, a fleet focusing on one hull);
//            a shot through the world's core re-aims at a hull in sight;
//            kinetic three-round bursts, energy charge-and-lance, the
//            same muzzles, rounds, scorches and hull hits, sized to the
//            hitboxes; the contested ring and battle debris under it.
//
// TRY-OUTS on top of the live rules (Lorne, 2026-10-06): a FIRE RATE
// multiplier over the map's cycle, SIZE CONTRAST ladders, and the world's
// STATION placed opposite the fight (it returns fire, as a settlement does).
//
// Compare with TODAY'S rules (the narrow-arc battle lines, approximated
// in orbitBattleLayout.layoutTodayLines): same roster, same world, same
// fire.
// ============================================================

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  layoutOrbitBattle, layoutTodayLines, CLEAR_FRAC, type OBLayout, type OBPlacement,
} from '../render/orbitBattleLayout';
import {
  buildScenario, hullCount, FACTIONS, SCENARIOS, SIZE_LADDERS,
  type ScenarioId, type SandboxShip, type ShipClass, type SizeLadderId,
} from './scenarios';
import { drawStationStructure } from '../render/isoStructures';
import { hullReveal, blendRadius, DISPLAY_FLOOR_PX } from '../render/bodyPresentation';
import { getShipIconImage } from '../render/shipIconCache';
import { getStructureIconImage } from '../render/structureIconCache';
import { drawTexturedDisk, drawSphereLighting } from '../render/fxPrimitives';
import {
  drawRound, drawBeam, drawMuzzle, drawHullHit, drawCharge, drawScorch, glowAt,
} from '../render/fxArt';
import { FX_TUNING } from '../render/fxTuning';
import { hashStr, mulberry32 } from '../render/planetTexture';
import { artUrl } from '../render/artVersion';
import type { ShipIconVariant } from '../components/ShipIcons';

type PlanetId = 'luna' | 'mars' | 'jupiter';
const PLANETS: Record<PlanetId, {
  label: string; r: number; tex: string; halo: string; floor: keyof typeof DISPLAY_FLOOR_PX;
}> = {
  luna:    { label: 'Luna (small)',  r: 70,  tex: artUrl('/globes/luna.webp'),    halo: 'rgba(200,210,225,0.35)', floor: 'moon' },
  mars:    { label: 'Mars',          r: 150, tex: artUrl('/globes/mars_tf.webp'), halo: 'rgba(120,200,255,0.45)', floor: 'planet' },
  jupiter: { label: 'Jupiter (big)', r: 260, tex: artUrl('/globes/jupiter.webp'), halo: 'rgba(255,214,170,0.35)', floor: 'giant' },
};

/** One full turn of the whole battle around the world, like the map's
 *  slow battle-line wheel. */
const TURN_MS = 240000;
/** The world's TRUE radius on screen, px, at the closest and farthest
 *  zoom. Below 10px the map folds parked hulls into a count badge, so the
 *  page goes a little past that to show it happen. */
const MIN_TRUE_PX = 6;
const MAX_TRUE_PX = 640;
/** One wheel notch, as on the map. */
const WHEEL_STEP = 1.15;
/** How fast a hull glides to a new place (a reroll, a new world), ms. */
const GLIDE_MS = 260;

// combatFx's fire constants, from the same tuning table.
const BOLT_MS = FX_TUNING.boltMs;
const SLOT_MS = FX_TUNING.boltMs + FX_TUNING.beatMs;
const FIRE_REFERENCE = FX_TUNING.fireReference;
const MAX_FIRING_PER_FRAME = 64;
const MUZZLE_MS = FX_TUNING.muzzleMs;
const IMPACT_MS = FX_TUNING.impactMs;
const ROUND_GAP_MS = FX_TUNING.roundGapMs;
const CHARGE_MS = FX_TUNING.chargeMs;
/** Shots through the middle of a world are blocked; the limb is fair. */
const OCCLUSION_CORE = 0.55;
/** mapRenderer SHIP_MIN_HIT_RADIUS; an escort has no hitbox and FX reads 14. */
const MIN_HIT_R = 12;
const ESCORT_HIT_R = 14;
/** combatFx reads a settlement shooter's radius as 16. */
const STATION_HIT_R = 16;
/** The station's art spans this many local units (settlementArt VIEW x 2). */
const STATION_ART_UNITS = 88;
const STATION_ID = 'station';
/** Fire-rate multipliers to try over the map's cycle (1 = live, which is
 *  itself 3x what it was: fxTuning.fireReference 18). */
const FIRE_RATES = [1, 3, 10];
/** A hull cannot fire faster than its shot can fly and land. */
const MIN_SLOT_MS = FX_TUNING.boltMs + FX_TUNING.impactMs;

/** One hull on screen: a lone ship, a fleet's flagship, or an escort. */
interface Hull {
  id: string;
  unit: string;
  faction: string;
  cls: ShipClass;
  variant?: ShipIconVariant;
  armed: boolean;
  size: number;
  escort: boolean;
  /** Offset from its unit's body centre in the unit's frame (forward +x). */
  lx: number;
  ly: number;
}

const factionById = new Map(FACTIONS.map(f => [f.id, f]));

const hashCache = new Map<string, number>();
function idHash(id: string): number {
  let h = hashCache.get(id);
  if (h === undefined) { h = hashStr(id); hashCache.set(id, h); }
  return h;
}

function useImage(src: string): HTMLImageElement | null {
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  useEffect(() => {
    const i = new Image();
    i.onload = () => setImg(i);
    i.src = src;
  }, [src]);
  return img;
}

const ui: Record<string, React.CSSProperties> = {
  panel: {
    position: 'absolute', top: 12, left: 12, width: 300, padding: '12px 14px',
    background: 'rgba(8, 13, 22, 0.86)', border: '1px solid rgba(120, 160, 200, 0.25)',
    borderRadius: 10, color: '#d6e2ec', font: '12px "Chakra Petch", system-ui, sans-serif',
    display: 'flex', flexDirection: 'column', gap: 9, backdropFilter: 'blur(4px)',
  },
  h: { font: '15px "Audiowide", system-ui, sans-serif', color: '#ffc24a', letterSpacing: '.04em' },
  label: { fontSize: 10, letterSpacing: '.12em', color: '#7f93a8', textTransform: 'uppercase' },
  row: { display: 'flex', gap: 5, flexWrap: 'wrap' },
  dim: { color: '#8a9fb3', fontSize: 11, lineHeight: 1.45 },
  stat: { display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '2px 10px', fontSize: 11 },
};
const chip = (on: boolean): React.CSSProperties => ({
  cursor: 'pointer', font: 'inherit', fontSize: 12, padding: '4px 9px', borderRadius: 5,
  color: on ? '#0a0f16' : '#d6e2ec', background: on ? '#4ecdc4' : 'rgba(255,255,255,0.04)',
  border: `1px solid ${on ? '#4ecdc4' : 'rgba(120,160,200,0.3)'}`,
});

export default function BattleSandbox({ onExit }: { onExit?: () => void }) {
  const [scenario, setScenario] = useState<ScenarioId>('large');
  const [planet, setPlanet] = useState<PlanetId>('mars');
  const [mode, setMode] = useState<'new' | 'today'>('new');
  const [zoom, setZoom] = useState(1);
  const [seed, setSeed] = useState(1);
  const [showShares, setShowShares] = useState(false);
  const [fireRate, setFireRate] = useState(1);
  const [ladder, setLadder] = useState<SizeLadderId>('live');
  const [stats, setStats] = useState({ firing: 0, rerouted: 0 });

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pan = useRef({ x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number; px: number; py: number } | null>(null);
  const tex = useImage(PLANETS[planet].tex);

  // THE REFERENCE: the world at its normal size, hulls at full size. The
  // layout is solved here once; zoom is a camera scale over it.
  const baseR = PLANETS[planet].r;
  // The world's TRUE radius on screen at this zoom, and the disc drawn for
  // it (a smooth max with the display floor, so a far world never vanishes).
  const trueR = baseR * zoom;
  const planetR = blendRadius(trueR, DISPLAY_FLOOR_PX[PLANETS[planet].floor]);
  // Far out, hulls fold into the count badge on the world's true size.
  const reveal = hullReveal({ type: 'terrestrial', radius: trueR }, 1);
  const px = SIZE_LADDERS[ladder].px;
  const ships: SandboxShip[] = useMemo(
    () => buildScenario(scenario, seed, 1, px), [scenario, seed, px],
  );
  // The world's station belongs to the first side (the defender).
  const stationOwner = FACTIONS[0].id;
  const { layout, solveMs } = useMemo(() => {
    const order = FACTIONS.map(f => f.id).filter(id => ships.some(s => s.faction === id));
    const station = { id: STATION_ID, clearR: px.station * CLEAR_FRAC };
    const t0 = performance.now();
    const L: OBLayout = mode === 'new'
      ? layoutOrbitBattle(ships, baseR, { seed, factionOrder: order, station })
      : layoutTodayLines(ships, baseR, { seed, factionOrder: order });
    if (!L.station) {
      // Today's lines sit in one sector centred on 0: the far side is pi.
      const r = baseR + station.clearR + 4;
      L.station = { id: STATION_ID, x: -r, y: 0, heading: -Math.PI / 2, r, theta: Math.PI };
    }
    return { layout: L, solveMs: performance.now() - t0 };
  }, [ships, baseR, mode, seed, px]);
  // Every hull drawn, escorts included, with its place in its unit.
  const hulls: Hull[] = useMemo(() => {
    const out: Hull[] = [];
    for (const s of ships) {
      if (s.geo) {
        out.push({ id: s.id, unit: s.id, faction: s.faction, cls: s.cls, variant: s.variant, armed: true,
          size: s.geo.flagSize, escort: false, lx: s.geo.flagX, ly: 0 });
        for (const e of s.geo.escorts) {
          out.push({ id: e.id, unit: s.id, faction: s.faction, cls: e.cls, variant: e.variant,
            armed: e.cls !== 'freighter', size: e.size, escort: true, lx: e.x, ly: e.y });
        }
      } else {
        out.push({ id: s.id, unit: s.id, faction: s.faction, cls: s.cls, variant: s.variant, armed: s.armed,
          size: s.size, escort: false, lx: 0, ly: 0 });
      }
    }
    return out;
  }, [ships]);
  // WHO SHOOTS WHOM, as the server stamps it (room.js pickTarget): the
  // top tier (armed hostiles, else civilians), sorted by id, a random
  // start rolled on the FLEET's id for fleet hulls (so a fleet focuses on
  // one target) and on the hull's own id otherwise, held until it dies.
  // Nothing dies here, so a stamp holds for the whole fight.
  const stamps = useMemo(() => {
    const out = new Map<string, string>();
    const byId = [...hulls].sort((a, b) => (a.id < b.id ? -1 : 1));
    for (const h of hulls) {
      if (!h.armed) continue;
      const hostile = byId.filter(o => o.faction !== h.faction);
      const armed = hostile.filter(o => o.armed);
      const tier = armed.length ? armed : hostile;
      if (!tier.length) continue;
      const fleetKey = ships.find(s => s.id === h.unit)?.geo ? h.unit : h.id;
      const r = mulberry32(idHash(`${fleetKey}:tgt`) ^ seed)();
      out.set(h.id, tier[Math.min(tier.length - 1, Math.floor(r * tier.length))].id);
    }
    return out;
  }, [hulls, ships, seed]);

  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  // Zoom about a screen point (the cursor), so you zoom INTO the part of
  // the battle you are looking at: the point under it stays put.
  const zoomBy = (f: number, at?: { x: number; y: number }) => {
    const z0 = zoomRef.current;
    const z1 = Math.max(MIN_TRUE_PX / baseR, Math.min(MAX_TRUE_PX / baseR, z0 * f));
    const cv = canvasRef.current;
    if (at && cv) {
      const W = cv.clientWidth, H = cv.clientHeight;
      const panel = W > 980 ? 330 : 0;
      const ox = panel + (W - panel) / 2, oy = H / 2;
      const k = z1 / z0;
      const cx = ox + pan.current.x, cy = oy + pan.current.y;
      pan.current = { x: at.x - (at.x - cx) * k - ox, y: at.y - (at.y - cy) * k - oy };
    }
    zoomRef.current = z1;
    setZoom(z1);
  };
  // Switching worlds keeps the zoom inside that world's range.
  useEffect(() => { zoomBy(1); }, [baseR]); // eslint-disable-line react-hooks/exhaustive-deps

  // Everything the animation loop reads, without re-subscribing it.
  const live = useRef({
    ships, hulls, stamps, layout, planetR, trueR, reveal, zoom, tex, showShares, planet,
    fireRate, stationPx: px.station, stationOwner,
  });
  live.current = {
    ships, hulls, stamps, layout, planetR, trueR, reveal, zoom, tex, showShares, planet,
    fireRate, stationPx: px.station, stationOwner,
  };

  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return undefined;
    const g = cv.getContext('2d');
    if (!g) return undefined;
    let raf = 0;
    let last = performance.now();
    // Where each unit is DRAWN (polar, before the wheel), chasing its
    // solved place so a re-solve glides instead of jumping.
    const drawn = new Map<string, { r: number; t: number }>();
    let firingSum = 0, rerouteSum = 0, frames = 0, lastStat = 0;

    // A fixed field of stars.
    const stars = Array.from({ length: 260 }, (_, i) => ({
      x: ((i * 7919) % 1000) / 1000, y: ((i * 104729) % 997) / 997, a: 0.25 + ((i * 31) % 70) / 100,
    }));

    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      cv.width = Math.round(cv.clientWidth * dpr);
      cv.height = Math.round(cv.clientHeight * dpr);
    };
    resize();
    window.addEventListener('resize', resize);

    const frame = (now: number) => {
      const {
        ships: S, hulls: HL, stamps: ST, layout: L, planetR: R, trueR: TR, reveal: RV,
        zoom: Z, tex: T, showShares: SH, planet: P,
        fireRate: FR, stationPx: SPX, stationOwner: SO,
      } = live.current;
      const dt = Math.min(100, now - last);
      last = now;
      const W = cv.clientWidth, H = cv.clientHeight;
      const dpr = window.devicePixelRatio || 1;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      // The panel takes the left 330px when there is room.
      const panel = W > 980 ? 330 : 0;
      const cx = panel + (W - panel) / 2 + pan.current.x;
      const cy = H / 2 + pan.current.y;
      const rot = ((now % TURN_MS) / TURN_MS) * Math.PI * 2;
      const omega = (Math.PI * 2) / TURN_MS;

      // Each unit's drawn place glides toward its solved one.
      const k = 1 - Math.exp(-dt / GLIDE_MS);
      const unitPos = new Map<string, { x: number; y: number; h: number }>();
      for (const s of S) {
        const p = L.placements.get(s.id);
        if (!p) continue;
        let d = drawn.get(s.id);
        if (!d) { d = { r: p.r, t: p.theta }; drawn.set(s.id, d); }
        let dth = (p.theta - d.t) % (Math.PI * 2);
        if (dth > Math.PI) dth -= Math.PI * 2;
        if (dth < -Math.PI) dth += Math.PI * 2;
        d.t += dth * k;
        d.r += (p.r - d.r) * k;
        // A small bob of its own so the cluster breathes.
        const ph = (s.id.length * 13 + s.id.charCodeAt(s.id.length - 1) * 7) % 100;
        const r = (d.r + Math.sin(now / 1700 + ph) * 1.6) * Z;
        const t = d.t + rot + Math.sin(now / 2300 + ph * 1.3) * 0.004;
        // Nose: forward along the orbit, keeping the solved jitter.
        const jitter = p.heading - (Math.atan2(p.y, p.x) + Math.PI / 2);
        unitPos.set(s.id, { x: cx + Math.cos(t) * r, y: cy + Math.sin(t) * r, h: t + Math.PI / 2 + jitter });
      }
      // The station rides the same wheel, gliding to a new place too.
      let stationPos: { x: number; y: number } | null = null;
      const stP: OBPlacement | undefined = L.station;
      if (stP) {
        let d = drawn.get(STATION_ID);
        if (!d) { d = { r: stP.r, t: stP.theta }; drawn.set(STATION_ID, d); }
        let dth = (stP.theta - d.t) % (Math.PI * 2);
        if (dth > Math.PI) dth -= Math.PI * 2;
        if (dth < -Math.PI) dth += Math.PI * 2;
        d.t += dth * k;
        d.r += (stP.r - d.r) * k;
        const t = d.t + rot;
        stationPos = { x: cx + Math.cos(t) * d.r * Z, y: cy + Math.sin(t) * d.r * Z };
      }
      if (drawn.size > S.length * 2 + 1) {
        const keep = new Set([...S.map(s => s.id), STATION_ID]);
        for (const id of [...drawn.keys()]) if (!keep.has(id)) drawn.delete(id);
      }
      // And every hull from its unit: escorts ride in the fleet's frame.
      const pos = new Map<string, { x: number; y: number; h: number }>();
      for (const h of HL) {
        const u = unitPos.get(h.unit);
        if (!u) continue;
        const c = Math.cos(u.h), sn = Math.sin(u.h);
        const lx = h.lx * Z, ly = h.ly * Z;
        pos.set(h.id, { x: u.x + lx * c - ly * sn, y: u.y + lx * sn + ly * c, h: u.h });
      }

      // Background.
      g.fillStyle = '#060a11';
      g.fillRect(0, 0, W, H);
      for (const st of stars) {
        g.fillStyle = `rgba(220,230,255,${st.a * 0.6})`;
        g.fillRect(st.x * W, st.y * H, 1.3, 1.3);
      }

      // The world.
      const halo = g.createRadialGradient(cx, cy, R * 0.9, cx, cy, R * 1.12);
      halo.addColorStop(0, 'rgba(0,0,0,0)');
      halo.addColorStop(0.5, PLANETS[P].halo);
      halo.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = halo;
      g.beginPath(); g.arc(cx, cy, R * 1.12, 0, Math.PI * 2); g.fill();
      if (T) {
        // A pre-rendered sphere, drawn still (as the map's Still-worlds does).
        drawTexturedDisk(g, T, cx, cy, R, 0);
        drawSphereLighting(g, cx, cy, R, 0.75, 0.66);
      } else {
        g.fillStyle = '#3a2a22';
        g.beginPath(); g.arc(cx, cy, R, 0, Math.PI * 2); g.fill();
      }

      // Each faction's share of the orbit, when asked.
      if (SH && RV > 0) {
        for (const sec of L.sectors) {
          const f = factionById.get(sec.faction);
          g.strokeStyle = f?.color ?? '#fff';
          g.globalAlpha = 0.3 * RV;
          g.lineWidth = (L.band.rOut - L.band.rIn) * Z;
          g.beginPath();
          g.arc(cx, cy, ((L.band.rIn + L.band.rOut) / 2) * Z, sec.start + rot, sec.end + rot);
          g.stroke();
          g.globalAlpha = 1;
        }
      }

      // CONTESTED (combatFx.drawContestedBodies): the slow red dashed
      // ring and a few motes of battle debris, on the world's true size.
      {
        const pr = Math.max(4, TR);
        const ringR = pr + Math.max(14, pr * 0.9);
        const pulse = 0.5 + 0.5 * Math.sin(now / 700);
        g.save();
        g.strokeStyle = `rgba(255, 80, 80, ${(0.1 + 0.14 * pulse).toFixed(3)})`;
        g.lineWidth = 1.5;
        g.setLineDash([8, 6]);
        g.lineDashOffset = -(now * 0.006) % 14;
        g.beginPath(); g.arc(cx, cy, ringR, 0, Math.PI * 2); g.stroke();
        g.setLineDash([]);
        const rr = mulberry32(idHash(P));
        g.fillStyle = 'rgba(200, 190, 170, 0.22)';
        for (let m = 0; m < 8; m++) {
          const baseA = rr() * Math.PI * 2;
          const rad = pr * (1.15 + rr() * 1.1);
          const a = baseA + (now / 60000) * (0.4 + rr() * 0.6);
          g.beginPath();
          g.arc(cx + Math.cos(a) * rad, cy + Math.sin(a) * rad, 0.8 + rr() * 0.8, 0, Math.PI * 2);
          g.fill();
        }
        g.restore();
      }

      // THE STATION (drawStationStructure, the map's art), upright like the
      // map's, at the ladder's size and the camera's zoom.
      if (stationPos && RV > 0) {
        const f = factionById.get(SO)!;
        g.save();
        g.globalAlpha = RV;
        g.translate(stationPos.x, stationPos.y);
        const sc = (SPX / STATION_ART_UNITS) * Z;
        g.scale(sc, sc);
        drawStationStructure(g, {
          weaponsLevel: 3, shipyardLevel: 1, labLevel: 1, thrustersLevel: 0,
          factionColor: f.color, factionColor2: f.color2, builds: [], nowMs: now,
        });
        g.restore();
      }

      // Hulls, as drawShip draws them: the design the player picked, and
      // the soft engine glow astern of every full-size hull (escorts are
      // drawEscortHull's: no glow). Faded with the world's hull reveal.
      if (RV > 0) {
        g.save();
        g.globalAlpha = RV;
        for (const s of HL) {
          const p = pos.get(s.id);
          if (!p) continue;
          const f = factionById.get(s.faction)!;
          const img = s.cls === 'mega_destroyer'
            ? getStructureIconImage('mega_destroyer', f.color, null, f.color2)
            : getShipIconImage(s.cls, f.color, s.variant, f.color2);
          const size = s.size * Z;
          if (!s.escort && s.cls !== 'mega_destroyer') {
            const ph = (((s.id.charCodeAt(s.id.length - 1) * 37) % 1000) / 1000) * Math.PI * 2;
            const pulse = 0.6 + 0.4 * Math.sin(now / 420 + ph);
            g.save();
            g.globalCompositeOperation = 'lighter';
            glowAt(g, p.x - Math.cos(p.h) * size * 0.46, p.y - Math.sin(p.h) * size * 0.46,
              Math.max(1, size * 0.2) * 1.15, '#fff3dc', '#ff9a4a', 0.6 * pulse);
            g.restore();
          }
          g.save();
          g.translate(p.x, p.y);
          g.rotate(p.h);
          if (img) g.drawImage(img, -size / 2, -size / 2, size, size);
          else { g.fillStyle = f.color; g.beginPath(); g.arc(0, 0, size * 0.2, 0, Math.PI * 2); g.fill(); }
          g.restore();
        }
        g.restore();
      }
      // Far out, the hulls fold into a count per side, as the map's
      // garrison badge does.
      if (RV < 1) {
        const counts = new Map<string, number>();
        for (const h of HL) counts.set(h.faction, (counts.get(h.faction) ?? 0) + 1);
        g.save();
        g.globalAlpha = 1 - RV;
        g.font = '600 11px "Chakra Petch", system-ui, sans-serif';
        g.textBaseline = 'middle';
        let bx = cx + R + 8;
        for (const [fid, n] of counts) {
          const f = factionById.get(fid);
          const label = `${n}`;
          const w = g.measureText(label).width + 16;
          g.fillStyle = 'rgba(8,13,22,0.85)';
          g.fillRect(bx, cy - R - 16, w, 16);
          g.fillStyle = f?.color ?? '#fff';
          g.fillRect(bx + 4, cy - R - 11, 6, 6);
          g.fillStyle = '#d6e2ec';
          g.fillText(label, bx + 13, cy - R - 8);
          bx += w + 4;
        }
        g.restore();
      }

      // FIRE (combatFx.drawEngagementFire). Every armed hull is engaged;
      // each fires continuously on its own cycle, phase-offset by its id,
      // and a crowded world stretches every cycle so the screen holds
      // about FIRE_REFERENCE hulls mid-volley.
      // The station joins the shooters (a settlement returns fire: kinetic,
      // only ever at armed hulls). Ships never bombard it while a hostile
      // hull is left, as on the server.
      const stationHull: Hull | null = stationPos ? {
        id: STATION_ID, unit: STATION_ID, faction: SO, cls: 'destroyer', armed: true,
        size: SPX, escort: false, lx: 0, ly: 0,
      } : null;
      const engaged = RV > 0.01
        ? [...HL.filter(h => h.armed), ...(stationHull ? [stationHull] : [])] : [];
      // TRY-OUT: the map's cycle divided by the fire-rate multiplier, never
      // faster than a shot can fly and land.
      const slotMs = Math.max(MIN_SLOT_MS,
        (SLOT_MS * Math.max(1, engaged.length / FIRE_REFERENCE)) / FR);
      const maxFiring = Math.min(400, MAX_FIRING_PER_FRAME * FR);
      const hullById = new Map(HL.map(h => [h.id, h]));
      // Hit radii as the map computes them at full size, then the camera.
      const hitR = (h: Hull) => (h.id === STATION_ID ? STATION_HIT_R
        : h.escort ? ESCORT_HIT_R : Math.max(h.size / 2 + 3, MIN_HIT_R)) * Z;
      const coreR = Math.max(3, TR) * OCCLUSION_CORE;
      const occluded = (a: { x: number; y: number }, b: { x: number; y: number }) => {
        const dx = b.x - a.x, dy = b.y - a.y;
        const len2 = dx * dx + dy * dy;
        if (len2 < 1e-6) return false;
        let t = ((cx - a.x) * dx + (cy - a.y) * dy) / len2;
        t = Math.max(0, Math.min(1, t));
        const px = a.x + dx * t - cx, py = a.y + dy * t - cy;
        return px * px + py * py < coreR * coreR;
      };
      let firingSeen = 0, rerouted = 0;
      g.save();
      g.globalCompositeOperation = 'lighter';
      for (const sh of engaged) {
        const within = (now + (idHash(sh.id) % slotMs)) % slotMs;
        const firing = within < BOLT_MS;
        const impacting = !firing && within < BOLT_MS + IMPACT_MS;
        if (!firing && !impacting) continue;
        if (++firingSeen > maxFiring) break;
        const isStation = sh.id === STATION_ID;
        const fp = isStation ? stationPos ?? undefined : pos.get(sh.id);
        let tgt: Hull | undefined;
        if (isStation) {
          // combatFx's fallback for a settlement: the armed hostile with
          // the best seeded score against this shooter.
          let best = -1;
          const sHash = idHash(sh.id);
          for (const o of HL) {
            if (o.faction === sh.faction || !o.armed) continue;
            const sc = (sHash ^ idHash(o.id)) >>> 0;
            if (sc > best) { best = sc; tgt = o; }
          }
        } else {
          tgt = hullById.get(ST.get(sh.id) ?? '');
        }
        let tp = tgt ? pos.get(tgt.id) : undefined;
        if (!fp || !tgt || !tp) continue;
        if (fp.x < -100 || fp.y < -100 || fp.x > W + 100 || fp.y > H + 100) continue;
        // Never through the world: re-aim at the first hostile in sight,
        // armed first.
        if (occluded(fp, tp)) {
          let alt: Hull | null = null;
          let altP: { x: number; y: number; h: number } | undefined;
          for (const o of HL) {
            if (o.faction === sh.faction) continue;
            if (isStation && !o.armed) continue;
            if (alt && alt.armed && !o.armed) continue;
            const op = pos.get(o.id);
            if (!op || occluded(fp, op)) continue;
            alt = o; altP = op;
            if (o.armed) break;
          }
          if (!alt || !altP) continue;
          tgt = alt; tp = altP;
          rerouted++;
        }
        const energyShot = !isStation && factionById.get(sh.faction)?.weapon === 'energy';
        const sR = hitR(sh);
        const tR = hitR(tgt);
        const volleyIdx = Math.floor((now + (idHash(sh.id) % slotMs)) / slotMs);
        const seedBase = (idHash(sh.id) ^ Math.imul(volleyIdx, 0x9e3779b1)) >>> 0;
        const hitAng = Math.atan2(fp.y - tp.y, fp.x - tp.x);
        const faceX = tp.x + Math.cos(hitAng) * tR * 0.3;
        const faceY = tp.y + Math.sin(hitAng) * tR * 0.3;
        if (firing && energyShot) {
          const ang = Math.atan2(tp.y - fp.y, tp.x - fp.x);
          const mx = fp.x + Math.cos(ang) * sR * 0.45;
          const my = fp.y + Math.sin(ang) * sR * 0.45;
          const bw = Math.max(1.5, Math.min(3.4, sR * 0.11));
          if (within < CHARGE_MS) {
            drawCharge(g, mx, my, bw * 2.4, within / CHARGE_MS, now, seedBase);
          } else {
            const bk = (within - CHARGE_MS) / (BOLT_MS - CHARGE_MS);
            const beamA = bk < 0.12 ? bk / 0.12 : bk > 0.75 ? 1 - (bk - 0.75) / 0.25 : 1;
            drawBeam(g, mx, my, faceX, faceY, bw, beamA, now, seedBase);
            drawScorch(g, faceX, faceY, tR * 0.35, Math.min(0.9, bk * 0.5), hitAng, seedBase ^ 0x51);
          }
        } else if (firing) {
          const ang0 = Math.atan2(tp.y - fp.y, tp.x - fp.x);
          const mx = fp.x + Math.cos(ang0) * sR * 0.45;
          const my = fp.y + Math.sin(ang0) * sR * 0.45;
          const rw = Math.max(1.1, Math.min(2.4, sR * 0.075));
          const flight = BOLT_MS - 2 * ROUND_GAP_MS;
          for (let r = 0; r < 3; r++) {
            const w2 = within - r * ROUND_GAP_MS;
            if (w2 < 0) continue;
            const kk = w2 / flight;
            if (w2 < MUZZLE_MS) drawMuzzle(g, mx, my, ang0, sR * 0.6, 1 - w2 / MUZZLE_MS);
            if (kk >= 1) {
              const lk = (kk - 1) / 0.35;
              if (lk < 1) drawHullHit(g, faceX, faceY, hitAng, tR * 0.28, lk, seedBase + r);
              continue;
            }
            // Lead the target along its orbit for the rest of the flight.
            const lead = flight * (1 - kk) * omega;
            const ta = Math.atan2(tp.y - cy, tp.x - cx), trr = Math.hypot(tp.x - cx, tp.y - cy);
            const tx = faceX - Math.sin(ta) * trr * lead, ty = faceY + Math.cos(ta) * trr * lead;
            const hx = mx + (tx - mx) * kk, hy = my + (ty - my) * kk;
            const dist = Math.hypot(tx - mx, ty - my);
            const len = Math.min(dist * kk, Math.max(10, Math.min(30, dist * 0.14)) * Math.max(0.7, rw / 1.6));
            const ux = (tx - mx) / (dist || 1), uy = (ty - my) / (dist || 1);
            drawRound(g, hx - ux * len, hy - uy * len, hx, hy, rw, 1);
          }
        } else if (energyShot) {
          const ik = (within - BOLT_MS) / IMPACT_MS;
          drawScorch(g, faceX, faceY, tR * 0.42, 0.45 + ik * 0.55, hitAng, seedBase ^ 0x51);
        } else {
          const ik = (within - BOLT_MS) / IMPACT_MS;
          drawHullHit(g, faceX, faceY, hitAng, tR * 0.5, ik, seedBase);
        }
      }
      g.restore();

      firingSum += Math.min(firingSeen, maxFiring);
      rerouteSum += rerouted;
      frames++;
      if (now - lastStat > 1000) {
        lastStat = now;
        setStats({ firing: Math.round(firingSum / Math.max(1, frames)), rerouted: Math.round(rerouteSum / Math.max(1, frames)) });
        firingSum = 0; rerouteSum = 0; frames = 0;
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => { cancelAnimationFrame(raf); window.removeEventListener('resize', resize); };
  }, []);

  const factionCounts = FACTIONS
    .map(f => {
      const mine = ships.filter(s => s.faction === f.id);
      return { f, n: hullCount(mine), fleets: mine.filter(s => s.geo).length };
    })
    .filter(x => x.n > 0);
  const armedCount = hulls.filter(h => h.armed).length + 1;
  const cycleS = Math.max(MIN_SLOT_MS,
    (SLOT_MS * Math.max(1, armedCount / FIRE_REFERENCE)) / fireRate) / 1000;
  const sizeLine = `Corvette ${px.corvette} · Frigate ${px.frigate} · Destroyer ${px.destroyer}`
    + ` · Capital ${px.mega_destroyer} · Station ${Math.round(px.station)}`;

  return (
    <div
      style={{ position: 'fixed', inset: 0, background: '#060a11', touchAction: 'none' }}
      onWheel={e => zoomBy(e.deltaY > 0 ? 1 / WHEEL_STEP : WHEEL_STEP, { x: e.clientX, y: e.clientY })}
    >
      <canvas
        ref={canvasRef}
        style={{ width: '100%', height: '100%', display: 'block', cursor: 'grab' }}
        data-testid="battle-canvas"
        onPointerDown={e => {
          drag.current = { x: e.clientX, y: e.clientY, px: pan.current.x, py: pan.current.y };
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
        }}
        onPointerMove={e => {
          const d = drag.current;
          if (!d) return;
          pan.current = { x: d.px + e.clientX - d.x, y: d.py + e.clientY - d.y };
        }}
        onPointerUp={() => { drag.current = null; }}
        onPointerCancel={() => { drag.current = null; }}
      />
      <div style={ui.panel}>
        <div style={ui.h}>Orbital battle layout</div>
        <div style={ui.dim}>
          A prototype of a new battle layout. Scroll to zoom into the fight (the formation holds and the
          ships grow and shrink with the world), drag to pan.
        </div>

        <div style={ui.label}>Battle</div>
        <div style={ui.row}>
          {(Object.keys(SCENARIOS) as ScenarioId[]).map(id => (
            <button key={id} type="button" style={chip(scenario === id)} onClick={() => setScenario(id)}
              title={SCENARIOS[id].blurb}>{SCENARIOS[id].label}</button>
          ))}
        </div>
        <div style={ui.dim}>{SCENARIOS[scenario].blurb}</div>

        <div style={ui.label}>World</div>
        <div style={ui.row}>
          {(Object.keys(PLANETS) as PlanetId[]).map(id => (
            <button key={id} type="button" style={chip(planet === id)} onClick={() => setPlanet(id)}>
              {PLANETS[id].label}
            </button>
          ))}
        </div>

        <div style={ui.label}>Layout</div>
        <div style={ui.row}>
          <button type="button" style={chip(mode === 'new')} onClick={() => setMode('new')}>New: whole orbit</button>
          <button type="button" style={chip(mode === 'today')} onClick={() => setMode('today')}>Today</button>
        </div>
        <div style={ui.label}>Fire rate</div>
        <div style={ui.row}>
          {FIRE_RATES.map(r => (
            <button key={r} type="button" style={chip(fireRate === r)} onClick={() => setFireRate(r)}>
              {r === 1 ? '1× (live)' : `${r}×`}
            </button>
          ))}
        </div>

        <div style={ui.label}>Size contrast</div>
        <div style={ui.row}>
          {(Object.keys(SIZE_LADDERS) as SizeLadderId[]).map(id => (
            <button key={id} type="button" style={chip(ladder === id)} onClick={() => setLadder(id)}>
              {SIZE_LADDERS[id].label}
            </button>
          ))}
        </div>
        <div style={ui.dim} data-testid="battle-sizes">{sizeLine} px</div>

        <div style={ui.row}>
          <button type="button" style={chip(false)} onClick={() => setSeed(s => s + 1)}>Reroll fleets</button>
          <button type="button" style={chip(showShares)} onClick={() => setShowShares(v => !v)}>Show shares</button>
          <button type="button" style={chip(false)} onClick={() => { setZoom(1); pan.current = { x: 0, y: 0 }; }}>
            Reset view
          </button>
          {onExit && <button type="button" style={chip(false)} onClick={onExit}>Exit</button>}
        </div>

        <div style={ui.stat} data-testid="battle-stats">
          {factionCounts.map(({ f, n, fleets }) => (
            <React.Fragment key={f.id}>
              <span style={{ color: f.color }}>■ {f.name}</span>
              <span>{n} hulls{fleets > 0 && ` · ${fleets} fleet${fleets > 1 ? 's' : ''}`}</span>
            </React.Fragment>
          ))}
          <span style={{ color: '#7f93a8' }}>Spread</span>
          <span>{mode === 'new' ? layout.mode : 'battle lines (86° sector)'}</span>
          <span style={{ color: '#7f93a8' }}>Overlapping pairs</span>
          <span style={{ color: layout.overlaps ? '#ff8a8a' : '#6ee7b7' }} data-testid="battle-overlaps">{layout.overlaps}</span>
          <span style={{ color: '#7f93a8' }}>Fire</span>
          <span data-testid="battle-fire">
            {armedCount} armed · one volley each per {cycleS.toFixed(1)}s · {stats.firing} mid-volley
            {stats.rerouted > 0 && ` · ${stats.rerouted} re-aimed past the world`}
          </span>
          <span style={{ color: '#7f93a8' }}>World on screen</span>
          <span data-testid="battle-zoom">
            {Math.round(trueR)}px radius · zoom {zoom.toFixed(2)}×{reveal <= 0 ? ' · hulls folded into the count' : ''}
          </span>
          <span style={{ color: '#7f93a8' }}>Re-solve</span>
          <span data-testid="battle-solve">{solveMs.toFixed(1)} ms</span>
        </div>
        {mode === 'today' && (
          <div style={ui.dim}>
            Today&apos;s rules, approximated: every side in a narrow arc, up to four ranks, then hulls overlap.
          </div>
        )}
      </div>
    </div>
  );
}
