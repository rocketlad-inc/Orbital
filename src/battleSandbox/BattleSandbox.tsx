// ============================================================
// BattleSandbox — /?battle. Watch a fight laid out over a whole orbit.
//
// The test page for the cramped-fleet prototype (render/orbitBattleLayout).
// Drawn with the game's own pieces: the real ship sprites and capital
// hulls (shipIconCache / structureIconCache), the real globe textures and
// lighting (fxPrimitives), the real weapon art (fxArt: rounds, beams,
// muzzle flashes, hull hits), and the map's own fleet markers (flagship
// full size, every other hull a small glyph in the escort block behind
// it). Only the LAYOUT is new.
//
// ZOOM IS THE POINT. Sprites hold their pixel size while the world
// shrinks under them (the map's parked-hull rule: full size until the
// world is 34px across its radius, easing to half at 10px), so pulling
// back is exactly when hulls pile up. The layout re-solves at every zoom
// step and each hull GLIDES to its new place rather than jumping.
//
// Compare with TODAY'S rules (the narrow-arc battle lines, approximated
// in orbitBattleLayout.layoutTodayLines): same roster, same planet,
// shots that would cross the planet suppressed, as the map does now.
// ============================================================

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  layoutOrbitBattle, layoutTodayLines, crossesPlanet, type OBLayout,
} from '../render/orbitBattleLayout';
import {
  buildScenario, hullCount, FACTIONS, SCENARIOS, type ScenarioId, type SandboxShip, type ShipClass,
} from './scenarios';
import { hullSize } from '../render/bodyPresentation';
import { getShipIconImage } from '../render/shipIconCache';
import { getStructureIconImage } from '../render/structureIconCache';
import { drawTexturedDisk, drawSphereLighting } from '../render/fxPrimitives';
import {
  drawRound, drawBeam, drawMuzzle, drawHullHit, drawSparks, glowAt, KINETIC_FX, ENERGY_FX,
} from '../render/fxArt';
import type { ShipIconVariant } from '../components/ShipIcons';
import { artUrl } from '../render/artVersion';

type PlanetId = 'luna' | 'mars' | 'jupiter';
const PLANETS: Record<PlanetId, { label: string; r: number; tex: string; halo: string }> = {
  luna:    { label: 'Luna (small)',  r: 70,  tex: artUrl('/globes/luna.webp'),    halo: 'rgba(200,210,225,0.35)' },
  mars:    { label: 'Mars',          r: 150, tex: artUrl('/globes/mars_tf.webp'), halo: 'rgba(120,200,255,0.45)' },
  jupiter: { label: 'Jupiter (big)', r: 260, tex: artUrl('/globes/jupiter.webp'), halo: 'rgba(255,214,170,0.35)' },
};

/** One full turn of the whole battle around the world, like the map's
 *  slow battle-line wheel. */
const TURN_MS = 240000;
/** Drawn world radius, px, at the closest and farthest zoom. Below ~18px
 *  the map folds hulls into a garrison badge, so the page stops there. */
const MIN_PLANET_PX = 18;
const MAX_PLANET_PX = 640;
/** One wheel notch, as on the map. */
const WHEEL_STEP = 1.15;
/** How fast a hull glides to a re-solved place, ms (time constant). */
const GLIDE_MS = 260;

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

interface Shot {
  from: string; to: string; start: number; dur: number;
  kind: 'kinetic' | 'energy'; seed: number; across: boolean;
}

