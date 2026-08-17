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
  drawBurn,
  drawTexturedDisk, drawSphereLighting, drawThrustExhaust,
  drawMuzzleFlash, drawShieldFlare,
  drawFireball, drawImpactFlash, drawBoltGlow, drawTaperedBolt, drawWreck,
  FIREBALL_LIFE_MS,
  ENERGY_COLOR,
} from '../render/fxPrimitives';
import { drawCityCluster, drawStationStructure } from '../render/isoStructures';
import { deriveSecondary } from '../game/colorUtils';
import { toRenderBody, stripGameId } from './bodyIdentity';
import { ShipIconClass, ShipIconVariant } from '../components/ShipIcons';
import type { Body } from '../types';

const NEUTRAL = '#8a9fb3';

// The worlds DO NOT MOVE.
//
// An earlier cut placed every moon where the simulation actually had it
// on that tick, turning through the campaign. It was truthful and it was
// unreadable: the thing a viewer is trying to follow is a fleet, and a
// board where the destinations drift while the ships cross between them
// asks them to track two motions to understand one. Worse, real
// ephemeris bunches — Phobos and Deimos spend most of their time on the
// same side of Mars, which is exactly where the fighting needs room.
//
// So the neighbourhood is laid out for LEGIBILITY: fixed positions,
// spread as far apart as the frame allows, in the true order of distance
// from the anchor. Which world is closer is preserved. Where it happened
// to be on Tuesday is not, and nothing in a recap depends on it.

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
/** How long a wreck stays on the board — about nine ticks. */
const WRECK_LIFE_MS = 9 * 2200;

