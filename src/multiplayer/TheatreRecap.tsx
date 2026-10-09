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
import { getEmblemImage } from '../render/emblemCache';
import {
  getPlanetTexture, getTerraformedTexture, terraformFraction, hashStr, mulberry32, getGlobe,
} from '../render/planetTexture';
import { paintGlobe } from '../render/paintGlobe';
import {
  drawTexturedDisk, drawSphereLighting, drawThrustExhaust, drawWreck,
} from '../render/fxPrimitives';
import { drawCityCluster, drawStationStructure } from '../render/isoStructures';
import { deriveSecondary } from '../game/colorUtils';
import { countPart } from '../game/shipParts';
import { FX_TUNING } from '../render/fxTuning';
import {
  battleReferenceRadius, battleSpriteScale, BATTLE_STATION_PX,
} from '../render/battleLayoutLive';
import { toRenderBody, stripGameId } from './bodyIdentity';
import { layoutRecap, glideSlot, type RecapBeat, type RecapUnit, type RecapLayout } from './recapLayout';
import {
  iconClassOf, gameHullPx, hullImage, recapClock, drawVolley, drawHullWreck, drawDeathBlast,
  drawDamageFire, wreckAlpha, burnPose, WRECK_LIFE_TICKS, LAUNCH_SPREAD, flightFrac,
} from './recapFx';
import { ShipIconVariant } from '../components/ShipIcons';
import type { Body } from '../types';
import { t as tr, tn as trn } from '../i18n/core';
import { useI18n } from '../i18n/react';

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
const DRAIN_MS = 420;
const LIGHT_X = 0.74, LIGHT_Y = 0.67;
/** Orbital planes seen from the same angle as the single-battle recap. */
const TILT = 0.58;
/** How far off a body its combatants hold (world spacing only now: the
 *  hulls themselves are placed by the game's battle layout). */
const GUARD_RING = 26;
/** How long a settlement's ruin stays on the board — about nine ticks.
 *  A hull's wreck fades as the map's do (recapFx WRECK_LIFE_TICKS). */
const WRECK_LIFE_MS = 9 * 2200;
/** Where a world's fight sits on its orbit (the near face, down and to
 *  the right, as in the single-battle recap), and how fast it turns. */
const ENGAGEMENT_BEARING = 0.9;
const THEATRE_ORBIT_RATE = 0.00004;
/** A hull arriving from off the board brakes into its slot over this much
 *  of its first beat; one crossing from another world flies over this
 *  much. Nothing it fires or takes goes off until it is there (Lorne,
 *  2026-10-09: "the firing before they arrive is confusing"). */
const ARRIVE_FRAC = 0.3;
const CROSS_FRAC = 0.42;
/** Roughly when in its beat a hull that died then went up, ms. */
const KILL_AT_MS = (LAUNCH_SPREAD / 2 + flightFrac(TICK_MS)) * TICK_MS;

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

/** Ellipse squash of the worlds' layout around the anchor. */
const SQUASH = 0.78;

/**
 * Where every world sits and how big it is drawn (see "The worlds DO NOT
 * MOVE" above). Pure, so the per-world battle layouts can be solved once
 * against the same radii the draw loop paints.
 */
/** A world as both the record and the renderer know it. */
type RBody = TBody & Body;