const factionById = new Map(FACTIONS.map(f => [f.id, f]));

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
  const [stats, setStats] = useState({ shots: 0, across: 0 });

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pan = useRef({ x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number; px: number; py: number } | null>(null);
  const tex = useImage(PLANETS[planet].tex);

  const baseR = PLANETS[planet].r;
  const planetR = baseR * zoom;
  // The map's own parked-hull size at this zoom (bodyPresentation).
  const hullScale = Math.round(hullSize({ type: 'terrestrial', radius: planetR }, 1) * 100) / 100;
  const ships: SandboxShip[] = useMemo(
    () => buildScenario(scenario, seed, hullScale),
    [scenario, seed, hullScale],
  );
  const { layout, solveMs } = useMemo(() => {
    const order = FACTIONS.map(f => f.id).filter(id => ships.some(s => s.faction === id));
    const t0 = performance.now();
    const L: OBLayout = mode === 'new'
      ? layoutOrbitBattle(ships, planetR, { seed, factionOrder: order })
      : layoutTodayLines(ships, planetR, { seed, factionOrder: order });
    return { layout: L, solveMs: performance.now() - t0 };
  }, [ships, planetR, mode, seed]);
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

  const zoomBy = (f: number) => setZoom(z =>
    Math.max(MIN_PLANET_PX / baseR, Math.min(MAX_PLANET_PX / baseR, z * f)));
  // Switching worlds keeps the zoom inside that world's range.
  useEffect(() => { zoomBy(1); }, [baseR]); // eslint-disable-line react-hooks/exhaustive-deps

  // Everything the animation loop reads, without re-subscribing it.
  const live = useRef({ ships, hulls, layout, planetR, tex, mode, showShares, planet });
  live.current = { ships, hulls, layout, planetR, tex, mode, showShares, planet };

  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return undefined;
    const g = cv.getContext('2d');
    if (!g) return undefined;
    let raf = 0;
    let last = performance.now();
    const shots: Shot[] = [];
    const nextFire = new Map<string, number>();
    const hits: Array<{ id: string; start: number; seed: number; kind: 'kinetic' | 'energy' }> = [];
    // Where each unit is DRAWN (polar, before the wheel), chasing its
    // solved place so a re-solve glides instead of jumping.
    const drawn = new Map<string, { r: number; t: number }>();
    let fired = 0, acrossCount = 0, lastStat = 0;

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
      const { ships: S, hulls: HL, layout: L, planetR: R, tex: T, mode: M, showShares: SH, planet: P } = live.current;
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
        const r = d.r + Math.sin(now / 1700 + ph) * 1.6;
        const t = d.t + rot + Math.sin(now / 2300 + ph * 1.3) * 0.004;
        // Nose: forward along the orbit, keeping the solved jitter.
        const jitter = p.heading - (Math.atan2(p.y, p.x) + Math.PI / 2);
        unitPos.set(s.id, { x: cx + Math.cos(t) * r, y: cy + Math.sin(t) * r, h: t + Math.PI / 2 + jitter });
      }
      if (drawn.size > S.length * 2) {
        const keep = new Set(S.map(s => s.id));
        for (const id of [...drawn.keys()]) if (!keep.has(id)) drawn.delete(id);
      }
      // And every hull from its unit: escorts ride in the fleet's frame.
      const pos = new Map<string, { x: number; y: number; h: number }>();
      for (const h of HL) {
        const u = unitPos.get(h.unit);
        if (!u) continue;
        const c = Math.cos(u.h), sn = Math.sin(u.h);
        pos.set(h.id, { x: u.x + h.lx * c - h.ly * sn, y: u.y + h.lx * sn + h.ly * c, h: u.h });
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
      if (SH) {
        for (const sec of L.sectors) {
          const f = factionById.get(sec.faction);
          g.strokeStyle = f?.color ?? '#fff';
          g.globalAlpha = 0.3;
          g.lineWidth = L.band.rOut - L.band.rIn;
          g.beginPath();
          g.arc(cx, cy, (L.band.rIn + L.band.rOut) / 2, sec.start + rot, sec.end + rot);
          g.stroke();
          g.globalAlpha = 1;
        }
      }

      // FIRE. Every armed hull fires every second or two (an escort half
      // as often) at an enemy hull chosen by distance: front-liners trade
      // with their neighbours, the far side fires ACROSS the world.
      // Today's rules suppress any shot the planet would block.
      for (const s of HL) {
        if (!s.armed) continue;
        const at = nextFire.get(s.id);
        if (at === undefined) { nextFire.set(s.id, now + Math.random() * 2400); continue; }
        if (now < at) continue;
        nextFire.set(s.id, now + (900 + Math.random() * 1400) * (s.escort ? 2 : 1));
        const me = pos.get(s.id);
        if (!me) continue;
        let total = 0;
        const weights: Array<[Hull, number, boolean]> = [];
        for (const o of HL) {
          if (o.faction === s.faction) continue;
          const op = pos.get(o.id);
          if (!op) continue;
          const across = crossesPlanet(me.x - cx, me.y - cy, op.x - cx, op.y - cy, R);
          if (M === 'today' && across) continue;
          const d = Math.hypot(op.x - me.x, op.y - me.y);
          const w = 1 / Math.pow(Math.max(40, d), 1.5);
          weights.push([o, w, across]);
          total += w;
        }
        if (total <= 0) continue;
        let pick = Math.random() * total;
        let chosen = weights[0];
        for (const w of weights) { pick -= w[1]; if (pick <= 0) { chosen = w; break; } }
        const tp = pos.get(chosen[0].id)!;
        const d = Math.hypot(tp.x - me.x, tp.y - me.y);
        const kind = factionById.get(s.faction)?.weapon ?? 'kinetic';
        shots.push({
          from: s.id, to: chosen[0].id, start: now, kind, across: chosen[2],
          dur: kind === 'energy' ? 200 : Math.max(140, Math.min(900, d / 1.1)),
          seed: (Math.random() * 1e6) | 0,
        });
        fired++;
        if (chosen[2]) acrossCount++;
      }

      // Hulls, drawn under the fire, as drawShip draws them: the design
      // the player picked, and the soft engine glow astern of every
      // full-size hull. Escorts are drawEscortHull's: no glow.
      for (const s of HL) {
        const p = pos.get(s.id);
        if (!p) continue;
        const f = factionById.get(s.faction)!;
        const img = s.cls === 'mega_destroyer'
          ? getStructureIconImage('mega_destroyer', f.color, null, f.color2)
          : getShipIconImage(s.cls, f.color, s.variant, f.color2);
        if (!s.escort && s.cls !== 'mega_destroyer') {
          const ph = (((s.id.charCodeAt(s.id.length - 1) * 37) % 1000) / 1000) * Math.PI * 2;
          const pulse = 0.6 + 0.4 * Math.sin(now / 420 + ph);
          g.save();
          g.globalCompositeOperation = 'lighter';
          glowAt(g, p.x - Math.cos(p.h) * s.size * 0.46, p.y - Math.sin(p.h) * s.size * 0.46,
            Math.max(2.5, s.size * 0.2) * 1.15, '#fff3dc', '#ff9a4a', 0.6 * pulse);
          g.restore();
        }
        g.save();
        g.translate(p.x, p.y);
        g.rotate(p.h);
        if (img) g.drawImage(img, -s.size / 2, -s.size / 2, s.size, s.size);
        else { g.fillStyle = f.color; g.beginPath(); g.arc(0, 0, s.size * 0.2, 0, Math.PI * 2); g.fill(); }
        g.restore();
      }

      // Rounds, beams, muzzles and the hits they land, sized to the hull.
      const sizeOf = new Map(HL.map(h => [h.id, h.size]));
      for (let i = shots.length - 1; i >= 0; i--) {
        const sh = shots[i];
        const a = pos.get(sh.from), b = pos.get(sh.to);
        const kk = (now - sh.start) / sh.dur;
        if (!a || !b || kk >= 1) {
          if (b && kk >= 1) hits.push({ id: sh.to, start: now, seed: sh.seed, kind: sh.kind });
          shots.splice(i, 1);
          continue;
        }
        const fs = Math.max(0.35, Math.min(1.2, (sizeOf.get(sh.from) ?? 50) / 50));
        const ang = Math.atan2(b.y - a.y, b.x - a.x);
        if (kk < 0.35) drawMuzzle(g, a.x, a.y, ang, 9 * fs, 1 - kk / 0.35, sh.kind === 'energy' ? ENERGY_FX : KINETIC_FX);
        if (sh.kind === 'energy') {
          drawBeam(g, a.x, a.y, b.x, b.y, 2.2 * fs, 1 - kk, now, sh.seed, ENERGY_FX);
        } else {
          const hx = a.x + (b.x - a.x) * kk, hy = a.y + (b.y - a.y) * kk;
          const tail = Math.min(46 * fs, Math.hypot(b.x - a.x, b.y - a.y) * kk);
          drawRound(g, hx - Math.cos(ang) * tail, hy - Math.sin(ang) * tail, hx, hy, 2.2 * fs, 1, KINETIC_FX);
        }
      }
      for (let i = hits.length - 1; i >= 0; i--) {
        const h = hits[i];
        const kk = (now - h.start) / 260;
        const p = pos.get(h.id);
        if (!p || kk >= 1) { hits.splice(i, 1); continue; }
        const hs = Math.max(0.35, Math.min(1.2, (sizeOf.get(h.id) ?? 50) / 50));
        const pal = h.kind === 'energy' ? ENERGY_FX : KINETIC_FX;
        drawHullHit(g, p.x, p.y, 0, 14 * hs, kk, h.seed, pal);
        drawSparks(g, p.x, p.y, (h.seed % 628) / 100, 1.2, 5 * hs, 16 * hs, kk, h.seed, pal);
      }

      if (now - lastStat > 1000) {
        lastStat = now;
        setStats({ shots: fired, across: acrossCount });
        fired = 0; acrossCount = 0;
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

  return (
    <div
      style={{ position: 'fixed', inset: 0, background: '#060a11', touchAction: 'none' }}
      onWheel={e => zoomBy(e.deltaY > 0 ? 1 / WHEEL_STEP : WHEEL_STEP)}
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
          A prototype: a fight takes as much of the orbit as its ships need, and fires across the world.
          Scroll to zoom: the world shrinks, the hulls keep the map&apos;s sizes, and the fight re-spreads.
          Drag to pan.
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
          <span style={{ color: '#7f93a8' }}>Shots / second</span>
          <span>{stats.shots}{stats.shots > 0 && ` · ${Math.round((stats.across / stats.shots) * 100)}% across the world`}</span>
          <span style={{ color: '#7f93a8' }}>World on screen</span>
          <span data-testid="battle-zoom">{Math.round(planetR)}px radius · hulls at {Math.round(hullScale * 100)}%</span>
          <span style={{ color: '#7f93a8' }}>Re-solve</span>
          <span data-testid="battle-solve">{solveMs.toFixed(1)} ms</span>
        </div>
        {mode === 'today' && (
          <div style={ui.dim}>
            Today&apos;s rules, approximated: every side in a narrow arc, up to four ranks, then hulls overlap.
            Shots the planet would block are not fired.
          </div>
        )}
      </div>
    </div>
  );
}