/** '#rrggbb' -> [r, g, b], so a faction colour can tint a plume. */
function rgbOf(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  if (h.length !== 6) return [255, 180, 90];
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

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
  /** A settlement's built modules, as the buildings JSON (0098). */
  modules?: string | null;
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

/**
 * The HUD, as a designed panel rather than three corners of loose text.
 *
 * What it replaced: default-weight system sans in three unrelated
 * screen corners, faction names ellipsis-truncated in a 200px column
 * with four hundred pixels of empty black beside them, an unlabelled
 * "23/23" nobody could interpret, and a bottom-left caption identical in
 * every frame of the entire playback.
 */
function drawHud(
  g: CanvasRenderingContext2D,
  v: {
    title: string; span: string; engagements: number; tick: number;
    shotsThisBeat: number; worldsHot: number; hideStandings?: boolean;
    sides: Array<{
      name: string; color: string; emblem: string | null;
      alive: number; total: number; onField: number; lost: number;
    }>;
  },
): void {
  // ---- title block, top left --------------------------------------
  g.save();
  g.textAlign = 'left';
  // Covers the title AND the telemetry line beneath it. Backing only the
  // first line left the second one bare over the scene, where a beam
  // passing behind it took the text with it.
  const scrim = g.createLinearGradient(0, 0, 348, 0);
  scrim.addColorStop(0, 'rgba(7, 11, 18, 0.88)');
  scrim.addColorStop(0.58, 'rgba(7, 11, 18, 0.7)');
  scrim.addColorStop(1, 'rgba(7, 11, 18, 0)');
  g.fillStyle = scrim;
  g.fillRect(0, 0, 348, 72);
  const scrimV = g.createLinearGradient(0, 58, 0, 84);
  scrimV.addColorStop(0, 'rgba(7, 11, 18, 0.6)');
  scrimV.addColorStop(1, 'rgba(7, 11, 18, 0)');
  g.fillStyle = scrimV;
  g.fillRect(0, 58, 348, 26);
  g.fillStyle = '#e8f2fb';
  g.font = 'bold 17px system-ui';
  g.fillText(`THE FIGHT FOR ${v.title.toUpperCase()}`, 14, 25);
  g.fillStyle = '#7f9bb3';
  g.font = '11px system-ui';
  g.fillText(
    `${v.span}  ·  ${v.engagements} battle${v.engagements === 1 ? '' : 's'}`, 14, 42);

  // ---- live state, under the title --------------------------------
  g.fillStyle = '#9fc2dc';
  g.font = '12px system-ui';
  const hot = v.worldsHot === 0
    ? 'holding fire'
    : `${v.worldsHot} world${v.worldsHot === 1 ? '' : 's'} under fire`;
  g.fillText(`T+${v.tick}`, 14, 60);
  g.fillStyle = '#7f9bb3';
  g.font = '11px system-ui';
  // Labelled for what it is. The bare number went up and down between
  // beats and read as a broken running total.
  g.fillText(`${v.shotsThisBeat} shots exchanged  ·  ${hot}`, 52, 60);

  // ---- standings, top right ---------------------------------------
  if (v.hideStandings) { g.restore(); return; }
  const rowH = 20;
  const panelW = 268;
  const panelH = 26 + v.sides.length * rowH;
  const px = CANVAS_W - panelW - 12, py = 12;
  g.fillStyle = 'rgba(7, 11, 18, 0.78)';
  g.fillRect(px, py, panelW, panelH);
  g.strokeStyle = 'rgba(70, 100, 130, 0.55)';
  g.lineWidth = 1;
  g.strokeRect(px + 0.5, py + 0.5, panelW - 1, panelH - 1);

  g.fillStyle = '#83a0b8';
  g.font = '10px system-ui';
  g.textAlign = 'left';
  g.fillText('FLEET', px + 12, py + 17);
  g.textAlign = 'right';
  g.fillText('STANDING', px + panelW - 12, py + 17);

  let y = py + 26 + 13;
  for (const s of v.sides) {
    const emblem = getEmblemImage(s.emblem, s.color);
    g.textAlign = 'left';
    // A wiped-out fleet recedes; its emblem was staying at full strength
    // while its name dimmed, making the dead row the loudest in the panel.
    g.globalAlpha = s.alive === 0 ? 0.42 : 1;
    if (emblem) g.drawImage(emblem, px + 11, y - 11, 13, 13);
    else { g.fillStyle = s.color; g.fillRect(px + 12, y - 9, 9, 9); }
    g.globalAlpha = 1;
    g.fillStyle = s.alive === 0 ? '#6c7c8a' : '#dbe8f4';
    g.font = '12px system-ui';
    // The panel is sized to the names now, so nothing truncates.
    g.fillText(fitText(g, s.name, panelW - 96), px + 30, y);
    g.textAlign = 'right';
    g.fillStyle = s.alive === 0 ? '#ff6f61'
      : s.alive < s.total * 0.6 ? '#ffb0a8' : '#cfe0ee';
    g.font = '12px system-ui';
    g.fillText(`${s.alive}/${s.total}`, px + panelW - 12, y);
    if (s.alive === 0) {
      // A wiped-out fleet should look wiped out, not merely small.
      g.font = '12px system-ui';
      const strikeW = g.measureText(fitText(g, s.name, panelW - 96)).width;
      g.strokeStyle = 'rgba(255, 111, 97, 0.75)';
      g.lineWidth = 1.2;
      g.beginPath();
      g.moveTo(px + 28, y - 4); g.lineTo(px + 30 + strikeW + 2, y - 4);
      g.stroke();
    }
    y += rowH;
  }
  g.restore();
}
/**
 * Exported so a payload can be rendered without going through the fetch
 * — the campaign view is worth being able to drive from a fixture.
 */
export function TheatreCanvas({ d }: { d: TheatreDetail }) {
  const cv = useRef<HTMLCanvasElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [pos, setPos] = useState(0);
  const posRef = useRef(0);
  posRef.current = pos;
  const raf = useRef<number | null>(null);
  const last = useRef(0);
  /** Eased camera. Lives in a ref because it settles across frames and
   *  must not drive React renders. */
  const cam = useRef({ x: CANVAS_W / 2, y: CANVAS_H / 2, k: 1, ready: false });

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
      energy: boolean; diedTick: number | null; mods: string | null;
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
          mods: p.modules ?? null,
        });
      }
    }
    return m;
  }, [d.battles]);

  /**
   * The campaign on one clock, plus who joined and who pulled out.
   */
  const { beats, arrived, left } = useMemo(() => {
    const byTick = new Map<number, Beat>();
    const firstAt = new Map<string, number>();
    const lastAt = new Map<string, number>();
    const fixed = new Set<string>();
    for (const b of d.battles) {
      for (const f of b.frames) {
        const bodyId = f.body_id ?? b.body_id ?? 'deep';
        let beat = byTick.get(f.tick);
        if (!beat) { beat = { tick: f.tick, at: new Map(), where: new Map() }; byTick.set(f.tick, beat); }
        const slot = beat.at.get(bodyId) ?? { roster: [], shots: [] };
        slot.roster = slot.roster.concat(f.roster);
        slot.shots = slot.shots.concat(f.shot_log);
        beat.at.set(bodyId, slot);
        for (const r of f.roster) {
          beat.where.set(r.id, bodyId);
          if (!firstAt.has(r.id)) firstAt.set(r.id, f.tick);
          lastAt.set(r.id, f.tick);
          if (r.kind && r.kind !== 'ship') fixed.add(r.id);
        }
      }
    }
    for (const [id, h] of hulls) if (h.kind !== 'ship') fixed.add(id);

    const out = [...byTick.values()].sort((a, b) => a.tick - b.tick);
    const held = new Map<string, string>();
    for (const beat of out) {
      for (const [id, body] of beat.where) held.set(id, body);
      for (const [id, body] of held) {
        if (beat.where.has(id)) continue;
        const h = hulls.get(id);
        if (h?.diedTick != null && beat.tick > h.diedTick) continue;
        if (beat.tick > (lastAt.get(id) ?? Infinity)) continue;
        beat.where.set(id, body);
      }
    }

    const openTick = out[0]?.tick ?? 0;
    const closeTick = out[out.length - 1]?.tick ?? 0;
    const arrivedM = new Map<string, number>();
    const leftM = new Map<string, number>();
    for (const [id, t] of firstAt) {
      if (t > openTick && !fixed.has(id)) arrivedM.set(id, t);
    }
    for (const [id, t] of lastAt) {
      const h = hulls.get(id);
      const diedHere = h?.diedTick != null && h.diedTick <= t;
      if (t < closeTick && !diedHere && !fixed.has(id)) leftM.set(id, t);
    }
    return { beats: out, arrived: arrivedM, left: leftM };
  }, [d.battles, hulls]);

  /**
   * How long each beat is held.
   *
   * Every tick getting the same 2.2 seconds gave the campaign no shape:
   * the beat where two hulls die read exactly like the beat where
   * everyone missed. Quiet beats now run short and the costly ones are
   * held. Deliberately not proportional — most beats in a real campaign
   * cost somebody something, so holding on every one of them would just
   * be a slower flat rhythm.
   */
  const weights = useMemo(() => beats.map((b) => {
    let kills = 0;
    for (const [, slot] of b.at) for (const r of slot.roster) if (r.dead === 1) kills++;
    if (kills >= 2) return 1.55;
    if (kills === 1) return 1.15;
    let shots = 0;
    for (const [, slot] of b.at) shots += slot.shots.length;
    return shots > 0 ? 0.82 : 0.6;
  }), [beats]);

  /** Which factions were eliminated, and on which beat. The largest
   *  thing that can happen to a player in a campaign, and it used to be
   *  a digit changing in a corner. */
  const eliminated = useMemo(() => {
    const m = new Map<number, string[]>();
    const total = new Map<string, number>();
    for (const [, h] of hulls) {
      if (h.kind !== 'ship' || !h.fid) continue;
      total.set(h.fid, (total.get(h.fid) ?? 0) + 1);
    }
    for (const beat of beats) {
      for (const [fid, n] of total) {
        let alive = 0;
        for (const [, h] of hulls) {
          if (h.kind !== 'ship' || h.fid !== fid) continue;
          if (h.diedTick == null || beat.tick < h.diedTick) alive++;
        }
        const before = m.get(-1) ?? [];
        void before; void n;
        if (alive === 0 && !(m.get(-2) ?? []).includes(fid)) {
          const at = m.get(beat.tick) ?? [];
          at.push(fid);
          m.set(beat.tick, at);
          m.set(-2, [...(m.get(-2) ?? []), fid]);
        }
      }
    }
    m.delete(-1); m.delete(-2);
    return m;
  }, [beats, hulls]);

  const armedIds = useMemo(() => {
    const set = new Set<string>();
    for (const b of d.battles) {
      for (const f of b.frames) for (const sh of f.shot_log) if (sh.a) set.add(sh.a);
    }
    return set;
  }, [d.battles]);

  /**
   * The worlds that were actually fought over, plus the anchor.
   *
   * The whole neighbourhood used to be on the board. A world that never
   * hosts a shot is on screen only for the establishing wide — the
   * camera closes on the fighting and never returns to it — and three
   * reviewers in a row called that out as a body being introduced,
   * named, and then silently deleted from the sequence. It also forced
   * the opening wide out far enough to leave a third of the frame
   * empty. A theatre is the worlds the war touched.
   */
  const renderBodies = useMemo(() => {
    const fought = new Set<string>();
    for (const b of d.battles) {
      for (const f of b.frames ?? []) {
        if (f.body_id && (f.shots > 0 || (f.roster?.length ?? 0) > 0)) {
          fought.add(stripGameId(f.body_id) ?? f.body_id);
        }
      }
    }
    const anchorBare = stripGameId(d.theatre.anchor_body_id) ?? '';
    const all = d.bodies.map(b => toRenderBody(b));
    const keep = all.filter(b => fought.has(b.id) || b.id === anchorBare);
    return keep.length ? keep : all;
  }, [d.bodies, d.battles, d.theatre.anchor_body_id]);

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

  useEffect(() => {
    for (const [, h] of hulls) {
      const cls = iconClassOf(h.cls);
      if (!cls) continue;
      getShipIconImage(cls, colorOf(h.fid), h.variant, trimOf(h.fid));
    }
  }, [hulls, colorOf, trimOf]);

  // Playback advances at a rate the BEAT sets, so a costly tick lingers.
  useEffect(() => {
    if (!playing) return;
    last.current = performance.now();
    const step = (now: number) => {
      const dt = now - last.current;
      last.current = now;
      setPos(p => {
        const w = weights[clampFrame(p, weights.length)] ?? 1;
        const next = p + dt / (TICK_MS * w);
        if (next >= beats.length - 1 + 0.98) { setPlaying(false); return beats.length - 1 + 0.98; }
        return next;
      });
      raf.current = requestAnimationFrame(step);
    };
    raf.current = requestAnimationFrame(step);
    return () => { if (raf.current) cancelAnimationFrame(raf.current); };
  }, [playing, beats.length, weights]);

  useEffect(() => {
    const canvas = cv.current;
    if (!canvas) return;
    const g = canvas.getContext('2d');
    if (!g) return;
    let live = true;
    let handle = 0;
    let prevMs = 0;

    const anchorId = d.theatre.anchor_body_id;
    const anchor = renderBodies.find(
      b => b.id === anchorId || `${b.id}` === `${anchorId}`.split(':').pop()) ?? renderBodies[0];
    const moons = renderBodies.filter(b => b.id !== anchor?.id);

    const SPAN = Math.min(CANVAS_W, CANVAS_H) * 0.42;
    const cx = CANVAS_W * 0.46, cy = CANVAS_H * 0.50;
    // Scale hierarchy, restored. Radii are proportional across a wide
    // range instead of clamped into one narrow band, where a moon came
    // out the same size as its primary and a warship came out bigger
    // than the moon it was orbiting.
    const anchorR = Math.max(34, Math.min(74, 22 + (Number(anchor?.radius) || 2) * 14));
    const moonR = (b: TBody) => Math.max(7, Math.min(22, 4 + (Number(b.radius) || 1) * 9));
    const SQUASH = 0.78;
    const ORBIT_FLOOR = anchorR + GUARD_RING * 2 + 30;

    const ordered = [...moons].sort(
      (a, b) => (Number(a.orbitRadius) || 0) - (Number(b.orbitRadius) || 0));
    const phase = ((hashStr(anchor?.id ?? 'anchor') % 1000) / 1000) * Math.PI * 2;
    const placed = new Map<string, { x: number; y: number; r: number; rx: number }>();
    ordered.forEach((m, k) => {
      const n = Math.max(1, ordered.length);
      const rx = n === 1
        ? (ORBIT_FLOOR + SPAN) / 2
        : ORBIT_FLOOR + (k / (n - 1)) * Math.max(0, SPAN - ORBIT_FLOOR);
      const a = phase + ((k + 0.5) / n) * Math.PI * 2;
      placed.set(m.id, {
        x: cx + Math.cos(a) * rx, y: cy + Math.sin(a) * rx * SQUASH,
        r: moonR(m), rx,
      });
    });

    const bodyPos = (b: TBody | undefined) => {
      if (!b || b.id === anchor?.id) return { x: cx, y: cy, r: anchorR };
      const p = placed.get(b.id);
      if (!p) return { x: cx, y: cy, r: anchorR };
      return { x: p.x, y: p.y, r: p.r };
    };
    const bodyById = new Map<string, typeof renderBodies[number]>();
    for (let k = 0; k < renderBodies.length; k++) {
      const rb = renderBodies[k];
      bodyById.set(rb.id, rb);
      bodyById.set(d.bodies[k].id, rb);
    }

    const draw = (nowMs: number) => {
      if (!live) return;
      handle = requestAnimationFrame(draw);
      const dtMs = prevMs ? Math.min(80, nowMs - prevMs) : 16;
      prevMs = nowMs;

      const i = clampFrame(posRef.current, beats.length);
      const t = Math.min(1, Math.max(0, posRef.current - i));
      const beat = beats[i];
      if (!beat) return;
      const nextBeat = beats[Math.min(beats.length - 1, i + 1)];
      const beatMs = t * TICK_MS;

      // ---- camera ----------------------------------------------------
      // Frame the worlds that are actually under fire. A locked-off wide
      // of a 200px sliver on an 860px canvas is a diagram; this is the
      // difference between watching a battle and reading one.
      const hotBodies: string[] = [];
      let allShotCount = 0;
      for (const [bid, slot] of beat.at) {
        allShotCount += slot.shots.length;
        if (slot.shots.length > 0) hotBodies.push(bid);
      }
      // Both ends of every shot are in the shot. Framing on the worlds
      // that were FIRED AT let a shooter one world over sit outside the
      // canvas, so its beams arrived from off-frame with nothing attached
      // to them -- and at the widest moment an entire second engagement
      // was sliced off the right edge.
      const focus = new Set(hotBodies.length ? hotBodies : [...beat.at.keys()]);
      for (const [, slot] of beat.at) {
        for (const sh of slot.shots) {
          for (const hid of [sh.a, sh.t]) {
            const at = hid ? beat.where.get(hid) : undefined;
            if (at) focus.add(at);
          }
        }
      }
      const focusIds = [...focus];
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const bid of focusIds) {
        const p = bodyPos(bodyById.get(bid));
        const pad = p.r + GUARD_RING + 34;
        minX = Math.min(minX, p.x - pad); maxX = Math.max(maxX, p.x + pad);
        minY = Math.min(minY, p.y - pad); maxY = Math.max(maxY, p.y + pad);
      }
      if (!Number.isFinite(minX)) { minX = 0; minY = 0; maxX = CANVAS_W; maxY = CANVAS_H; }
      // Establishing wide on the first beat and the last: a campaign
      // should open and close on the whole system.
      const wide = i === 0;
      const boxW = Math.max(80, maxX - minX), boxH = Math.max(80, maxY - minY);
      const wantK = wide ? 1.06
        : Math.max(1, Math.min(3.2, Math.min(CANVAS_W / boxW, CANVAS_H / boxH) * 0.84));
      // Compose, do not merely survey. Centring the subject left the
      // bottom quarter and the right third permanently empty and made
      // every frame the same symmetrical plate. The subject sits low and
      // left of centre — off the thirds, clear of the standings panel,
      // with the dead space above it where the HUD already lives.
      // Screen = (world - cam) * K + centre, so a LARGER cam coordinate
      // moves the subject left and up. The subject wants to sit low and
      // left of centre: the title block owns the top-left and the
      // standings the top-right, so the empty quarter belongs above it.
      // Heat pushes in. A tick with twenty shots in it should not be
      // framed exactly like a tick with three.
      const heat = Math.min(1, allShotCount / 16);
      const kHot = wide ? wantK : wantK * (1 + 0.2 * heat * heat);
      const OFF_X = wide ? 0 : 34 / kHot;
      const OFF_Y = wide ? 0 : -30 / kHot;
      // A slow drift, always. Without it the starfield and the worlds are
      // pixel-identical from the first beat to the last and the whole
      // thing reads as a still with sprites on top.
      const driftX = Math.sin(nowMs / 5300) * 11 / kHot;
      const driftY = Math.cos(nowMs / 6700) * 7 / kHot;
      const wantX = (wide ? CANVAS_W / 2 : (minX + maxX) / 2) + OFF_X + driftX;
      const wantY = (wide ? CANVAS_H / 2 : (minY + maxY) / 2) + OFF_Y + driftY;
      if (!cam.current.ready) {
        cam.current = { x: wantX, y: wantY, k: kHot, ready: true };
      } else {
        // Ease, never cut. A hard cut on a board this abstract reads as
        // a glitch; a settle reads as a camera.
        const e = 1 - Math.exp(-Math.max(0, Math.min(400, dtMs)) / 260);
        cam.current.x += (wantX - cam.current.x) * e;
        cam.current.y += (wantY - cam.current.y) * e;
        cam.current.k += (kHot - cam.current.k) * e;
      }
      const K = cam.current.k;
      const toScreenX = (x: number) => (x - cam.current.x) * K + CANVAS_W / 2;
      const toScreenY = (y: number) => (y - cam.current.y) * K + CANVAS_H / 2;

      g.fillStyle = '#05070c';
      g.fillRect(0, 0, CANVAS_W, CANVAS_H);
      // Stars sit behind the camera move and drift a little against it,
      // which is the only depth cue a flat board gets.
      for (const s of stars) {
        const px = (s.x - cam.current.x * 0.06) % CANVAS_W;
        g.fillStyle = `rgba(203, 225, 245, ${(s.a * (0.75 + 0.25 * Math.sin(nowMs / 900 + s.ph))).toFixed(3)})`;
        g.beginPath();
        g.arc(px < 0 ? px + CANVAS_W : px, s.y, s.r, 0, Math.PI * 2);
        g.fill();
      }

      // Everything below is drawn in WORLD space and transformed.
      g.save();
      g.translate(CANVAS_W / 2, CANVAS_H / 2);
      g.scale(K, K);
      g.translate(-cam.current.x, -cam.current.y);

      /** Labels and callouts are collected here and drawn after the
       *  transform is released, at a fixed size — text that scales with
       *  a camera is text that is either tiny or enormous. */
      const labels: Array<{ x: number; y: number; s: string; c: string; size: number }> = [];
      const callouts: Array<{
        x: number; y: number; head: string; sub: string; a: number; col: string;
      }> = [];

      const paintWorld = (b: TBody, p: { x: number; y: number; r: number }) => {
        const tf = terraformFraction(b as unknown as Body, beat.tick);
        const tex = tf >= 1
          ? (getTerraformedTexture(b as unknown as Body) ?? getPlanetTexture(b as unknown as Body))
          : getPlanetTexture(b as unknown as Body);
        if (tex) {
          // Drift 0. The SURFACE texture does not tile horizontally —
          // only the cloud layer is painted with wrap copies — so
          // scrolling it drags a hard pole-to-pole join across the disc.
          // Invisible at map size; a seam every reviewer named once the
          // camera pushed in to 220px.
          drawTexturedDisk(g, tex, p.x, p.y, p.r, 0);
        } else {
          g.fillStyle = b.color || '#101d2b';
          g.beginPath(); g.arc(p.x, p.y, p.r, 0, Math.PI * 2); g.fill();
        }
        drawSphereLighting(g, p.x, p.y, p.r, LIGHT_X, LIGHT_Y);
        // Ownership as a soft pip on the limb rather than a ring in the
        // faction's colour around the whole world — map furniture should
        // not wear a player's identity.
        // Ownership is carried by the world's name, not by an unlabelled
        // dot on the limb -- which every reviewer read as a stuck pixel.
      };

      /** How much of this world is in frame, 0..1. A body sliced by the
       *  frame edge with its label suppressed reads as a broken asset —
       *  three reviewers called Deimos exactly that — so a world fades
       *  out as it leaves rather than being amputated by the border. */
      const framing = (p: { x: number; y: number; r: number }) => {
        const sx = toScreenX(p.x), sy = toScreenY(p.y), sr = p.r * K;
        const m = Math.min(sx - sr, CANVAS_W - sx - sr, sy - sr, CANVAS_H - sy - sr);
        if (m >= 0) return 1;
        return Math.max(0, 1 + m / (sr * 0.9 + 1));
      };
      const shown = new Map<string, number>();
      const paintFramed = (b: TBody) => {
        const p = bodyPos(b);
        const f = framing(p);
        shown.set(b.id, f);
        if (f <= 0.02) return;
        g.save();
        g.globalAlpha = f;
        paintWorld(b, p);
        g.restore();
      };
      if (anchor) paintFramed(anchor);
      for (const m of moons) paintFramed(m);

      const guardAngle = (hullId: string) => (seats.get(hullId) ?? 0) + nowMs * 0.00004;
      const stationAt = (bodyId: string | undefined, hullId: string) => {
        const b = bodyId ? bodyById.get(bodyId) : undefined;
        const p = bodyPos(b);
        const a = guardAngle(hullId);
        // Hulls fan across two lanes so a crowded world does not become
        // one overlapping smear.
        const lane = (hashStr(hullId) % 3) * 13;
        const ring = p.r + GUARD_RING + lane;
        return { x: p.x + Math.cos(a) * ring, y: p.y + Math.sin(a) * ring * TILT };
      };
      const offSystem = (p: { x: number; y: number }) => {
        const dx = p.x - cx, dy = p.y - cy;
        const len = Math.max(1, Math.hypot(dx, dy));
        const far = SPAN * 1.9 + 120;
        return { x: cx + (dx / len) * far, y: cy + (dy / len) * far * TILT };
      };

      const posOf = (id: string) => {
        const here = beat.where.get(id);
        const a = stationAt(here, id);
        const glide = t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) * (1 - t);
        if (arrived.get(id) === beat.tick) {
          const far = offSystem(a);
          const u = 1 - (1 - t) * (1 - t);
          return {
            x: far.x + (a.x - far.x) * u, y: far.y + (a.y - far.y) * u,
            moving: true as const, from: far, to: a, burn: Math.max(0, 1 - t * t * 1.15),
          };
        }
        if (left.get(id) === beat.tick) {
          const far = offSystem(a);
          const u = t * t;
          return {
            x: a.x + (far.x - a.x) * u, y: a.y + (far.y - a.y) * u,
            moving: true as const, from: a, to: far, burn: Math.min(1, 0.25 + t * 0.95),
          };
        }
        const to = nextBeat.where.get(id) ?? here;
        if (!to || to === here) {
          return { ...a, moving: false as const, from: a, to: a, burn: 0 };
        }
        const b = stationAt(to, id);
        return {
          x: a.x + (b.x - a.x) * glide, y: a.y + (b.y - a.y) * glide,
          moving: true as const, from: a, to: b,
          burn: Math.max(0, 1 - Math.abs(t - 0.5) * 2) * 0.9 + 0.1,
        };
      };

      const shotClock = (sh: TFrame['shot_log'][number], tick: number) => {
        const launch = ((hashStr(`${sh.a ?? ''}>${sh.t ?? ''}@${tick}`) % 997) / 997) * LAUNCH_SPREAD;
        return { launch, arriveMs: (launch + FLIGHT_FRAC) * TICK_MS };
      };
      const allShots: TFrame['shot_log'] = [];
      for (const [, slot] of beat.at) for (const sh of slot.shots) allShots.push(sh);
      const landed = new Map<string, number>();
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
      const killAt = (LAUNCH_SPREAD / 2 + FLIGHT_FRAC) * TICK_MS;

      // ---- combatants -------------------------------------------------
      // Where each hull was last on the board. A hull leaves the roster
      // the tick after it dies, so this is the only record of where its
      // wreck belongs.
      const lastSeenAt = new Map<string, string>();
      for (let n = 0; n <= i; n++) {
        for (const [bid, slot] of beats[n].at) {
          for (const r of slot.roster) lastSeenAt.set(r.id, bid);
        }
      }
      const blasts: Array<{ x: number; y: number; k: number; id: string; s: number }> = [];
      const wrecks: Array<{
        x: number; y: number; size: number; age: number; id: string; col: string;
      }> = [];
      const drawn = new Set<string>();
      for (const [id, bodyId] of beat.where) {
        if (drawn.has(id)) continue;
        drawn.add(id);
        const h = hulls.get(id);
        if (!h) continue;
        if (h.diedTick != null && beat.tick > h.diedTick) {
          // A kill site stays a kill site.
          const q = stationAt(bodyId, id);
          const age = (beat.tick - h.diedTick) * TICK_MS + (beatMs - killAt);
          if (age < WRECK_LIFE_MS) {
            wrecks.push({
              x: q.x, y: q.y, size: Math.max(13, shipPx(h.cls) * 0.95),
              age, id, col: colorOf(h.fid),
            });
          }
          continue;
        }
        const st = hpNow.get(id);
        const q = posOf(id);
        const col = colorOf(h.fid);
        const bp = bodyPos(bodyById.get(bodyId));
        // A warship is never bigger than the world it is orbiting.
        const size = h.kind === 'ship'
          ? Math.min(shipPx(h.cls), Math.max(9, bp.r * 0.72))
          : Math.min(22, Math.max(11, bp.r * 0.5));

        if (st?.dead && beatMs > killAt) {
          const since = beatMs - killAt;
          // A ship coming apart, at close range. The map's blast reads as
          // a pop at forty pixels and as a wireframe gizmo at two
          // hundred — this is the version with a fireball in it.
          if (since < FIREBALL_LIFE_MS) {
            blasts.push({ x: q.x, y: q.y, k: since / FIREBALL_LIFE_MS, id,
              s: Math.max(0.9, size / 15) });
          }
          // The wreck starts here, inside the fire, not on the next beat.
          wrecks.push({
            x: q.x, y: q.y, size: Math.max(13, shipPx(h.cls) * 0.95),
            age: since, id, col,
          });
          if (since > 90 && since < 1700) {
            const killer = h.fid;
            void killer;
            callouts.push({
              x: q.x, y: q.y,
              head: `${h.name ?? 'hull'} lost`,
              sub: d.factions[h.fid ?? '']?.name ?? '',
              // The spine wears the colour of the side that lost the hull.
              // One red bar on every card meant the only colour cue a card
              // carried said nothing.
              col,
              a: Math.min(1, (since - 90) / 200) * (1 - Math.max(0, (since - 1200) / 500)),
            });
          }
          continue;
        }

        if (h.kind === 'city') {
          const fa = 0.45 + ((hashStr(id) % 1000) / 1000) * 2.2;
          g.save();
          g.translate(bp.x + Math.cos(fa) * bp.r * 0.5, bp.y + Math.sin(fa) * bp.r * 0.5 * SQUASH);
          g.scale(0.42, 0.42);
          drawCityCluster(g, { population: 4 } as never, col);
          g.restore();
        } else if (h.kind === 'station') {
          let mods: Record<string, number> = {};
          try { mods = h.mods ? JSON.parse(h.mods) : {}; } catch { /* bare ring */ }
          const onPx = size * 0.55 * K;
          const tiny = onPx < 15;
          if (tiny) {
            // Below this the rig's panels and struts land on sub-pixel
            // strokes and read as a smear of garbled glyphs.
            g.save();
            // A hull with two panels off it. The earlier hexagon read as
            // an unlabelled marker rather than as a structure.
            const hw = Math.max(2.6, size * 0.3), hh = Math.max(1.6, size * 0.17);
            g.fillStyle = col;
            g.fillRect(q.x - hw * 0.42, q.y - hh, hw * 0.84, hh * 2);
            g.strokeStyle = col;
            g.lineWidth = 1;
            g.beginPath();
            g.moveTo(q.x - hw * 1.35, q.y); g.lineTo(q.x - hw * 0.42, q.y);
            g.moveTo(q.x + hw * 0.42, q.y); g.lineTo(q.x + hw * 1.35, q.y);
            g.stroke();
            g.globalAlpha = 0.75;
            g.fillRect(q.x - hw * 1.35, q.y - hh * 0.7, hw * 0.62, hh * 1.4);
            g.fillRect(q.x + hw * 0.73, q.y - hh * 0.7, hw * 0.62, hh * 1.4);
            g.globalAlpha = 1;
            g.restore();
          } else {
          g.save();
          g.translate(q.x, q.y);
          g.scale(0.55, 0.55);
          drawStationStructure(g, {
            weaponsLevel: Math.max(Number(mods.weapons) || 0, armedIds.has(id) ? 1 : 0),
            shipyardLevel: Number(mods.shipyard) || 0,
            labLevel: Number(mods.lab) || 0,
            thrustersLevel: Number(mods.thrusters) || 0,
            factionColor: col, builds: [], nowMs,
          });
          g.restore();
          }
          // The rig is grey metal whoever owns it, so it read as nobody's.
          if (tiny) { /* the mark carries its own identity; no ring */ } else {
          g.save();
          g.globalAlpha = 0.9;
          g.strokeStyle = col;
          g.lineWidth = 1.5;
          g.lineCap = 'round';
          const rr = size * 0.8;
          for (let n = 0; n < 4; n++) {
            const a0 = n * (Math.PI / 2) + Math.PI / 4 - 0.3;
            g.beginPath();
            g.arc(q.x, q.y, rr, a0, a0 + 0.6);
            g.stroke();
          }
          g.restore();
          }
        } else {
          const ga = guardAngle(id);
          const heading = q.moving
            ? Math.atan2(q.to.y - q.from.y, q.to.x - q.from.x)
            : Math.atan2(Math.cos(ga) * TILT, -Math.sin(ga));
          const burn = q.moving ? q.burn
            // Station-keeping. A hull in orbit is under power, and a fleet
            // that goes dark the moment it stops crossing reads as a set of
            // decals rather than as ships.
            : 0.2 + 0.06 * Math.sin(nowMs / 420 + hashStr(id) % 100);
          if (burn > 0.02) {
            const dir = { x: Math.cos(heading), y: Math.sin(heading) };
            drawThrustExhaust(g,
              { x: q.x - dir.x * size * 0.42, y: q.y - dir.y * size * 0.42 },
              dir, size, burn, h.cls ?? undefined, rgbOf(col));
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
            // A hull whose icon has not finished generating still has to
            // read as a hull. The old fallback was a plain disc, which
            // two reviewers picked out as the only colourless objects on
            // screen and took for placeholder art.
            g.save();
            g.translate(q.x, q.y);
            g.rotate(heading);
            g.fillStyle = col;
            g.beginPath();
            g.moveTo(size * 0.5, 0);
            g.lineTo(-size * 0.32, size * 0.3);
            g.lineTo(-size * 0.16, 0);
            g.lineTo(-size * 0.32, -size * 0.3);
            g.closePath();
            g.fill();
            g.restore();
          }
        }

        if (st && st.max && st.hp < st.max * 0.8) {
          drawBurn(g, q.x, q.y, size * 0.62,
            Math.min(1, (0.8 - st.hp / st.max) / 0.55), nowMs, hashStr(id));
        }
      }

      // ---- what is left of the dead --------------------------------------
      for (const [id, h] of hulls) {
        if (h.diedTick == null || beat.tick <= h.diedTick) continue;
        if (drawn.has(id) || h.kind !== 'ship') continue;
        const bid = lastSeenAt.get(id);
        if (!bid) continue;
        // Age measured from the instant of the kill, on the same clock the
        // blast used, so the two are one continuous event.
        const age = (beat.tick - h.diedTick) * TICK_MS + (beatMs - killAt);
        if (age >= WRECK_LIFE_MS) continue;
        const q = stationAt(bid, id);
        wrecks.push({
          x: q.x, y: q.y, size: Math.max(13, shipPx(h.cls) * 0.95),
          age, id, col: colorOf(h.fid),
        });
      }
      // Debris under the fire: it is thrown from inside the blast and
      // emerges as the core fades.
      for (const w of wrecks) {
        drawWreck(g, w.x, w.y, w.size, w.age, WRECK_LIFE_MS, w.id, w.col);
      }

      // ---- detonations, over every hull ----------------------------------
      g.save();
      g.globalCompositeOperation = 'lighter';
      for (const b of blasts) drawFireball(g, b.x, b.y, b.k, b.id, b.s);
      g.restore();

      // ---- fire ---------------------------------------------------------
      // Fire is drawn OVER the worlds, deliberately. An earlier cut
      // punched every body out of this layer so a shot vanished behind a
      // limb; tracers and beams now stay on top of whatever they cross.
      g.save();
      g.globalCompositeOperation = 'lighter';
      for (const sh of allShots) {
        if (!sh.a || !sh.t) continue;
        const shooter = hulls.get(sh.a);
        if (shooter?.diedTick != null && beat.tick > shooter.diedTick) continue;
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
        // A THIRD world in the way blocks the shot outright.
        //
        // Deliberately not "is any world between them". Two hulls in
        // orbit around the SAME world are on opposite sides of it as
        // often as not, so that rule silently dropped most of the
        // battle: the shot counter ticked over a sky with no fire in
        // it. Fire between hulls at one world is drawn and clipped by
        // that world's disc; only a shot that would have to cross a
        // different world is dropped.
        if (sh.a && sh.t) {
          const aAt = beat.where.get(sh.a), tAt = beat.where.get(sh.t);
          if (aAt && tAt && aAt !== tAt) {
            const mx = (from.x + to.x) / 2, my = (from.y + to.y) / 2;
            let blocked = false;
            for (const b of renderBodies) {
              if (b.id === aAt || b.id === tAt) continue;
              const bq = bodyPos(b);
              if (Math.hypot(mx - bq.x, my - bq.y) < bq.r) { blocked = true; break; }
            }
            if (blocked) continue;
          }
        }
        const energy = sh.e != null ? sh.e >= 0.5 : (hulls.get(sh.a)?.energy ?? false);
        const streak = Math.min(reach, Math.max(12, Math.min(26, gap * 0.24)));
        const bury = sinceHit > 0 ? Math.min(1, sinceHit / BURY_MS) : 0;
        const lance = Math.min(reach, Math.max(48, Math.min(118, gap * 0.34)));
        const tail = energy ? lance * (1 - bury * 0.55) : streak * (1 - bury);
        if (tail <= 0.5) continue;
        const bcol = colorOf(hulls.get(sh.a)?.fid ?? null);
        const balpha = (sh.hit ? 0.95 : 0.4) * (energy ? 1 - bury : 1);
        drawBoltGlow(g, ex - Math.cos(ang) * tail, ey - Math.sin(ang) * tail,
          ex, ey, bcol, balpha, energy, 0.6);
        drawTaperedBolt(g, ex - Math.cos(ang) * tail, ey - Math.sin(ang) * tail,
          ex, ey, bcol, balpha, energy);

        // Muzzle and impact, held long enough to actually be seen. At
        // 130ms they existed and nobody ever caught one.
        const sinceFire = beatMs - w.launch * TICK_MS;
        if (sinceFire >= 0 && sinceFire < 440) {
          drawMuzzleFlash(g, from.x, from.y, ang,
            energy ? ENERGY_COLOR : colorOf(hulls.get(sh.a)?.fid ?? null),
            (1 - sinceFire / 440) * 0.95, 1.25);
        }
        // Every round that lands leaves a mark. Reviewers counted beams
        // that simply stopped at their target with nothing happening.
        if (sh.hit && sinceHit >= 0 && sinceHit < 540) {
          const held = (sh.abs ?? 0) > (sh.dmg || 0) * 0.5;
          const tint = held ? '#8fd8ff' : (energy ? '#bfe9ff' : '#ffcf8a');
          drawImpactFlash(g, to.x, to.y, sinceHit / 540, tint, held ? 1.35 : 1.15);
          if (!sh.kill) {
            drawShieldFlare(g, to.x, to.y, 9, ang + Math.PI,
              (1 - sinceHit / 540) * 0.55, tint);
          }
        }
      }
      g.restore();

      g.restore();   // <-- camera

      // ---- edge fade ---------------------------------------------------
      // Ships were being cut in half by the canvas border. A soft border
      // reads as the frame ending; a hard one reads as an asset breaking.
      {
        const F = 30;
        const edges: Array<[number, number, number, number, number[]]> = [
          [0, 0, F, CANVAS_H, [0, 0, F, 0]],
          [CANVAS_W - F, 0, F, CANVAS_H, [CANVAS_W, 0, CANVAS_W - F, 0]],
          [0, 0, CANVAS_W, F, [0, 0, 0, F]],
          [0, CANVAS_H - F, CANVAS_W, F, [0, CANVAS_H, 0, CANVAS_H - F]],
        ];
        for (const [rx, ry, rw, rh, ln] of edges) {
          const gr = g.createLinearGradient(ln[0], ln[1], ln[2], ln[3]);
          gr.addColorStop(0, 'rgba(7, 11, 18, 0.92)');
          gr.addColorStop(1, 'rgba(7, 11, 18, 0)');
          g.fillStyle = gr;
          g.fillRect(rx, ry, rw, rh);
        }
      }

      // ---- overlay: labels and callouts, at a fixed size ---------------
      g.textAlign = 'center';
      g.save();
      // Every label carries its own ground. A name printed straight onto
      // the scene disappears the moment a beam passes behind it.
      g.shadowColor = 'rgba(4, 7, 12, 0.95)';
      g.shadowBlur = 5;
      for (const l of labels) {
        g.font = `${l.size}px system-ui`;
        g.fillStyle = l.c;
        g.fillText(l.s, toScreenX(l.x), toScreenY(l.y));
      }
      g.restore();
      // World names, over everything, with a plate so a hull cannot bury
      // the name of the place being fought over.
      const nameWorld = (b: TBody) => {
        const p = bodyPos(b);
        const sx = toScreenX(p.x), sy = toScreenY(p.y + p.r) + 16;
        // A world the camera has cropped gets no label: half a name
        // hanging off the frame edge reads as a rendering fault.
        if (sx < 46 || sx > CANVAS_W - 46 || sy < 24 || sy > CANVAS_H - 10) return;
        const hot = (beat.at.get(b.id)?.shots.length ?? 0) > 0
          || (beat.at.get(d.bodies.find(x => toRenderBody(x).id === b.id)?.id ?? '')?.shots.length ?? 0) > 0;
        g.font = '12px system-ui';
        const w = g.measureText(b.name).width;
        const own = b.ownerFactionId ? colorOf(b.ownerFactionId) : null;
        const chip = own ? 9 : 0;
        g.fillStyle = 'rgba(6, 10, 16, 0.85)';
        g.fillRect(sx - w / 2 - 5 - chip, sy - 11, w + 10 + chip, 15);
        if (own) {
          g.fillStyle = own;
          g.fillRect(sx - w / 2 - chip - 1, sy - 8, 4, 9);
        }
        g.fillStyle = hot ? '#ffd07a' : '#9fc2dc';
        g.fillText(b.name, sx + chip / 2, sy);
      };
      if (anchor) nameWorld(anchor);
      for (const m of moons) nameWorld(m);

      // A ship dying is the dramatic payload of the whole piece, and it
      // was rendering as the least legible thing on screen: translucent
      // grey text that read as sitting BEHIND the planet, two cards
      // overprinted on each other, one colliding with the HUD subtitle.
      // Opaque, stacked, kept out of the HUD's rows, with a leader down
      // to the hull it belongs to.
      const taken: Array<[number, number, number]> = [];   // x, top, bottom
      const ending = i >= beats.length - 1 && t > 0.05;
      for (const c of callouts) {
        // Nothing half-drawn may be caught under the closing card.
        if (c.a < 0.3 || ending) continue;
        const sx0 = toScreenX(c.x), sy = toScreenY(c.y);
        g.font = 'bold 13px system-ui';
        const wHead = g.measureText(c.head).width;
        g.font = '10px system-ui';
        const plateW = Math.max(wHead, c.sub ? g.measureText(c.sub).width : 0) + 18;
        const plateH = c.sub ? 34 : 20;
        const sx = Math.max(plateW / 2 + 8, Math.min(CANVAS_W - plateW / 2 - 8, sx0));
        let py = sy - 52;
        // Never under the title block or the standings panel, never on
        // another card, and never over a world or the name under it.
        for (let guard = 0; guard < 18; guard++) {
          const clashHud = py < 96 && (sx - plateW / 2 < 312 || sx + plateW / 2 > CANVAS_W - 288);
          const at = py;
          const clashCard = taken.some(([tx, top, bot]) =>
            Math.abs(tx - sx) < (plateW + 40) / 2 && at < bot + 5 && at + plateH > top - 5);
          const clashWorld = renderBodies.some(b => {
            if ((shown.get(b.id) ?? 0) <= 0.02) return false;
            const bq = bodyPos(b);
            const bsx = toScreenX(bq.x), bsy = toScreenY(bq.y), bsr = bq.r * K;
            // The disc, plus the strip under it where the name is printed.
            const nx = Math.max(sx - plateW / 2, Math.min(bsx, sx + plateW / 2));
            const ny = Math.max(at, Math.min(bsy, at + plateH));
            if (Math.hypot(nx - bsx, ny - bsy) < bsr + 4) return true;
            return Math.abs(bsx - sx) < plateW / 2 + 40
              && at < bsy + bsr + 22 && at + plateH > bsy + bsr + 2;
          });
          if (!clashHud && !clashCard && !clashWorld) break;
          py -= plateH + 7;
          if (py < 8) { py = sy + 40; break; }
        }
        taken.push([sx, py, py + plateH]);

        g.strokeStyle = `rgba(255, 120, 108, ${(c.a * 0.5).toFixed(3)})`;
        g.lineWidth = 1;
        g.beginPath();
        g.moveTo(sx, py + plateH); g.lineTo(sx0, sy - 6);
        g.stroke();

        g.fillStyle = 'rgba(10, 13, 19, 0.95)';
        g.fillRect(sx - plateW / 2, py, plateW, plateH);
        g.globalAlpha = c.a;
        g.fillStyle = c.col;
        g.fillRect(sx - plateW / 2, py, 3, plateH);
        g.globalAlpha = 1;
        g.strokeStyle = `rgba(255, 138, 128, ${(c.a * 0.62).toFixed(3)})`;
        g.strokeRect(sx - plateW / 2 + 0.5, py + 0.5, plateW - 1, plateH - 1);
        g.textAlign = 'center';
        g.fillStyle = `rgba(255, 226, 222, ${c.a.toFixed(3)})`;
        g.font = 'bold 13px system-ui';
        g.fillText(c.head, sx + 1, py + 15);
        if (c.sub) {
          g.fillStyle = `rgba(196, 214, 230, ${(c.a * 0.9).toFixed(3)})`;
          g.font = '10px system-ui';
          g.fillText(c.sub, sx + 1, py + 27);
        }
      }

      // ---- a faction being wiped out --------------------------------
      const wiped = eliminated.get(beat.tick);
      if (wiped && wiped.length) {
        const a = Math.min(1, t / 0.18) * (1 - Math.max(0, (t - 0.72) / 0.28));
        for (let n = 0; n < wiped.length; n++) {
          const f = d.factions[wiped[n]];
          const y = CANVAS_H - 74 - (wiped.length - 1 - n) * 92;
          g.textAlign = 'center';
          const nm = (f?.name ?? 'A faction').toUpperCase();
          g.font = 'bold 13px system-ui';
          const wName = g.measureText(nm).width;
          g.font = 'bold 34px system-ui';
          const wKill = g.measureText('ELIMINATED').width;
          const w = Math.max(wName, wKill);
          const bx = CANVAS_W / 2 - w / 2 - 30, bw = w + 60;
          const by = y - 40, bh = 82;
          // A full-bleed band rather than an outlined box: the box read as
          // a debug toast dropped over the battle.
          g.fillStyle = `rgba(9, 12, 18, ${(a * 0.95).toFixed(3)})`;
          g.fillRect(bx, by, bw, bh);
          g.strokeStyle = `rgba(255, 96, 84, ${(a * 0.55).toFixed(3)})`;
          g.lineWidth = 1;
          g.strokeRect(bx + 0.5, by + 0.5, bw - 1, bh - 1);
          g.fillStyle = `rgba(255, 96, 84, ${(a * 0.95).toFixed(3)})`;
          g.fillRect(bx, by, bw, 2.5);
          g.fillStyle = `rgba(255, 196, 188, ${(a * 0.92).toFixed(3)})`;
          g.font = 'bold 13px system-ui';
          g.fillText(nm, CANVAS_W / 2, by + 24);
          g.save();
          g.shadowColor = `rgba(255, 70, 56, ${(a * 0.9).toFixed(3)})`;
          g.shadowBlur = 22;
          g.fillStyle = `rgba(255, 122, 108, ${a.toFixed(3)})`;
          g.font = 'bold 34px system-ui';
          g.fillText('ELIMINATED', CANVAS_W / 2, by + 62);
          g.restore();
        }
      }

      const standings = (() => {
        const perSide = new Map<string, { alive: number; total: number }>();
        for (const [, h] of hulls) {
          if (h.kind !== 'ship' || !h.fid) continue;
          const row = perSide.get(h.fid) ?? { alive: 0, total: 0 };
          row.total++;
          // Strictly before. The elimination banner fires ON the death tick,
          // and counting the dead as alive for that same tick made the
          // panel say 1/1 underneath a card announcing the fleet was gone.
          if (h.diedTick == null || beat.tick < h.diedTick) row.alive++;
          perSide.set(h.fid, row);
        }
        // Present on the board this tick, which is what the viewer can
        // actually see and count.
        const onField = new Map<string, number>();
        for (const [hid] of beat.where) {
          const hh = hulls.get(hid);
          if (!hh || hh.kind !== 'ship' || !hh.fid) continue;
          if (hh.diedTick != null && beat.tick >= hh.diedTick) continue;
          onField.set(hh.fid, (onField.get(hh.fid) ?? 0) + 1);
        }
        return [...perSide.entries()]
          .sort((a, b) => b[1].alive - a[1].alive)
          .map(([fid, r]) => ({
            name: d.factions[fid]?.name ?? fid,
            color: d.factions[fid]?.color ?? NEUTRAL,
            emblem: d.factions[fid]?.emblem ?? null,
            alive: r.alive, total: r.total,
            onField: onField.get(fid) ?? 0,
            lost: r.total - r.alive,
          }));
      })();

      // ---- how it ended -------------------------------------------------
      // The reel used to stop rather than end: the last beat was a lull
      // with no result on it, so there was nothing to watch it FOR. This
      // is the payoff -- and it states what the record says, including
      // when the record says nobody won.
      const paintEnding = () => {
        if (i < beats.length - 1) return;
        const a = Math.min(1, Math.max(0, (t - 0.08) / 0.26));
        if (a > 0.01) {
          const wipedOut = standings.filter(s => s.alive === 0);
          const place = (d.theatre.anchor_name ?? 'THE SYSTEM').toUpperCase();
          // Who was left fighting when the shooting stopped.
          const held = standings.filter(s => s.onField > 0)
            .sort((a, b) => b.onField - a.onField);
          const first = held[0], second = held[1];
          const decisive = !!first && (!second || first.onField >= second.onField * 2);
          const over = decisive ? first : null;
          const verdict = !first ? `${place} LEFT EMPTY`
            : held.length === 1 ? `TAKES ${place}`
              : decisive ? 'HOLDS THE FIELD'
                : `${place} STILL CONTESTED`;
          const vcol = over ? over.color : '#ffd07a';
          const rows = standings.length;
          const cardH = (over ? 142 : 126) + rows * 22;
          const cardW = 424;
          const cx = CANVAS_W / 2, cy = CANVAS_H - cardH / 2 - 26;
          const x0 = cx - cardW / 2, y0 = cy - cardH / 2;
          g.save();
          g.globalAlpha = a;
          g.fillStyle = 'rgba(6, 9, 15, 0.34)';
          g.fillRect(0, 0, CANVAS_W, CANVAS_H);
          g.shadowColor = 'rgba(0, 0, 0, 0.8)';
          g.shadowBlur = 26;
          g.shadowOffsetY = 6;
          g.fillStyle = 'rgba(8, 12, 19, 0.995)';
          g.fillRect(x0, y0, cardW, cardH);
          g.shadowColor = 'transparent';
          g.shadowBlur = 0;
          g.shadowOffsetY = 0;
          g.strokeStyle = 'rgba(90, 122, 152, 0.5)';
          g.lineWidth = 1;
          g.strokeRect(x0 + 0.5, y0 + 0.5, cardW - 1, cardH - 1);
          g.fillStyle = vcol;
          g.fillRect(x0, y0, cardW, 2.5);

          g.textAlign = 'center';
          g.fillStyle = '#6f8ba3';
          g.font = '10px system-ui';
          g.fillText(
            `THE FIGHT FOR ${(d.theatre.anchor_name ?? 'THIS SYSTEM').toUpperCase()}`
            + `  ·  T+${d.theatre.started_tick}–${d.theatre.last_fire_tick}`,
            cx, y0 + 22);
          g.fillStyle = '#55707f';
          g.font = '9px system-ui';
          g.fillText(over ? 'WHEN THE SHOOTING STOPPED' : 'AT THE LAST SHOT',
            cx, y0 + 37);
          let hy = y0 + 58;
          if (over) {
            g.fillStyle = '#c9d9e8';
            g.font = 'bold 13px system-ui';
            g.fillText(fitText(g, over.name.toUpperCase(), cardW - 40), cx, hy);
            hy += 32;
          }
          // Set to fit rather than trimmed to fit: a verdict that ends in
          // an ellipsis is not a verdict.
          g.fillStyle = vcol;
          let vsize = 30;
          for (const px2 of [30, 26, 22, 18]) {
            g.font = `bold ${px2}px system-ui`;
            vsize = px2;
            if (g.measureText(verdict).width <= cardW - 40) break;
          }
          g.font = `bold ${vsize}px system-ui`;
          g.fillText(verdict, cx, hy);
          g.fillStyle = '#7f9bb3';
          g.font = '10px system-ui';
          g.fillText(
            wipedOut.length
              ? `${held.length} FLEET${held.length === 1 ? '' : 'S'} STILL IN THE FIGHT`
                + `  ·  ${wipedOut.length} ELIMINATED`
              : `${held.length} FLEET${held.length === 1 ? '' : 'S'} STILL IN THE FIGHT`,
            cx, hy + 18);

          g.strokeStyle = 'rgba(90, 122, 152, 0.3)';
          g.beginPath();
          g.moveTo(x0 + 18, hy + 32); g.lineTo(x0 + cardW - 18, hy + 32);
          g.stroke();

          let ry = hy + 52;
          for (const s of [...standings].sort((a, b) => b.onField - a.onField)) {
            const em = getEmblemImage(s.emblem, s.color);
            g.textAlign = 'left';
            if (em) g.drawImage(em, x0 + 20, ry - 11, 13, 13);
            g.fillStyle = s.alive === 0 ? '#6c7c8a' : '#dbe8f4';
            g.font = '12px system-ui';
            g.fillText(fitText(g, s.name, cardW - 170), x0 + 40, ry);
            g.textAlign = 'right';
            g.fillStyle = s.alive === 0 ? '#ff6f61' : '#9fc2dc';
            g.font = '12px system-ui';
            g.fillText(
              s.alive === 0
                ? `eliminated · ${s.lost} lost`
                : `${s.onField} on the field · ${s.lost} lost`,
              x0 + cardW - 20, ry);
            ry += 22;
          }
          g.restore();
        }
      };

      // ---- HUD ----------------------------------------------------------
      drawHud(g, {
        hideStandings: i >= beats.length - 1 && t > 0.14,
        title: d.theatre.anchor_name ?? 'system',
        span: `T+${d.theatre.started_tick}–${d.theatre.last_fire_tick}`,
        engagements: d.theatre.battle_count,
        tick: beat.tick,
        shotsThisBeat: allShots.length,
        worldsHot: hotBodies.length,
        sides: standings,
      });

      paintEnding();
    };

    handle = requestAnimationFrame(draw);
    return () => { live = false; cancelAnimationFrame(handle); };
  }, [beats, arrived, left, hulls, seats, stars, armedIds, eliminated, colorOf, trimOf,
      renderBodies, d.bodies, d.factions, d.theatre]);

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
          onClick={() => { if (pos >= beats.length - 1 + 0.9) setPos(0); setPlaying(p => !p); }}
          style={{
            background: '#16273a', border: '1px solid #3d6b96', borderRadius: 5,
            color: '#cfe0ee', padding: '3px 10px', cursor: 'pointer', fontSize: 11,
          }}
        >{playing ? '❚❚ Pause' : '▶ Play campaign'}</button>
        <input
          type="range" min={0} max={Math.max(0.0001, beats.length - 1 + 0.98)} step={0.02}
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
