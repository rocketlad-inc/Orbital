// ============================================================
// TheatreRecap — watch a whole campaign, not one engagement.
//
// A battle is one body and a contiguous run of ticks. That is the grain a
// player remembers a single fight at, and it is the wrong grain for a
// war: a fleet working its way through Mars, Phobos and Deimos is one
// campaign that the per-body records can only show as three unrelated
// scraps. A THEATRE (migration 0099) groups them by the planetary
// neighbourhood they were fought in, and this is the view onto that.
//
// The whole neighbourhood is on the board — every world orbiting the
// anchor, contested or not — because a fleet crossing from one to the
// next has to cross something. The moons are where the game says they
// are: same angle0 + 2π·t·SPEED/period the simulation uses, so a moon
// that was on the far side of its primary when the shooting started is
// drawn there.
//
// The movement between worlds is not recorded anywhere and does not need
// to be. Each battle's frames are tagged with their body, so a hull
// listed at Mars on one tick and at Phobos on the next demonstrably made
// that crossing, and playback flies it across under power. Nothing is
// invented: the endpoints and the tick are all in the record, and only
// the path between them is drawn.
// ============================================================

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { apiFetch } from './api';
import { getShipIconImage } from '../render/shipIconCache';
import { getEmblemImage } from '../render/emblemCache';
import {
  getPlanetTexture, getTerraformedTexture, terraformFraction, hashStr, mulberry32,
} from '../render/planetTexture';
import {
  drawBolt, drawBlast, drawDebris, drawWreckShards, drawBurn,
  drawTexturedDisk, drawSphereLighting, drawThrustExhaust,
  DETONATION_LIFE_MS, DEBRIS_LIFE_MS,
} from '../render/fxPrimitives';
import { drawStationStructure } from '../render/isoStructures';
import { deriveSecondary } from '../game/colorUtils';
import { ShipIconClass, ShipIconVariant } from '../components/ShipIcons';
import type { Body } from '../types';

const NEUTRAL = '#8a9fb3';

/** Matches the simulation's own circular-orbit rule (orbitPos.js), so a
 *  world is drawn where the game had it on that tick rather than
 *  somewhere plausible. */
const ORBITAL_SPEED_SCALE = 0.7;
const orbitAngle = (angle0: number, period: number, t: number) =>
  (angle0 ?? 0) + (period > 0 ? (Math.PI * 2 * t * ORBITAL_SPEED_SCALE) / period : 0);

const CANVAS_W = 860, CANVAS_H = 520;
const TICK_MS = 2200;
const LAUNCH_SPREAD = 0.34, FLIGHT_FRAC = 0.28, BURY_MS = 110, DRAIN_MS = 420;
const LIGHT_X = 0.74, LIGHT_Y = 0.67;
/** Orbital planes seen from the same angle as the single-battle recap. */
const TILT = 0.58;
/** How far off a body its combatants hold. */
const GUARD_RING = 26;
const SHIP_PX: Record<string, number> = {
  corvette: 15, frigate: 18, freighter: 17, colony: 17, destroyer: 22,
};
const ICON_CLASSES: ShipIconClass[] = ['corvette', 'frigate', 'destroyer', 'freighter', 'colony'];
const iconClassOf = (cls: string | null): ShipIconClass | null => {
  const c = (cls ?? '').toLowerCase();
  return (ICON_CLASSES as string[]).includes(c) ? (c as ShipIconClass) : null;
};
const shipPx = (cls: string | null) => SHIP_PX[(cls ?? '').toLowerCase()] ?? 16;

/** Trim to a pixel width with an ellipsis. A hard character cut lands
 *  mid-word and still overruns the count beside it. */
function fitText(g: CanvasRenderingContext2D, s: string, maxPx: number): string {
  if (g.measureText(s).width <= maxPx) return s;
  let out = s;
  while (out.length > 1 && g.measureText(out + '…').width > maxPx) out = out.slice(0, -1);
  return out + '…';
}

