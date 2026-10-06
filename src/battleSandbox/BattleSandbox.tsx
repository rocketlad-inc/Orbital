// ============================================================
// BattleSandbox — /?battle. Watch a fight laid out over a whole orbit.
//
// The test page for the cramped-fleet prototype (render/orbitBattleLayout).
// Drawn with the game's own pieces: the real ship sprites and capital
// hulls (shipIconCache / structureIconCache), the real globe textures and
// lighting (fxPrimitives), and the real weapon art (fxArt: rounds, beams,
// muzzle flashes, hull hits). Only the LAYOUT is new.
//
// Compare with TODAY'S rules (the narrow-arc battle lines, approximated
// in orbitBattleLayout.layoutTodayLines): same roster, same planet,
// shots that would cross the planet suppressed, as the map does now.
// ============================================================

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  layoutOrbitBattle, layoutTodayLines, crossesPlanet, type OBLayout,
} from '../render/orbitBattleLayout';
import { buildScenario, FACTIONS, SCENARIOS, type ScenarioId, type SandboxShip } from './scenarios';
import { getShipIconImage } from '../render/shipIconCache';
import { getStructureIconImage } from '../render/structureIconCache';
import { drawTexturedDisk, drawSphereLighting } from '../render/fxPrimitives';
import { drawRound, drawBeam, drawMuzzle, drawHullHit, drawSparks, KINETIC_FX, ENERGY_FX } from '../render/fxArt';
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
  const [scenario, setScenario] = useState<ScenarioId>('medium');
  const [planet, setPlanet] = useState<PlanetId>('mars');
  const [mode, setMode] = useState<'new' | 'today'>('new');
  const [zoom, setZoom] = useState(1);
  const [seed, setSeed] = useState(1);
  const [showShares, setShowShares] = useState(false);
  const [stats, setStats] = useState({ shots: 0, across: 0 });

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const tex = useImage(PLANETS[planet].tex);

  const planetR = PLANETS[planet].r * zoom;
  // Sprites barely grow with zoom in the game (drawShip caps them), so
  // the planet grows faster than the ships, as on the map.
  const shipScale = Math.max(0.75, Math.min(1.25, Math.sqrt(zoom)));
  const ships: SandboxShip[] = useMemo(
    () => buildScenario(scenario, seed).map(s => ({ ...s, size: s.size * shipScale })),
    [scenario, seed, shipScale],
  );
  const layout: OBLayout = useMemo(() => {
    const order = FACTIONS.map(f => f.id).filter(id => ships.some(s => s.faction === id));
    return mode === 'new'
      ? layoutOrbitBattle(ships, planetR, { seed, factionOrder: order })
      : layoutTodayLines(ships, planetR, { seed, factionOrder: order });
  }, [ships, planetR, mode, seed]);

  // Everything the animation loop reads, without re-subscribing it.
  const live = useRef({ ships, layout, planetR, tex, mode, showShares, planet });
  live.current = { ships, layout, planetR, tex, mode, showShares, planet };

  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return undefined;
    const g = cv.getContext('2d');
    if (!g) return undefined;
    let raf = 0;
    const shots: Shot[] = [];
    const nextFire = new Map<string, number>();
    const hits: Array<{ id: string; start: number; seed: number; kind: 'kinetic' | 'energy' }> = [];
    let fired = 0, acrossCount = 0, lastStat = 0;

    // A fixed field of stars.
    const stars = Array.from({ length: 260 }, (_, i) => ({
      x: ((i * 7919) % 1000) / 1000, y: ((i * 104729) % 997) / 997, a: 0.25 + ((i * 31) % 70) / 100,
    }));

    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      cv.width = Math.round(cv.clientWidth * dpr);
      cv.height = Math.round(cv.clientHeight * dpr);
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    window.addEventListener('resize', resize);

    const frame = (now: number) => {
      const { ships: S, layout: L, planetR: R, tex: T, mode: M, showShares: SH, planet: P } = live.current;
      const W = cv.clientWidth, H = cv.clientHeight;
      // FIT THE WHOLE FIGHT. The panel takes the left 330px when there is
      // room; the view zooms out (planet and ships alike) so the outer
      // edge of the battle stays on screen at any window size.
      const panel = W > 980 ? 330 : 0;
      const availW = W - panel, availH = H;
      const reach = L.band.rOut + 46;
      const view = Math.min(1, (Math.min(availW, availH) / 2 - 12) / reach);
      g.setTransform(1, 0, 0, 1, 0, 0);
      const dpr = window.devicePixelRatio || 1;
      g.setTransform(dpr * view, 0, 0, dpr * view, 0, 0);
      const cx = (panel + availW / 2) / view, cy = (availH / 2) / view;
      const rot = ((now % TURN_MS) / TURN_MS) * Math.PI * 2;

      // Where each ship is NOW: its layout place, the battle's slow wheel,
      // and a small bob of its own so the cluster breathes.
      const pos = new Map<string, { x: number; y: number; h: number }>();
      for (const s of S) {
        const p = L.placements.get(s.id);
        if (!p) continue;
        const ph = (s.id.length * 13 + s.id.charCodeAt(s.id.length - 1) * 7) % 100;
        const r = p.r + Math.sin(now / 1700 + ph) * 1.6;
        const t = p.theta + rot + Math.sin(now / 2300 + ph * 1.3) * 0.004;
        pos.set(s.id, { x: cx + Math.cos(t) * r, y: cy + Math.sin(t) * r, h: p.heading + rot });
      }

      // Background.
      g.fillStyle = '#060a11';
      g.fillRect(0, 0, W / view, H / view);
      for (const st of stars) {
        g.fillStyle = `rgba(220,230,255,${st.a * 0.6})`;
        g.fillRect((st.x * W) / view, (st.y * H) / view, 1.3 / view, 1.3 / view);
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
          g.globalAlpha = 0.35;
          g.lineWidth = L.band.rOut - L.band.rIn;
          g.beginPath();
          g.arc(cx, cy, (L.band.rIn + L.band.rOut) / 2, sec.start + rot, sec.end + rot);
          g.stroke();
          g.globalAlpha = 1;
        }
      }

      // FIRE. Each armed hull fires every second or two at an enemy chosen
      // by distance: front-liners trade with their neighbours, the far
      // side fires ACROSS the world. Today's rules suppress any shot the
      // planet would block, as the map does.
      const byFaction = new Map<string, SandboxShip[]>();
      for (const s of S) {
        const arr = byFaction.get(s.faction) ?? [];
        arr.push(s);
        byFaction.set(s.faction, arr);
      }
      for (const s of S) {
        if (!s.armed) continue;
        const at = nextFire.get(s.id);
        if (at === undefined) { nextFire.set(s.id, now + Math.random() * 1800); continue; }
        if (now < at) continue;
        nextFire.set(s.id, now + 900 + Math.random() * 1400);
        const me = pos.get(s.id);
        if (!me) continue;
        const enemies = S.filter(o => o.faction !== s.faction);
        let total = 0;
        const weights: Array<[SandboxShip, number, boolean]> = [];
        for (const o of enemies) {
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

      // Ships, drawn under the fire.
      for (const s of S) {
        const p = pos.get(s.id);
        if (!p) continue;
        const f = factionById.get(s.faction)!;
        const img = s.cls === 'mega_destroyer'
          ? getStructureIconImage('mega_destroyer', f.color, null, f.color2)
          : getShipIconImage(s.cls, f.color, undefined, f.color2);
        g.save();
        g.translate(p.x, p.y);
        g.rotate(p.h);
        if (img) g.drawImage(img, -s.size / 2, -s.size / 2, s.size, s.size);
        else { g.fillStyle = f.color; g.beginPath(); g.arc(0, 0, s.size * 0.2, 0, Math.PI * 2); g.fill(); }
        g.restore();
      }

      // Rounds, beams, muzzles and the hits they land.
      for (let i = shots.length - 1; i >= 0; i--) {
        const sh = shots[i];
        const a = pos.get(sh.from), b = pos.get(sh.to);
        const k = (now - sh.start) / sh.dur;
        if (!a || !b || k >= 1) {
          if (b && k >= 1) hits.push({ id: sh.to, start: now, seed: sh.seed, kind: sh.kind });
          shots.splice(i, 1);
          continue;
        }
        const ang = Math.atan2(b.y - a.y, b.x - a.x);
        if (k < 0.35) drawMuzzle(g, a.x, a.y, ang, 9, 1 - k / 0.35, sh.kind === 'energy' ? ENERGY_FX : KINETIC_FX);
        if (sh.kind === 'energy') {
          drawBeam(g, a.x, a.y, b.x, b.y, 2.2, 1 - k, now, sh.seed, ENERGY_FX);
        } else {
          const hx = a.x + (b.x - a.x) * k, hy = a.y + (b.y - a.y) * k;
          const tail = Math.min(46, Math.hypot(b.x - a.x, b.y - a.y) * k);
          drawRound(g, hx - Math.cos(ang) * tail, hy - Math.sin(ang) * tail, hx, hy, 2.2, 1, KINETIC_FX);
        }
      }
      for (let i = hits.length - 1; i >= 0; i--) {
        const h = hits[i];
        const k = (now - h.start) / 260;
        const p = pos.get(h.id);
        if (!p || k >= 1) { hits.splice(i, 1); continue; }
        const pal = h.kind === 'energy' ? ENERGY_FX : KINETIC_FX;
        drawHullHit(g, p.x, p.y, 0, 14, k, h.seed, pal);
        drawSparks(g, p.x, p.y, (h.seed % 628) / 100, 1.2, 5, 16, k, h.seed, pal);
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
    .map(f => ({ f, n: ships.filter(s => s.faction === f.id).length }))
    .filter(x => x.n > 0);

  return (
    <div
      style={{ position: 'fixed', inset: 0, background: '#060a11' }}
      onWheel={e => setZoom(z => Math.max(0.5, Math.min(1.8, z * (e.deltaY > 0 ? 0.92 : 1.08))))}
    >
      <canvas ref={canvasRef} style={{ width: '100%', height: '100%', display: 'block' }} data-testid="battle-canvas" />
      <div style={ui.panel}>
        <div style={ui.h}>Orbital battle layout</div>
        <div style={ui.dim}>
          A prototype: a fight takes as much of the orbit as its ships need, and fires across the world.
          Scroll to zoom.
        </div>

        <div style={ui.label}>Battle</div>
        <div style={ui.row}>
          {(Object.keys(SCENARIOS) as ScenarioId[]).map(id => (
            <button key={id} type="button" style={chip(scenario === id)} onClick={() => setScenario(id)}
              title={SCENARIOS[id].blurb}>{SCENARIOS[id].label}</button>
          ))}
        </div>

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
          {onExit && <button type="button" style={chip(false)} onClick={onExit}>Exit</button>}
        </div>

        <div style={ui.stat} data-testid="battle-stats">
          {factionCounts.map(({ f, n }) => (
            <React.Fragment key={f.id}>
              <span style={{ color: f.color }}>■ {f.name}</span><span>{n} ships</span>
            </React.Fragment>
          ))}
          <span style={{ color: '#7f93a8' }}>Spread</span>
          <span>{mode === 'new' ? layout.mode : 'battle lines (86° sector)'}</span>
          <span style={{ color: '#7f93a8' }}>Overlapping pairs</span>
          <span style={{ color: layout.overlaps ? '#ff8a8a' : '#6ee7b7' }} data-testid="battle-overlaps">{layout.overlaps}</span>
          <span style={{ color: '#7f93a8' }}>Shots / second</span>
          <span>{stats.shots}{stats.shots > 0 && ` · ${Math.round((stats.across / stats.shots) * 100)}% across the world`}</span>
          <span style={{ color: '#7f93a8' }}>Zoom</span><span>{zoom.toFixed(2)}×</span>
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