function boardGeometry(renderBodies: RBody[], rawBodies: TBody[], anchorId: string | null) {
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
  const moonR = (b: RBody) => Math.max(7, Math.min(22, 4 + (Number(b.radius) || 1) * 9));
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

  const bodyPos = (b: RBody | undefined) => {
    if (!b || b.id === anchor?.id) return { x: cx, y: cy, r: anchorR };
    const p = placed.get(b.id);
    if (!p) return { x: cx, y: cy, r: anchorR };
    return { x: p.x, y: p.y, r: p.r };
  };
  const bodyById = new Map<string, RBody>();
  for (let k = 0; k < renderBodies.length; k++) {
    const rb = renderBodies[k];
    bodyById.set(rb.id, rb);
    const raw = rawBodies.find(x => toRenderBody(x).id === rb.id);
    if (raw) bodyById.set(raw.id, rb);
  }
  return { anchor, moons, SPAN, cx, cy, bodyPos, bodyById };
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
  g.fillText(tr('theatre.fightFor', { name: v.title.toUpperCase() }), 14, 25);
  g.fillStyle = '#7f9bb3';
  g.font = '11px system-ui';
  g.fillText(
    `${v.span}  ·  ${trn('theatre.battles', v.engagements, { n: v.engagements })}`, 14, 42);

  // ---- live state, under the title --------------------------------
  g.fillStyle = '#9fc2dc';
  g.font = '12px system-ui';
  const hot = v.worldsHot === 0
    ? tr('theatre.holdingFire')
    : trn('theatre.worldsHot', v.worldsHot, { n: v.worldsHot });
  g.fillText(`T+${v.tick}`, 14, 60);
  g.fillStyle = '#7f9bb3';
  g.font = '11px system-ui';
  // Labelled for what it is. The bare number went up and down between
  // beats and read as a broken running total.
  g.fillText(`${trn('theatre.shotsExchanged', v.shotsThisBeat, { n: v.shotsThisBeat })}  ·  ${hot}`, 52, 60);

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
  g.fillText(tr('theatre.hudFleet'), px + 12, py + 17);
  g.textAlign = 'right';
  g.fillText(tr('theatre.hudStanding'), px + panelW - 12, py + 17);

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
  useI18n();
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
      /** Shield and armor parts: what an impact looks like on it. */
      shields: number; armor: number;
    }>();
    for (const b of d.battles) {
      for (const p of b.participants) {
        if (m.has(p.ship_id)) continue;
        let energy = false;
        let shields = 0, armor = 0;
        try {
          const parts = p.parts ? JSON.parse(p.parts) : null;
          if (Array.isArray(parts)) {
            energy = parts.filter((x: string) => x === 'energy').length
              > parts.filter((x: string) => x === 'kinetic').length;
            shields = countPart(parts, 'shield');
            armor = countPart(parts, 'armor');
          }
        } catch { /* an unreadable loadout is a kinetic one */ }
        m.set(p.ship_id, {
          fid: p.faction_id, cls: p.ship_class, name: p.ship_name,
          kind: p.kind ?? 'ship',
          variant: (p.icon_variant as ShipIconVariant) || undefined,
          rank: Number(p.rank) || 0, energy, diedTick: p.died_tick,
          mods: p.modules ?? null, shields, armor,
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

  const geo = useMemo(
    () => boardGeometry(renderBodies, d.bodies, d.theatre.anchor_body_id),
    [renderBodies, d.bodies, d.theatre.anchor_body_id]);

  /**
   * Every world's battle, beat by beat, laid out by the game's rule: the
   * whole-orbit layout (recapLayout, the same one the single-battle recap
   * uses), sticky, so a hull that leaves or dies leaves a gap and nobody
   * else moves. Hulls are the map's own sizes at the scale the map would
   * draw them at THAT world (battleLayoutLive: ships fixed in scale to
   * their planet, capped at twice full size), so a destroyer outweighs a
   * corvette as it does on the map and a moon's fight is drawn smaller
   * than the primary's. Cities stay on the globe.
   */
  const worldLayouts = useMemo(() => {
    const worlds = new Set<string>();
    for (const b of beats) for (const [, w] of b.where) worlds.add(w);
    const order = [...new Set([...hulls.values()].map(h => h.fid ?? 'none'))].sort();
    const allBodies = [geo.anchor, ...geo.moons].filter(Boolean) as RBody[];
    const out = new Map<string, { lay: RecapLayout; kw: number; stationPx: number }>();
    for (const w of worlds) {
      const rb = geo.bodyById.get(w);
      const p = geo.bodyPos(rb);
      const kw = battleSpriteScale(p.r / battleReferenceRadius(Number(rb?.radius) || 1));
      // The station rig at the map's size for this world, never bigger
      // than the theatre has always drawn it.
      const stationPx = 88 * Math.min(0.55, (BATTLE_STATION_PX * kw) / 88);
      // Room before the next world over.
      let near = Infinity;
      for (const o of allBodies) {
        if (o === rb || (!rb && o === geo.anchor)) continue;
        const q = geo.bodyPos(o);
        near = Math.min(near, Math.hypot(q.x - p.x, q.y - p.y) - q.r);
      }
      const rMax = Math.max(p.r * 2 + 10, Math.min(p.r * 3.5, Number.isFinite(near) ? near * 0.75 : p.r * 3.5));
      const wbeats: RecapBeat[] = beats.map(b => {
        const units: RecapUnit[] = [];
        let stationId: string | undefined;
        for (const [id, at] of b.where) {
          if (at !== w) continue;
          const h = hulls.get(id);
          if (!h || (h.diedTick != null && b.tick > h.diedTick)) continue;
          if (h.kind === 'city') continue;
          if (h.kind === 'station') {
            if (!stationId) { stationId = id; continue; }
            units.push({ id, faction: h.fid ?? 'none', size: stationPx, armed: true });
            continue;
          }
          const cls = (h.cls ?? '').toLowerCase();
          units.push({
            id, faction: h.fid ?? 'none', size: (gameHullPx(cls) ?? 30) * kw,
            armed: armedIds.has(id) || (cls !== 'freighter' && cls !== 'colony'),
          });
        }
        return { units, stationId };
      });
      out.set(w, {
        lay: layoutRecap(wbeats, {
          planetR: p.r, tilt: TILT, rMax, stationPx, seed: hashStr(w) % 100000, order,
        }),
        kw, stationPx,
      });
    }
    return out;
  }, [beats, hulls, geo, armedIds]);

  const stars = useMemo(() => {
    const rng = mulberry32(hashStr(d.theatre.id + ':stars'));
    return Array.from({ length: 190 }, () => ({
      x: rng() * CANVAS_W, y: rng() * CANVAS_H,
      r: 0.4 + rng() * 0.9, a: 0.15 + rng() * 0.5, ph: rng() * Math.PI * 2,
    }));
  }, [d.theatre.id]);

  useEffect(() => {
    for (const [, h] of hulls) {
      if (!iconClassOf(h.cls)) continue;
      hullImage(h.cls, colorOf(h.fid), h.variant, trimOf(h.fid));
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

    const { anchor, moons, SPAN, cx, cy, bodyPos, bodyById } = geo;

    const draw = (nowMs: number) => {
      if (!live) return;
      handle = requestAnimationFrame(draw);
      const dtMs = prevMs ? Math.min(80, nowMs - prevMs) : 16;
      prevMs = nowMs;

      const i = clampFrame(posRef.current, beats.length);
      const t = Math.min(1, Math.max(0, posRef.current - i));
      const beat = beats[i];
      if (!beat) return;
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
        // The world as the map draws it: its real-map globe where it has
        // one (terraformed twin and all), the procedural texture otherwise.
        const globe = getGlobe(b as unknown as Body, tf >= 1);
        if (globe) {
          paintGlobe(g, b as unknown as Body, tf >= 1, globe, p.x, p.y, p.r, nowMs);
          if (tf > 0 && tf < 1) {
            const tfGlobe = getGlobe(b as unknown as Body, true);
            if (tfGlobe) {
              g.save(); g.globalAlpha = tf;
              paintGlobe(g, b as unknown as Body, true, tfGlobe, p.x, p.y, p.r, nowMs);
              g.restore();
            }
          }
          drawSphereLighting(g, p.x, p.y, p.r, LIGHT_X, LIGHT_Y);
          return;
        }
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
      const paintFramed = (b: RBody) => {
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

      // ---- where every hull is -----------------------------------------
      // Each world's battle is the game's whole-orbit layout (worldLayouts),
      // turning slowly, the fight centred on the near face. A hull keeps
      // its slot while it stays; when the board changes it GLIDES to its
      // new one, as on the map.
      const prevBeat = i > 0 ? beats[i - 1] : null;
      // Where each hull was last on the board. A hull leaves the roster
      // the tick after it dies, so this is the only record of where its
      // wreck belongs.
      const lastSeenAt = new Map<string, string>();
      for (let n = 0; n <= i; n++) {
        for (const [bid, slot] of beats[n].at) {
          for (const r of slot.roster) lastSeenAt.set(r.id, bid);
        }
      }
      const glideU = 1 - Math.exp(-beatMs / 260);
      const spin = ENGAGEMENT_BEARING + nowMs * THEATRE_ORBIT_RATE;
      /** The world a hull crossed FROM to get here this beat, if it did. */
      const crossedFrom = (id: string) => {
        const was = prevBeat?.where.get(id);
        const now = beat.where.get(id);
        return was && now && was !== now ? was : null;
      };
      /** How much of this beat a hull spends moving into place (arriving
       *  from off the board, or crossing from another world), or null.
       *  Nothing it fires or takes goes off until it is there. */
      const movingUntil = (id: string | null) => {
        if (!id) return null;
        if (arrived.get(id) === beat.tick) return ARRIVE_FRAC;
        if (crossedFrom(id)) return CROSS_FRAC;
        return null;
      };
      const slotAt = (w: string, id: string) => {
        const L = worldLayouts.get(w)?.lay;
        if (!L) return null;
        const now = L.beats[i]?.get(id);
        if (!now) return L.carry[i]?.get(id) ?? null;
        const was = i > 0 ? L.carry[i - 1]?.get(id) : undefined;
        return was && movingUntil(id) == null ? glideSlot(was, now, glideU) : now;
      };
      /** A hull's place in its world's orbit, and its heading there. */
      const homeAt = (w: string | undefined, id: string) => {
        const p = bodyPos(w ? bodyById.get(w) : undefined);
        const sl = w ? slotAt(w, id) : null;
        if (!sl) return { x: p.x, y: p.y - p.r - 6, heading: 0 };
        const a = sl.theta + spin;
        // Prograde plus the layout's small jitter, seen through the tilt.
        const h = a + Math.PI / 2 + sl.jitter;
        return {
          x: p.x + Math.cos(a) * sl.r, y: p.y + Math.sin(a) * sl.r * TILT,
          heading: Math.atan2(Math.sin(h) * TILT, Math.cos(h)),
        };
      };
      const offSystem = (p: { x: number; y: number }) => {
        const dx = p.x - cx, dy = p.y - cy;
        const len = Math.max(1, Math.hypot(dx, dy));
        const far = SPAN * 1.9 + 120;
        return { x: cx + (dx / len) * far, y: cy + (dy / len) * far * TILT };
      };
      /** A hull's drawn size at a world: its map size at that world's
       *  scale, times the layout's fit. */
      const sizeAt = (w: string | undefined, cls: string | null) => {
        const L = w ? worldLayouts.get(w) : undefined;
        return (gameHullPx(cls) ?? 30) * (L?.kw ?? 0.3) * (L?.lay.k ?? 1);
      };
      const stationPxAt = (w: string | undefined) => {
        const L = w ? worldLayouts.get(w) : undefined;
        return (L?.stationPx ?? 48) * (L?.lay.k ?? 1);
      };

      /**
       * Where a hull is right now, which way it points, and its burn. On
       * station it rides its orbit. Arriving from off the board it is
       * already on its brake, turned round with the flame ahead of it;
       * crossing from another world it boosts, flips at the middle and
       * brakes, as the map's shaped burns fly (recapFx burnPose). Leaving
       * the board it boosts away nose-first.
       */
      const posOf = (id: string) => {
        const here = beat.where.get(id);
        const h = hulls.get(id);
        const home = homeAt(here, id);
        const size = sizeAt(here, h?.cls ?? null);
        const still = { x: home.x, y: home.y, heading: home.heading, burn: 0, plume: 1, size, moving: false };
        if (arrived.get(id) === beat.tick && t < ARRIVE_FRAC) {
          const k = t / ARRIVE_FRAC;
          const far = offSystem(home);
          const u = 1 - (1 - k) * (1 - k);
          const travel = Math.atan2(home.y - far.y, home.x - far.x);
          const pose = burnPose(k, travel, home.heading, true);
          return {
            x: far.x + (home.x - far.x) * u, y: far.y + (home.y - far.y) * u,
            heading: pose.heading, burn: pose.burn, plume: pose.lengthMul, size, moving: true,
          };
        }
        if (left.get(id) === beat.tick) {
          const far = offSystem(home);
          const u = t * t;
          return {
            x: home.x + (far.x - home.x) * u, y: home.y + (far.y - home.y) * u,
            heading: Math.atan2(far.y - home.y, far.x - home.x),
            burn: Math.min(1, 0.25 + t * 0.95), plume: 1, size, moving: true,
          };
        }
        const from = crossedFrom(id);
        if (from && t < CROSS_FRAC) {
          const k = t / CROSS_FRAC;
          const start = homeAt(from, id);
          // Even burn: speeds up to the flip, slows down after it.
          const u = k < 0.5 ? 2 * k * k : 1 - 2 * (1 - k) * (1 - k);
          const travel = Math.atan2(home.y - start.y, home.x - start.x);
          const pose = burnPose(k, travel, home.heading, false);
          return {
            x: start.x + (home.x - start.x) * u, y: start.y + (home.y - start.y) * u,
            heading: pose.heading, burn: pose.burn, plume: pose.lengthMul,
            size: sizeAt(from, h?.cls ?? null) + (size - sizeAt(from, h?.cls ?? null)) * u,
            moving: true,
          };
        }
        return still;
      };
      /** A combatant's hit radius, for where fire leaves and lands. */
      const hitROf = (id: string) => {
        const h = hulls.get(id);
        const here = beat.where.get(id) ?? lastSeenAt.get(id);
        if (h?.kind === 'station') return stationPxAt(here) * 0.3;
        if (h?.kind === 'city') return bodyPos(here ? bodyById.get(here) : undefined).r * 0.3;
        const s = sizeAt(here, h?.cls ?? null);
        return s / 2 + s * 0.1;
      };

      // ---- the beat's clock ---------------------------------------------
      // Every volley on its own clock (recapFx recapClock): in the order
      // the server resolved them, rolling across the beat, and none to or
      // from a hull still moving into place.
      const allShots: TFrame['shot_log'] = [];
      for (const [, slot] of beat.at) for (const sh of slot.shots) allShots.push(sh);
      const clock = recapClock(allShots, beat.tick, TICK_MS, movingUntil);
      const flightMs = flightFrac(TICK_MS) * TICK_MS;
      const landed = new Map<string, number>();
      const firstHitMs = new Map<string, number>();
      for (const sh of allShots) {
        if (!sh.t || !sh.hit) continue;
        const at = clock.arriveMsOf(sh);
        const k = Math.max(0, Math.min(1, (beatMs - at) / DRAIN_MS));
        if (k > 0) landed.set(sh.t, (landed.get(sh.t) ?? 0) + sh.dmg * k);
        if (sh.dmg > 0 && at < (firstHitMs.get(sh.t) ?? Infinity)) firstHitMs.set(sh.t, at);
      }
      const hitLastBeat = new Set<string>();
      if (prevBeat) {
        for (const [, slot] of prevBeat.at) {
          for (const sh of slot.shots) if (sh.t && sh.hit && sh.dmg > 0) hitLastBeat.add(sh.t);
        }
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

      // ---- combatants -------------------------------------------------
      const blasts: Array<{ x: number; y: number; r: number; since: number; id: string }> = [];
      type Wreck = { x: number; y: number; size: number; heading: number; age: number; id: string; col: string; ship: boolean; cls: string | null; fid: string | null; variant: ShipIconVariant | undefined };
      const wrecks: Wreck[] = [];
      const wreckOf = (id: string, w: string | undefined, age: number) => {
        const h = hulls.get(id);
        if (!h) return;
        const ship = h.kind === 'ship';
        if (age >= (ship ? WRECK_LIFE_TICKS * TICK_MS : WRECK_LIFE_MS)) return;
        const q = homeAt(w, id);
        wrecks.push({
          x: q.x, y: q.y, heading: q.heading, age, id, col: colorOf(h.fid), ship,
          size: ship ? sizeAt(w, h.cls) : Math.max(8, stationPxAt(w) * 0.3),
          cls: h.cls, fid: h.fid, variant: h.variant,
        });
      };
      const drawn = new Set<string>();
      for (const [id, bodyId] of beat.where) {
        if (drawn.has(id)) continue;
        drawn.add(id);
        const h = hulls.get(id);
        if (!h) continue;
        if (h.diedTick != null && beat.tick > h.diedTick) {
          // A kill site stays a kill site.
          wreckOf(id, bodyId, (beat.tick - h.diedTick) * TICK_MS + (beatMs - KILL_AT_MS));
          continue;
        }
        const st = hpNow.get(id);
        const q = posOf(id);
        const col = colorOf(h.fid);
        const bp = bodyPos(bodyById.get(bodyId));
        const size = q.size;

        if (st?.dead && beatMs > clock.killMsOf(id)) {
          const since = beatMs - clock.killMsOf(id);
          // The death, as the map draws one: a fireball sized to what
          // died, and the hull coming apart as itself inside it.
          blasts.push({ x: q.x, y: q.y, r: hitROf(id), since, id });
          wrecks.push({
            x: q.x, y: q.y, heading: q.heading, age: since, id, col, ship: h.kind === 'ship',
            size: h.kind === 'ship' ? size : Math.max(8, stationPxAt(bodyId) * 0.3),
            cls: h.cls, fid: h.fid, variant: h.variant,
          });
          if (since > 90 && since < 1700) {
            callouts.push({
              x: q.x, y: q.y,
              head: tr('review.battle.lost', { name: h.name ?? tr('theatre.hull') }),
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
          const stPx = stationPxAt(bodyId);
          const tiny = stPx * K < 26;
          if (tiny) {
            // Below this the rig's panels and struts land on sub-pixel
            // strokes and read as a smear of garbled glyphs: a hull with
            // two panels off it instead.
            g.save();
            const hw = Math.max(2.6, stPx * 0.18), hh = Math.max(1.6, stPx * 0.1);
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
            g.scale(stPx / 88, stPx / 88);
            drawStationStructure(g, {
              weaponsLevel: Math.max(Number(mods.weapons) || 0, armedIds.has(id) ? 1 : 0),
              shipyardLevel: Number(mods.shipyard) || 0,
              labLevel: Number(mods.lab) || 0,
              thrustersLevel: Number(mods.thrusters) || 0,
              factionColor: col, builds: [], nowMs,
            });
            g.restore();
            // The rig is grey metal whoever owns it, so it read as nobody's.
            g.save();
            g.globalAlpha = 0.9;
            g.strokeStyle = col;
            g.lineWidth = 1.5;
            g.lineCap = 'round';
            const rr = stPx * 0.5;
            for (let n = 0; n < 4; n++) {
              const a0 = n * (Math.PI / 2) + Math.PI / 4 - 0.3;
              g.beginPath();
              g.arc(q.x, q.y, rr, a0, a0 + 0.6);
              g.stroke();
            }
            g.restore();
          }
        } else {
          const heading = q.heading;
          if (q.burn > 0.02) {
            const dir = { x: Math.cos(heading), y: Math.sin(heading) };
            drawThrustExhaust(g,
              { x: q.x - dir.x * size * 0.42, y: q.y - dir.y * size * 0.42 },
              dir, size, q.burn, h.cls ?? undefined, rgbOf(col), undefined, q.plume);
          } else {
            // Engine idle glow at the stern, as the map does it: parked
            // hulls that do not glow read as cardboard.
            const pulse = 0.6 + 0.4 * Math.sin(nowMs / 420 + ((hashStr(id) % 1000) / 1000) * Math.PI * 2);
            const gx = q.x - Math.cos(heading) * size * 0.46;
            const gy = q.y - Math.sin(heading) * size * 0.46;
            const gr = Math.max(0.8, size * 0.2);
            g.save();
            g.globalCompositeOperation = 'lighter';
            g.fillStyle = `rgba(255, 158, 74, ${(0.16 * pulse).toFixed(3)})`;
            g.beginPath(); g.arc(gx, gy, gr, 0, Math.PI * 2); g.fill();
            g.fillStyle = `rgba(255, 220, 168, ${(0.28 * pulse).toFixed(3)})`;
            g.beginPath(); g.arc(gx, gy, gr * 0.45, 0, Math.PI * 2); g.fill();
            g.restore();
          }
          const icon = hullImage(h.cls, col, h.variant, trimOf(h.fid));
          g.save();
          g.translate(q.x, q.y);
          g.rotate(heading);
          if (icon) {
            g.drawImage(icon, -size / 2, -size / 2, size, size);
          } else {
            // A hull whose icon has not finished generating still has to
            // read as a hull, in its owner's colour.
            g.fillStyle = col;
            g.beginPath();
            g.moveTo(size * 0.5, 0);
            g.lineTo(-size * 0.32, size * 0.3);
            g.lineTo(-size * 0.16, 0);
            g.lineTo(-size * 0.32, -size * 0.3);
            g.closePath();
            g.fill();
          }
          g.restore();
        }

        // On fire, by the map's rule (recapFx drawDamageFire).
        if (st && st.max) {
          drawDamageFire(g, q.x, q.y,
            h.kind === 'ship' ? size / 2 + 1 : (h.kind === 'station' ? stationPxAt(bodyId) * 0.25 : bp.r * 0.3),
            Math.max(0, Math.min(1, st.hp / st.max)),
            { firstHitMs: firstHitMs.get(id) ?? null, beatMs, hitLastBeat: hitLastBeat.has(id) },
            id, nowMs, 1, 1.5);
        }
      }

      // ---- what is left of the dead --------------------------------------
      for (const [id, h] of hulls) {
        if (h.diedTick == null || beat.tick <= h.diedTick) continue;
        if (drawn.has(id) || h.kind !== 'ship') continue;
        const bid = lastSeenAt.get(id);
        if (!bid) continue;
        wreckOf(id, bid, (beat.tick - h.diedTick) * TICK_MS + (beatMs - KILL_AT_MS));
      }
      // Wrecks under the fire: the hull in charred pieces as the map
      // draws one, fading over WRECK_LIFE_TICKS; a settlement's ruin as
      // before.
      for (const w of wrecks) {
        const img = w.ship ? hullImage(w.cls, colorOf(w.fid), w.variant, trimOf(w.fid)) : null;
        if (img) {
          drawHullWreck(g, img, w.size, w.heading, w.x, w.y, w.age, w.id, wreckAlpha(w.age, TICK_MS));
        } else {
          drawWreck(g, w.x, w.y, Math.max(8, w.size), w.age, WRECK_LIFE_MS, w.id, w.col);
        }
      }

      // ---- detonations, over every hull ----------------------------------
      for (const b of blasts) drawDeathBlast(g, b.x, b.y, b.r, b.since, b.id);

      // ---- fire ---------------------------------------------------------
      // Fire is drawn OVER the worlds, deliberately: tracers and beams stay
      // on top of whatever they cross. Each volley as the map draws it
      // (recapFx drawVolley).
      g.save();
      g.globalCompositeOperation = 'lighter';
      for (const sh of allShots) {
        if (!sh.a || !sh.t) continue;
        const shooter = hulls.get(sh.a);
        if (shooter?.diedTick != null && beat.tick > shooter.diedTick) continue;
        const within = beatMs - clock.launchOf(sh) * TICK_MS;
        if (within < 0 || within > flightMs + FX_TUNING.impactMs) continue;
        const from = posOf(sh.a), to = posOf(sh.t);
        // A THIRD world in the way blocks the shot outright.
        //
        // Deliberately not "is any world between them". Two hulls in
        // orbit around the SAME world are on opposite sides of it as
        // often as not, so that rule silently dropped most of the
        // battle. Only a shot that would have to cross a different world
        // is dropped.
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
        const target = hulls.get(sh.t);
        drawVolley(g, {
          from, to, sR: hitROf(sh.a), tR: hitROf(sh.t),
          energy: sh.e != null ? sh.e >= 0.5 : (shooter?.energy ?? false),
          hit: !!sh.hit, dmg: sh.dmg || 0, abs: sh.abs ?? 0,
          targetKind: (target?.kind as 'ship' | 'station' | 'city') ?? 'ship',
          targetShields: target?.shields ?? 0, targetArmor: target?.armor ?? 0,
          shooterCls: shooter?.cls ?? undefined,
          within, flightMs, seed: hashStr(`${sh.a}>${sh.t}@${beat.tick}`), nowMs,
        });
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
      const nameWorld = (b: RBody) => {
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
          const nm = (f?.name ?? tr('theatre.aFaction')).toUpperCase();
          g.font = 'bold 13px system-ui';
          const wName = g.measureText(nm).width;
          g.font = 'bold 34px system-ui';
          const wKill = g.measureText(tr('theatre.eliminated')).width;
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
          g.fillText(tr('theatre.eliminated'), CANVAS_W / 2, by + 62);
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
          const place = (d.theatre.anchor_name ?? tr('theatre.theSystem')).toUpperCase();
          // Who was left fighting when the shooting stopped.
          const held = standings.filter(s => s.onField > 0)
            .sort((a, b) => b.onField - a.onField);
          const first = held[0], second = held[1];
          const decisive = !!first && (!second || first.onField >= second.onField * 2);
          const over = decisive ? first : null;
          const verdict = !first ? tr('theatre.leftEmpty', { place })
            : held.length === 1 ? tr('theatre.takes', { place })
              : decisive ? tr('theatre.holdsField')
                : tr('theatre.contested', { place });
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
            tr('theatre.fightFor', { name: (d.theatre.anchor_name ?? tr('theatre.thisSystem')).toUpperCase() })
            + `  ·  T+${d.theatre.started_tick}–${d.theatre.last_fire_tick}`,
            cx, y0 + 22);
          g.fillStyle = '#55707f';
          g.font = '9px system-ui';
          g.fillText(over ? tr('theatre.whenStopped') : tr('theatre.lastShot'),
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
              ? `${trn('theatre.fleetsStill', held.length, { n: held.length })}`
                + `  ·  ${trn('theatre.eliminatedCount', wipedOut.length, { n: wipedOut.length })}`
              : `${trn('theatre.fleetsStill', held.length, { n: held.length })}`,
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
                ? tr('theatre.rowEliminated', { lost: s.lost })
                : tr('theatre.rowOnField', { onField: s.onField, lost: s.lost }),
              x0 + cardW - 20, ry);
            ry += 22;
          }
          g.restore();
        }
      };

      // ---- HUD ----------------------------------------------------------
      drawHud(g, {
        hideStandings: i >= beats.length - 1 && t > 0.14,
        title: d.theatre.anchor_name ?? tr('theatre.systemFallback'),
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
  }, [beats, arrived, left, hulls, geo, worldLayouts, stars, armedIds, eliminated, colorOf, trimOf,
      renderBodies, d.bodies, d.factions, d.theatre]);

  if (beats.length === 0) {
    return <div style={{ color: NEUTRAL, padding: 8 }}>{tr('theatre.noFrames')}</div>;
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
        >{playing ? tr('review.battle.pause') : tr('theatre.play')}</button>
        <input
          type="range" min={0} max={Math.max(0.0001, beats.length - 1 + 0.98)} step={0.02}
          value={Number.isFinite(pos) ? pos : 0}
          onChange={e => {
            setPlaying(false);
            const v = Number(e.target.value);
            setPos(Number.isFinite(v) ? v : 0);
          }}
          style={{ flex: 1 }}
          aria-label={tr('theatre.scrub')}
        />
        <span style={{ fontSize: 10, color: NEUTRAL, minWidth: 84, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
          T+{beats[idx].tick} · {idx + 1}/{beats.length}
        </span>
      </div>
    </div>
  );
}