interface TFrame {
  tick: number; seq: number; body_id: string | null;
  shots: number; hits: number; damage: number; kills: number;
  roster: Array<{
    id: string; fid: string | null; cls: string | null; name: string | null;
    hp: number; hpMax: number | null; dead: number; kind?: string; mods?: string | null;
  }>;
  shot_log: Array<{
    a: string | null; t: string | null; hit: number; dmg: number; kill: number;
    e?: number; abs?: number;
  }>;
}
interface TParticipant {
  ship_id: string; faction_id: string | null; ship_name: string | null;
  ship_class: string | null; died_tick: number | null; kind?: string;
  icon_variant?: string | null; rank?: number; parts?: string | null;
}
interface TBody {
  id: string; name: string; type: string; color: string;
  radius: number; orbitRadius: number | null; orbitPeriod: number | null;
  angle0: number | null; parentBodyId: string | null;
  ownerFactionId: string | null;
  resources?: Record<string, number>;
  terraformedAtTick: number | null; terraformCompletesAtTick: number | null;
}
export interface TheatreDetail {
  theatre: {
    id: string; anchor_body_id: string | null; anchor_name: string | null;
    started_tick: number; last_fire_tick: number; ended_tick: number | null;
    status: string; battle_count: number; shots: number; ships_lost: number;
    body_ids: string[]; faction_ids: string[];
  };
  battles: Array<{
    id: string; body_id: string | null; body_name: string | null;
    participants: TParticipant[]; frames: TFrame[];
  }>;
  bodies: TBody[];
  factions: Record<string, {
    name: string; color: string | null; color2?: string | null; emblem?: string | null;
  }>;
}

const clampFrame = (pos: number, len: number) => {
  if (!(len > 0)) return 0;
  const i = Math.floor(Number(pos));
  if (!Number.isFinite(i) || i < 0) return 0;
  return Math.min(len - 1, i);
};

/** One tick of the whole campaign: every body that had anything happen,
 *  and where each hull was. */
interface Beat {
  tick: number;
  /** bodyId -> that body's roster and shots for this tick. */
  at: Map<string, { roster: TFrame['roster']; shots: TFrame['shot_log'] }>;
  /** hullId -> the body it was at. */
  where: Map<string, string>;
}

export function TheatreRecap({ gameId, theatreId }: { gameId: string; theatreId: string }) {
  const [d, setD] = useState<TheatreDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let dead = false;
    (async () => {
      const res = await apiFetch<TheatreDetail>(
        `/api/admin/games/${gameId}/theatres/${encodeURIComponent(theatreId)}`);
      if (dead) return;
      if (res.ok) setD(res.data);
      else setErr(`Campaign failed to load (HTTP ${res.status}).`);
    })();
    return () => { dead = true; };
  }, [gameId, theatreId]);

  if (err) return <div className="mp-error">{err}</div>;
  if (!d) return <div style={{ color: NEUTRAL, padding: 10 }}>Loading the campaign…</div>;
  return <TheatreCanvas d={d} />;
}

/** Exported so a payload can be rendered without going through the
 *  fetch — the campaign view is worth being able to drive from a
 *  fixture. */
export function TheatreCanvas({ d }: { d: TheatreDetail }) {
  const cv = useRef<HTMLCanvasElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [pos, setPos] = useState(0);
  const posRef = useRef(0);
  posRef.current = pos;
  const raf = useRef<number | null>(null);
  const last = useRef(0);

  const colorOf = useCallback(
    (fid: string | null) => (fid && d.factions[fid]?.color) || NEUTRAL, [d.factions]);
  const trimOf = useCallback((fid: string | null) => {
    const f = fid ? d.factions[fid] : null;
    if (!f?.color) return undefined;
    return f.color2 || deriveSecondary(f.color);
  }, [d.factions]);

  /** Every hull that appeared anywhere in the campaign. */
  const hulls = useMemo(() => {
    const m = new Map<string, {
      fid: string | null; cls: string | null; name: string | null;
      kind: string; variant: ShipIconVariant | undefined; rank: number;
      energy: boolean; diedTick: number | null;
    }>();
    for (const b of d.battles) {
      for (const p of b.participants) {
        if (m.has(p.ship_id)) continue;
        let energy = false;
        try {
          const parts = p.parts ? JSON.parse(p.parts) : null;
          if (Array.isArray(parts)) energy = parts.filter((x: string) => x === 'energy').length
            > parts.filter((x: string) => x === 'kinetic').length;
        } catch { /* an unreadable loadout is a kinetic one */ }
        m.set(p.ship_id, {
          fid: p.faction_id, cls: p.ship_class, name: p.ship_name,
          kind: p.kind ?? 'ship',
          variant: (p.icon_variant as ShipIconVariant) || undefined,
          rank: Number(p.rank) || 0, energy, diedTick: p.died_tick,
        });
      }
    }
    return m;
  }, [d.battles]);

  /**
   * The campaign on one clock.
   *
   * Every battle's frames are folded together by tick, and each hull's
   * body is carried forward across ticks where its body saw no shooting —
   * a fleet does not cease to exist because it had a quiet minute.
   */
  const beats = useMemo(() => {
    const byTick = new Map<number, Beat>();
    for (const b of d.battles) {
      for (const f of b.frames) {
        const bodyId = f.body_id ?? b.body_id ?? 'deep';
        let beat = byTick.get(f.tick);
        if (!beat) { beat = { tick: f.tick, at: new Map(), where: new Map() }; byTick.set(f.tick, beat); }
        const slot = beat.at.get(bodyId) ?? { roster: [], shots: [] };
        slot.roster = slot.roster.concat(f.roster);
        slot.shots = slot.shots.concat(f.shot_log);
        beat.at.set(bodyId, slot);
        for (const r of f.roster) beat.where.set(r.id, bodyId);
      }
    }
    const out = [...byTick.values()].sort((a, b) => a.tick - b.tick);
    // Carry each hull's last known station forward, so it stays on the
    // board through the ticks its body was quiet.
    const held = new Map<string, string>();
    for (const beat of out) {
      for (const [id, body] of beat.where) held.set(id, body);
      for (const [id, body] of held) {
        if (!beat.where.has(id)) {
          const h = hulls.get(id);
          // A hull that died stays dead; a place stays put.
          if (h?.diedTick != null && beat.tick > h.diedTick) continue;
          beat.where.set(id, body);
        }
      }
    }
    return out;
  }, [d.battles, hulls]);

  /** A stable spot on its body's guard ring for every hull, so the eye can
   *  follow one across the campaign. */
  const seats = useMemo(() => {
    const m = new Map<string, number>();
    const sides = [...new Set([...hulls.values()].map(h => h.fid ?? 'none'))];
    for (const [id, h] of hulls) {
      const si = Math.max(0, sides.indexOf(h.fid ?? 'none'));
      const base = (si / Math.max(1, sides.length)) * Math.PI * 2;
      m.set(id, base + ((hashStr(id) % 1000) / 1000 - 0.5) * 1.5);
    }
    return m;
  }, [hulls]);

  const stars = useMemo(() => {
    const rng = mulberry32(hashStr(d.theatre.id + ':stars'));
    return Array.from({ length: 190 }, () => ({
      x: rng() * CANVAS_W, y: rng() * CANVAS_H,
      r: 0.4 + rng() * 0.9, a: 0.15 + rng() * 0.5, ph: rng() * Math.PI * 2,
    }));
  }, [d.theatre.id]);

  // Sprites are rasterized asynchronously — ask for every hull up front.
  useEffect(() => {
    for (const [, h] of hulls) {
      const cls = iconClassOf(h.cls);
      if (!cls) continue;
      getShipIconImage(cls, colorOf(h.fid), h.variant, trimOf(h.fid));
    }
  }, [hulls, colorOf, trimOf]);

  useEffect(() => {
    if (!playing) return;
    last.current = performance.now();
    const step = (now: number) => {
      const dt = now - last.current;
      last.current = now;
      setPos(p => {
        const next = p + dt / TICK_MS;
        if (next >= beats.length - 1 + 0.999) { setPlaying(false); return beats.length - 1; }
        return next;
      });
      raf.current = requestAnimationFrame(step);
    };
    raf.current = requestAnimationFrame(step);
    return () => { if (raf.current) cancelAnimationFrame(raf.current); };
  }, [playing, beats.length]);

  useEffect(() => {
    const canvas = cv.current;
    if (!canvas) return;
    const g = canvas.getContext('2d');
    if (!g) return;
    let live = true;
    let handle = 0;

    const anchor = d.bodies.find(b => b.id === d.theatre.anchor_body_id) ?? d.bodies[0];
    const moons = d.bodies.filter(b => b.id !== anchor?.id);
    const maxOrbit = Math.max(1, ...moons.map(m => Number(m.orbitRadius) || 0));
    const SPAN = Math.min(CANVAS_W, CANVAS_H) * 0.40;
    const cx = CANVAS_W * 0.46, cy = CANVAS_H * 0.50;
    const anchorR = Math.max(30, Math.min(52, 30 + (Number(anchor?.radius) || 2) * 4));

    /** Where a world is at this instant, in canvas pixels. */
    const bodyPos = (b: TBody | undefined, tickF: number) => {
      if (!b || b.id === anchor?.id) return { x: cx, y: cy, r: anchorR };
      const rr = ((Number(b.orbitRadius) || 0) / maxOrbit) * SPAN;
      const a = orbitAngle(Number(b.angle0) || 0, Number(b.orbitPeriod) || 0, tickF);
      return {
        x: cx + Math.cos(a) * rr,
        y: cy + Math.sin(a) * rr * TILT,
        r: Math.max(10, Math.min(24, 10 + (Number(b.radius) || 1) * 4)),
      };
    };
    const bodyById = new Map(d.bodies.map(b => [b.id, b]));

    const draw = (nowMs: number) => {
      if (!live) return;
      handle = requestAnimationFrame(draw);
      const i = clampFrame(posRef.current, beats.length);
      const t = Math.min(1, Math.max(0, posRef.current - i));
      const beat = beats[i];
      if (!beat) return;
      const nextBeat = beats[Math.min(beats.length - 1, i + 1)];
      // The simulation clock, interpolated, so the worlds keep moving
      // through a beat instead of stepping once per tick.
      const tickF = beat.tick + (nextBeat.tick - beat.tick) * t;
      const beatMs = t * TICK_MS;

      g.fillStyle = '#05070c';
      g.fillRect(0, 0, CANVAS_W, CANVAS_H);
      for (const s of stars) {
        g.fillStyle = `rgba(203, 225, 245, ${(s.a * (0.75 + 0.25 * Math.sin(nowMs / 900 + s.ph))).toFixed(3)})`;
        g.beginPath(); g.arc(s.x, s.y, s.r, 0, Math.PI * 2); g.fill();
      }

      // ---- the neighbourhood ----------------------------------------
      for (const m of moons) {
        const rr = ((Number(m.orbitRadius) || 0) / maxOrbit) * SPAN;
        g.strokeStyle = 'rgba(90, 130, 170, 0.16)';
        g.lineWidth = 1;
        g.beginPath();
        g.ellipse(cx, cy, rr, rr * TILT, 0, 0, Math.PI * 2);
        g.stroke();
      }

      const paintWorld = (b: TBody, p: { x: number; y: number; r: number }) => {
        const tf = terraformFraction(b as unknown as Body, beat.tick);
        const tex = tf >= 1
          ? (getTerraformedTexture(b as unknown as Body) ?? getPlanetTexture(b as unknown as Body))
          : getPlanetTexture(b as unknown as Body);
        if (tex) {
          drawTexturedDisk(g, tex, p.x, p.y, p.r, nowMs * p.r * 0.000035);
        } else {
          g.fillStyle = b.color || '#101d2b';
          g.beginPath(); g.arc(p.x, p.y, p.r, 0, Math.PI * 2); g.fill();
        }
        drawSphereLighting(g, p.x, p.y, p.r, LIGHT_X, LIGHT_Y);
        // Whose world it is, as a thin ring in the owner's colour.
        if (b.ownerFactionId) {
          g.strokeStyle = colorOf(b.ownerFactionId);
          g.globalAlpha = 0.55;
          g.lineWidth = 1.4;
          g.beginPath(); g.arc(p.x, p.y, p.r + 3, 0, Math.PI * 2); g.stroke();
          g.globalAlpha = 1;
        }
      };

      /** Names last, over the top of the fleets. A world is the one thing
       *  on this board that must always be identifiable, and a hull
       *  parked on its label was burying it. */
      const nameWorld = (b: TBody, p: { x: number; y: number; r: number }) => {
        const hot = beat.at.get(b.id);
        g.font = '11px system-ui';
        g.textAlign = 'center';
        const w = g.measureText(b.name).width;
        g.fillStyle = 'rgba(6, 10, 16, 0.72)';
        g.fillRect(p.x - w / 2 - 4, p.y + p.r + 5, w + 8, 14);
        g.fillStyle = hot && hot.shots.length > 0 ? '#ffb0a8' : '#8fb4d4';
        g.fillText(b.name, p.x, p.y + p.r + 16);
      };

      if (anchor) paintWorld(anchor, bodyPos(anchor, tickF));
      for (const m of moons) paintWorld(m, bodyPos(m, tickF));

      // ---- where every hull is, and where it is going ----------------
      const stationAt = (bodyId: string | undefined, hullId: string, tf2: number) => {
        const b = bodyId ? bodyById.get(bodyId) : undefined;
        const p = bodyPos(b, tf2);
        const a = (seats.get(hullId) ?? 0) + nowMs * 0.00004;
        const ring = p.r + GUARD_RING;
        return { x: p.x + Math.cos(a) * ring, y: p.y + Math.sin(a) * ring * TILT };
      };

      /** Interpolated position, which IS the crossing when a hull's body
       *  changed between this beat and the next. */
      const posOf = (id: string) => {
        const from = beat.where.get(id);
        const to = nextBeat.where.get(id) ?? from;
        const a = stationAt(from, id, tickF);
        if (!to || to === from) return { ...a, moving: false as const, from: a, to: a };
        const b = stationAt(to, id, tickF);
        // Flip-and-burn shape, like the game's own transfers: slow away,
        // fast in the middle, slow in.
        const u = t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) * (1 - t);
        return {
          x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u,
          moving: true as const, from: a, to: b,
        };
      };

      // Damage this beat, applied per shot on its own arrival.
      const shotClock = (sh: TFrame['shot_log'][number], tick: number) => {
        const launch = ((hashStr(`${sh.a ?? ''}>${sh.t ?? ''}@${tick}`) % 997) / 997) * LAUNCH_SPREAD;
        return { launch, arriveMs: (launch + FLIGHT_FRAC) * TICK_MS };
      };
      const landed = new Map<string, number>();
      const allShots: TFrame['shot_log'] = [];
      for (const [, slot] of beat.at) for (const sh of slot.shots) allShots.push(sh);
      for (const sh of allShots) {
        if (!sh.t || !sh.hit) continue;
        const k = Math.max(0, Math.min(1, (beatMs - shotClock(sh, beat.tick).arriveMs) / DRAIN_MS));
        if (k > 0) landed.set(sh.t, (landed.get(sh.t) ?? 0) + sh.dmg * k);
      }
      const hpNow = new Map<string, { hp: number; max: number | null; dead: boolean }>();
      for (const [, slot] of beat.at) {
        for (const r of slot.roster) {
          hpNow.set(r.id, {
            hp: Math.max(0, r.hp - (landed.get(r.id) ?? 0)),
            max: r.hpMax, dead: r.dead === 1,
          });
        }
      }

      // ---- hulls ------------------------------------------------------
      const drawn = new Set<string>();
      for (const [id, bodyId] of beat.where) {
        if (drawn.has(id)) continue;
        drawn.add(id);
        const h = hulls.get(id);
        if (!h) continue;
        if (h.diedTick != null && beat.tick > h.diedTick) {
          const q = stationAt(bodyId, id, tickF);
          drawWreckShards(g, q.x, q.y, 7, 0.45, id, nowMs);
          continue;
        }
        const st = hpNow.get(id);
        const q = posOf(id);
        const col = colorOf(h.fid);
        const size = h.kind === 'ship' ? shipPx(h.cls) : 26;
        // A hull that died on THIS beat goes up where it stood.
        if (st?.dead && beatMs > (LAUNCH_SPREAD / 2 + FLIGHT_FRAC) * TICK_MS) {
          const since = beatMs - (LAUNCH_SPREAD / 2 + FLIGHT_FRAC) * TICK_MS;
          g.save();
          g.globalCompositeOperation = 'lighter';
          if (since < DETONATION_LIFE_MS) drawBlast(g, q.x, q.y, since / DETONATION_LIFE_MS, id, size / 24);
          if (since < DEBRIS_LIFE_MS) drawDebris(g, q.x, q.y, size * 0.5, since / DEBRIS_LIFE_MS, id);
          g.restore();
          continue;
        }

        if (h.kind === 'station' || h.kind === 'city') {
          g.save();
          g.translate(q.x, q.y);
          g.scale(0.5, 0.5);
          drawStationStructure(g, {
            weaponsLevel: 1, shipyardLevel: 0, labLevel: 0, thrustersLevel: 0,
            factionColor: col, builds: [], nowMs,
          });
          g.restore();
        } else {
          // Crossing between worlds: nose along the course, engines lit.
          const heading = q.moving
            ? Math.atan2(q.to.y - q.from.y, q.to.x - q.from.x)
            : (seats.get(id) ?? 0) + Math.PI / 2;
          if (q.moving) {
            // Burn hardest through the middle of the crossing, matching
            // the flip-and-burn the position uses.
            const burn = Math.max(0, 1 - Math.abs(t - 0.5) * 2) * 0.9 + 0.1;
            const dir = { x: Math.cos(heading), y: Math.sin(heading) };
            drawThrustExhaust(g,
              { x: q.x - dir.x * size * 0.42, y: q.y - dir.y * size * 0.42 },
              dir, size, burn, h.cls ?? undefined);
          }
          const cls = iconClassOf(h.cls);
          const icon = cls ? getShipIconImage(cls, col, h.variant, trimOf(h.fid)) : null;
          if (icon) {
            g.save();
            g.translate(q.x, q.y);
            g.rotate(heading);
            g.drawImage(icon, -size / 2, -size / 2, size, size);
            g.restore();
          } else {
            g.fillStyle = col;
            g.beginPath(); g.arc(q.x, q.y, size * 0.3, 0, Math.PI * 2); g.fill();
          }
        }

        if (st && st.max && st.hp < st.max * 0.6) {
          drawBurn(g, q.x, q.y, size * 0.45,
            Math.min(1, (0.6 - st.hp / st.max) / 0.5), nowMs, hashStr(id));
        }
      }

      // ---- fire --------------------------------------------------------
      g.save();
      g.globalCompositeOperation = 'lighter';
      for (const sh of allShots) {
        if (!sh.a || !sh.t) continue;
        const w = shotClock(sh, beat.tick);
        if (t < w.launch) continue;
        const sinceHit = beatMs - w.arriveMs;
        if (sinceHit > BURY_MS) continue;
        const flown = Math.min(1, (t - w.launch) / FLIGHT_FRAC);
        const from = posOf(sh.a), to = posOf(sh.t);
        const ang = Math.atan2(to.y - from.y, to.x - from.x);
        const ex = from.x + (to.x - from.x) * flown;
        const ey = from.y + (to.y - from.y) * flown;
        const reach = Math.hypot(ex - from.x, ey - from.y);
        const gap = Math.hypot(to.x - from.x, to.y - from.y);
        const energy = sh.e != null ? sh.e >= 0.5 : (hulls.get(sh.a)?.energy ?? false);
        const streak = Math.min(reach, Math.max(10, Math.min(22, gap * 0.22)));
        const bury = sinceHit > 0 ? Math.min(1, sinceHit / BURY_MS) : 0;
        const tail = energy ? reach : streak * (1 - bury);
        if (tail <= 0.5) continue;
        drawBolt(g,
          ex - Math.cos(ang) * tail, ey - Math.sin(ang) * tail, ex, ey,
          colorOf(hulls.get(sh.a)?.fid ?? null),
          (sh.hit ? 0.9 : 0.4) * (energy ? 1 - bury : 1), energy);
      }
      g.restore();

      // ---- HUD ---------------------------------------------------------
      if (anchor) nameWorld(anchor, bodyPos(anchor, tickF));
      for (const m of moons) nameWorld(m, bodyPos(m, tickF));

      g.textAlign = 'left';
      g.fillStyle = '#8a9fb3'; g.font = '12px system-ui';
      g.fillText(`T+${beat.tick}`, 12, 20);
      const live2 = [...beat.at.values()].reduce((a, s) => a + s.shots.length, 0);
      const hotBodies = [...beat.at.entries()].filter(([, s]) => s.shots.length > 0).length;
      g.fillText(
        `${live2} shots · ${hotBodies} world${hotBodies === 1 ? '' : 's'} under fire`, 12, 36);

      // Standing hulls per side, across the WHOLE campaign — the number
      // that says who is winning a war rather than a skirmish.
      const perSide = new Map<string, { alive: number; total: number }>();
      for (const [, h] of hulls) {
        if (h.kind !== 'ship' || !h.fid) continue;
        const row = perSide.get(h.fid) ?? { alive: 0, total: 0 };
        row.total++;
        if (h.diedTick == null || beat.tick <= h.diedTick) row.alive++;
        perSide.set(h.fid, row);
      }
      let ly = 20;
      for (const [fid, row] of perSide) {
        const f = d.factions[fid];
        const emblem = getEmblemImage(f?.emblem ?? null, f?.color ?? NEUTRAL);
        g.textAlign = 'left';
        if (emblem) g.drawImage(emblem, CANVAS_W - 172, ly - 11, 13, 13);
        else { g.fillStyle = f?.color ?? NEUTRAL; g.fillRect(CANVAS_W - 170, ly - 8, 8, 8); }
        g.fillStyle = '#cfe0ee';
        g.fillText(fitText(g, f?.name ?? fid, 98), CANVAS_W - 153, ly);
        g.textAlign = 'right';
        g.fillStyle = row.alive < row.total ? '#ff8a80' : '#8a9fb3';
        g.fillText(`${row.alive}/${row.total}`, CANVAS_W - 12, ly);
        ly += 16;
      }

      g.textAlign = 'left';
      g.fillStyle = '#9dbdd8'; g.font = '13px system-ui';
      g.fillText(
        `${d.theatre.anchor_name ?? 'system'} — ${d.theatre.battle_count} engagements`,
        12, CANVAS_H - 14);
    };

    handle = requestAnimationFrame(draw);
    return () => { live = false; cancelAnimationFrame(handle); };
  }, [beats, hulls, seats, stars, colorOf, trimOf, d.bodies, d.factions, d.theatre]);

  if (beats.length === 0) {
    return <div style={{ color: NEUTRAL, padding: 8 }}>No frames recorded for this campaign.</div>;
  }
  const idx = clampFrame(pos, beats.length);

  return (
    <div style={{ margin: '10px 0' }}>
      <canvas ref={cv} width={CANVAS_W} height={CANVAS_H}
        style={{ width: '100%', maxWidth: CANVAS_W, borderRadius: 8, border: '1px solid #22303f', display: 'block' }} />
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 6 }}>
        <button
          onClick={() => { if (pos >= beats.length - 1) setPos(0); setPlaying(p => !p); }}
          style={{
            background: '#16273a', border: '1px solid #3d6b96', borderRadius: 5,
            color: '#cfe0ee', padding: '3px 10px', cursor: 'pointer', fontSize: 11,
          }}
        >{playing ? '❚❚ Pause' : '▶ Play campaign'}</button>
        <input
          type="range" min={0} max={Math.max(0.0001, beats.length - 1)} step={0.02}
          value={Number.isFinite(pos) ? pos : 0}
          onChange={e => {
            setPlaying(false);
            const v = Number(e.target.value);
            setPos(Number.isFinite(v) ? v : 0);
          }}
          style={{ flex: 1 }}
          aria-label="Scrub the campaign"
        />
        <span style={{ fontSize: 10, color: NEUTRAL, minWidth: 84, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
          T+{beats[idx].tick} · {idx + 1}/{beats.length}
        </span>
      </div>
    </div>
  );
}
