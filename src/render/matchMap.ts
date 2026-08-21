// ============================================================
// The match film, on the map.
//
// A whole match is a MAP story — who owns which worlds, where the
// fleets are massing, when the system changes colour — and the map is
// the representation players already read. So this replays the game on
// the game's own terms: the planets as their map textures, ships as
// their map icons, territory as colour, with a camera that pans and
// zooms to the tick's event the way the 2D theatre recap does.
//
// It satisfies the same ReplayStage contract as the 3D stage, so the
// player, the API, the streaming and the event log are untouched.
// Nothing here needs three.js, so the chunk stays small.
// ============================================================

import { getPlanetTexture, getTerraformedTexture, hashStr, mulberry32 }
  from './planetTexture';
import { getShipIconImage, prewarmShipIcons } from './shipIconCache';
import {
  MatchTimeline, mineEvents, bareId,
  type MatchSummary, type SnapshotRow, type ReplayStage, type MatchEvent,
  type MatchWorld,
} from './matchWorld';
import type { ShipIconClass } from '../components/ShipIcons';

const NEUTRAL = '#8a9fb3';
const CLASSES = ['corvette', 'frigate', 'destroyer', 'freighter', 'colony'];
const iconClassOf = (c: string | null): ShipIconClass =>
  (CLASSES.includes((c ?? '').toLowerCase())
    ? (c as string).toLowerCase() : 'corvette') as ShipIconClass;

type Body = MatchSummary['bodies'][number];

export function createMatchMap(
  summary: MatchSummary, canvas: HTMLCanvasElement,
): ReplayStage {
  const ctx = canvas.getContext('2d')!;
  let W = canvas.width || 1280, H = canvas.height || 720, DPR = 1;

  const bodies = summary.bodies;
  const byId = new Map(bodies.map(b => [b.id, b]));
  const faction = (fid: string | null) => summary.factions.find(f => f.id === fid);
  // Icons rasterise asynchronously on first request and return null
  // until ready -- the first frame of every faction would draw dots.
  // Prewarm every colour in the match up front.
  prewarmShipIcons(summary.factions.map(f => f.color || NEUTRAL));
  const colorOf = (fid: string | null) => faction(fid)?.color || NEUTRAL;
  const color2Of = (fid: string | null) =>
    faction(fid)?.color2 || faction(fid)?.color || NEUTRAL;

  // ---- layout ----------------------------------------------------------
  //
  // Map units. Orbits are log-compressed — real proportions are empty —
  // and every orbit clears its parent's disc plus a gap, so moons never
  // sit inside their planet.
  const bodyR = new Map<string, number>();
  for (const b of bodies) {
    bodyR.set(b.id, b.type === 'star' ? 26
      : Math.max(4, Math.min(18, 3 + (Number(b.radius) || 1) * 2.2)));
  }
  // MOONS ARE NOT PLANETS. One log curve for every orbit put Luna's ring
  // at 198 map units against Earth's own 386 around the sun, and
  // Callisto at 282 against Jupiter's 445 -- moon systems swinging out
  // across neighbouring tracks. Moons now sit in a compact rank-ordered
  // stack hugging their parent (order preserved, distance not), and
  // planets get a roomier curve so the inner system is not cramped.
  const starId = bodies.find(b => b.type === 'star')?.id ?? '';
  const moonRadius = new Map<string, number>();
  {
    const kids = new Map<string, Body[]>();
    for (const b of bodies) {
      if (!b.parent_body_id || b.parent_body_id === starId) continue;
      if (!kids.has(b.parent_body_id)) kids.set(b.parent_body_id, []);
      kids.get(b.parent_body_id)!.push(b);
    }
    for (const [pid, arr] of kids) {
      arr.sort((a, b) => (a.orbit_radius ?? 0) - (b.orbit_radius ?? 0));
      let r = (bodyR.get(pid) ?? 6) + 5;
      for (const m of arr) {
        const mr = bodyR.get(m.id) ?? 4;
        r += mr + 3;
        moonRadius.set(m.id, r);
        r += mr + 4;
      }
    }
  }
  const orbitR = (b: Body) => {
    if (!b.orbit_radius || b.orbit_radius <= 0) return 0;
    const moon = moonRadius.get(b.id);
    if (moon != null) return moon;
    const pr = b.parent_body_id ? (bodyR.get(b.parent_body_id) ?? 0) : 0;
    return Math.log10(1 + b.orbit_radius) * 230 + pr + (bodyR.get(b.id) ?? 0) + 16;
  };
  const pos = (id: string, t: number, depth = 0): { x: number; y: number } => {
    const b = byId.get(id);
    if (!b || depth > 4) return { x: 0, y: 0 };
    if (!b.parent_body_id || !b.orbit_period) return { x: 0, y: 0 };
    const p = pos(b.parent_body_id, t, depth + 1);
    const ang = (b.angle0 ?? 0) + (t / Math.max(1, b.orbit_period)) * Math.PI * 2;
    const r = orbitR(b);
    return { x: p.x + Math.cos(ang) * r, y: p.y + Math.sin(ang) * r };
  };

  // ---- data ------------------------------------------------------------
  const timeline = new MatchTimeline();
  let events: MatchEvent[] = [];
  type Shot = { from: number; to: number; bodyId: string | null };
  let shots: Shot[] = [];
  const MIN_SHOT_TICKS = 10;
  const rebuildShots = () => {
    events = mineEvents(timeline.rows, summary);
    shots = [];
    const lo = summary.ticks.lo ?? 0, hi = summary.ticks.hi ?? lo;
    let cursor = lo;
    while (cursor <= hi) {
      const end = cursor + MIN_SHOT_TICKS;
      const best = events
        .filter(e => e.tick >= cursor && e.tick < end && e.bodyId && byId.has(e.bodyId))
        .sort((a, b) => b.weight - a.weight)[0];
      shots.push({ from: cursor, to: end, bodyId: best ? best.bodyId : null });
      cursor = end;
    }
  };

  // ---- camera ----------------------------------------------------------
  //
  // x,y = map point at canvas centre; scale = px per map unit. The
  // director sets a target per shot; the camera eases toward it every
  // frame, so every take is a move and no cut is a jump.
  const cam = { x: 0, y: 0, scale: 1 };
  const target = { x: 0, y: 0, scale: 1 };
  let camInit = false;
  let viewMode: 'auto' | 'wide' = 'auto';

  const fitAll = (t: number) => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const b of bodies) {
      if (b.type !== 'star' && !b.parent_body_id) continue;
      const p = pos(b.id, t);
      const r = (bodyR.get(b.id) ?? 4) + 8;
      x0 = Math.min(x0, p.x - r); x1 = Math.max(x1, p.x + r);
      y0 = Math.min(y0, p.y - r); y1 = Math.max(y1, p.y + r);
    }
    if (!isFinite(x0)) { target.x = 0; target.y = 0; target.scale = 1; return; }
    const bw = Math.max(40, x1 - x0), bh = Math.max(40, y1 - y0);
    target.x = (x0 + x1) / 2; target.y = (y0 + y1) / 2;
    target.scale = Math.min((W - 260) / bw, (H - 60) / bh) * 0.94;
  };

  const aim = (t: number) => {
    if (!shots.length) rebuildShots();
    const shot = shots.find(s => t >= s.from && t < s.to) ?? shots[shots.length - 1];
    if (viewMode === 'auto' && shot?.bodyId && byId.has(shot.bodyId)) {
      const p = pos(shot.bodyId, t);
      const r = (bodyR.get(shot.bodyId) ?? 6) + 56;
      target.x = p.x; target.y = p.y;
      target.scale = Math.min(W - 260, H - 60) / (r * 2) * 0.9;
    } else {
      fitAll(t);
    }
    if (!camInit) { cam.x = target.x; cam.y = target.y; cam.scale = target.scale; camInit = true; }
    const k = 0.06;
    cam.x += (target.x - cam.x) * k;
    cam.y += (target.y - cam.y) * k;
    cam.scale += (target.scale - cam.scale) * k;
  };
  const toPx = (p: { x: number; y: number }) =>
    ({ x: W / 2 + (p.x - cam.x) * cam.scale, y: H / 2 + (p.y - cam.y) * cam.scale });

  // ---- starfield (own, cheap, parallaxed) ------------------------------
  const stars: Array<[number, number, number]> = [];
  {
    const rnd = mulberry32(0x5a7e);
    for (let i = 0; i < 420; i++) stars.push([rnd(), rnd(), 0.4 + rnd() * 1.4]);
  }

  // ---- textures --------------------------------------------------------
  const bodyLike = (b: Body, t: number) => ({
    id: bareId(b.id), type: b.type, color: b.color || '#b06a3f',
    radius: b.radius, orbitRadius: b.orbit_radius ?? 0,
    terraformedAtTick: b.terraformed_at_tick, terraformCompletesAtTick: null,
    resources: { metal: 0, fuel: 0, gold: 0, science: 0 },
    _t: t,
  }) as any;

  // ---- state -----------------------------------------------------------
  let world: MatchWorld = timeline.worldAt(summary.ticks.lo ?? 0);
  let worldTick = -1;
  let curTick = 0, curFrac = 0;

  function setTick(tick: number, frac: number) {
    if (tick !== worldTick) { world = timeline.worldAt(tick); worldTick = tick; }
    curTick = tick; curFrac = frac;
    aim(tick + frac);
  }

  // ---- render ----------------------------------------------------------
  function render() {
    const t = curTick + curFrac;
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.fillStyle = '#03060d';
    ctx.fillRect(0, 0, W, H);

    // Stars, drifting a touch with the camera so pans read as motion.
    ctx.fillStyle = '#cfe0f2';
    for (const [sx, sy, sz] of stars) {
      const x = ((sx * W - cam.x * 0.02 * sz) % W + W) % W;
      const y = ((sy * H - cam.y * 0.02 * sz) % H + H) % H;
      ctx.globalAlpha = 0.25 + sz * 0.3;
      ctx.fillRect(x, y, sz, sz);
    }
    ctx.globalAlpha = 1;

    // Orbit rings, faint.
    ctx.strokeStyle = 'rgba(120,150,190,0.16)';
    ctx.lineWidth = 1;
    for (const b of bodies) {
      if (!b.parent_body_id || !b.orbit_period) continue;
      const pp = toPx(pos(b.parent_body_id, t));
      const rp = orbitR(b) * cam.scale;
      if (rp < 6 || rp > 6000) continue;
      ctx.beginPath(); ctx.arc(pp.x, pp.y, rp, 0, Math.PI * 2); ctx.stroke();
    }

    // Ownership, from settlements at this tick: body -> faction.
    const owner = new Map<string, string | null>();
    for (const s of world.stls.values()) if (s.fid) owner.set(s.body, s.fid);

    // Bodies.
    const labelAt: Array<{ x: number; y: number; r: number; name: string; fid: string | null }> = [];
    for (const b of bodies) {
      if (b.destroyed_at_tick != null && curTick >= b.destroyed_at_tick) continue;
      if (b.type !== 'star' && !b.parent_body_id) continue;
      const p = toPx(pos(b.id, t));
      const r = (bodyR.get(b.id) ?? 4) * cam.scale;
      if (p.x < -r - 40 || p.x > W + r + 40 || p.y < -r - 40 || p.y > H + r + 40) continue;

      const fid = owner.get(b.id) ?? null;
      if (b.type === 'star') {
        const g = ctx.createRadialGradient(p.x, p.y, r * 0.2, p.x, p.y, r * 2.4);
        g.addColorStop(0, 'rgba(255,244,214,1)');
        g.addColorStop(0.35, 'rgba(255,214,140,0.9)');
        g.addColorStop(1, 'rgba(255,180,90,0)');
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(p.x, p.y, r * 2.4, 0, Math.PI * 2); ctx.fill();
        continue;
      }
      // Territory: a soft halo in the owner's colour, the read that
      // matters most at the wide shot.
      if (fid) {
        const g = ctx.createRadialGradient(p.x, p.y, r, p.x, p.y, r * 3.2);
        g.addColorStop(0, hexA(colorOf(fid), 0.28));
        g.addColorStop(1, hexA(colorOf(fid), 0));
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(p.x, p.y, r * 3.2, 0, Math.PI * 2); ctx.fill();
      }
      // The world, as its map texture.
      const terraformed = b.terraformed_at_tick != null && curTick >= b.terraformed_at_tick;
      const tex = (terraformed ? getTerraformedTexture(bodyLike(b, t)) : null)
        ?? getPlanetTexture(bodyLike(b, t));
      ctx.save();
      ctx.beginPath(); ctx.arc(p.x, p.y, Math.max(1.5, r), 0, Math.PI * 2); ctx.clip();
      if (tex && r >= 2.5) {
        ctx.drawImage(tex, p.x - r, p.y - r, r * 2, r * 2);
      } else {
        ctx.fillStyle = b.color || '#8a7a6a';
        ctx.fillRect(p.x - r, p.y - r, r * 2, r * 2);
      }
      ctx.restore();
      // Owner ring.
      if (fid) {
        ctx.strokeStyle = colorOf(fid); ctx.lineWidth = Math.max(1, r * 0.12);
        ctx.beginPath(); ctx.arc(p.x, p.y, r + 2, 0, Math.PI * 2); ctx.stroke();
      }
      if (r >= 5 && b.name) labelAt.push({ x: p.x, y: p.y, r, name: b.name, fid });
    }

    // Ships: clustered at their parent, arranged per faction in an arc,
    // drawn as the map's own icons. Big harbours get a count badge.
    const harbour = new Map<string, Map<string, string[]>>();
    for (const [id, s] of world.ships) {
      const parent = s.parent ?? '';
      if (!harbour.has(parent)) harbour.set(parent, new Map());
      const perF = harbour.get(parent)!;
      const key = s.fid ?? 'n';
      if (!perF.has(key)) perF.set(key, []);
      perF.get(key)!.push(id);
    }
    const iconPx = Math.max(9, Math.min(22, cam.scale * 5.5));
    for (const [parent, perF] of harbour) {
      if (!byId.has(parent)) continue;
      const pp = toPx(pos(parent, t));
      const base = ((bodyR.get(parent) ?? 4) + 7) * cam.scale;
      let fi = 0;
      for (const [fid, ids] of perF) {
        const fa = (hashStr(fid) % 628) / 100 + fi * 1.1;
        const shown = Math.min(ids.length, 8);
        for (let i = 0; i < shown; i++) {
          const s = world.ships.get(ids[i])!;
          const ring = base + iconPx * (0.9 + Math.floor(i / 4) * 0.9);
          const ang = fa + (i % 4) * 0.42 + t * 0.01;
          const x = pp.x + Math.cos(ang) * ring, y = pp.y + Math.sin(ang) * ring;
          const img = getShipIconImage(iconClassOf(s.cls), colorOf(s.fid), s.iv,
            color2Of(s.fid));
          if (img) {
            ctx.save(); ctx.translate(x, y); ctx.rotate(ang + Math.PI / 2);
            ctx.drawImage(img, -iconPx / 2, -iconPx / 2, iconPx, iconPx);
            ctx.restore();
          } else {
            ctx.fillStyle = colorOf(s.fid);
            ctx.beginPath(); ctx.arc(x, y, iconPx * 0.3, 0, Math.PI * 2); ctx.fill();
          }
        }
        if (ids.length > shown) {
          const ang = fa + 0.2 * 4;
          const ring = base + iconPx * 1.8;
          badge(ctx, pp.x + Math.cos(ang) * ring, pp.y + Math.sin(ang) * ring,
            `+${ids.length - shown}`, colorOf(fid === 'n' ? null : fid));
        }
        fi++;
      }
    }

    // Events at this tick: battles pulse, losses flash, foundings ring.
    for (const b of summary.battles) {
      const end = b.ended_tick ?? b.started_tick;
      if (curTick < b.started_tick || curTick > end || !b.body_id) continue;
      const id = b.body_id;
      if (!byId.has(id)) continue;
      const p = toPx(pos(id, t));
      const r = (bodyR.get(id) ?? 4) * cam.scale + 14;
      const pulse = 0.5 + 0.5 * Math.sin(t * 9);
      ctx.strokeStyle = `rgba(255,110,80,${0.35 + pulse * 0.45})`;
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(p.x, p.y, r + pulse * 6, 0, Math.PI * 2); ctx.stroke();
      // Crossfire between the two biggest harbours at the body.
      const perF = harbour.get(id);
      if (perF && perF.size >= 2) {
        const rnd = mulberry32(hashStr(id) + Math.floor(t * 6));
        for (let i = 0; i < 3; i++) {
          const a1 = rnd() * Math.PI * 2, a2 = a1 + Math.PI * (0.6 + rnd() * 0.8);
          const rr = r * 0.9;
          ctx.strokeStyle = `rgba(255,220,160,${0.5 + rnd() * 0.4})`;
          ctx.lineWidth = 1.2;
          ctx.beginPath();
          ctx.moveTo(p.x + Math.cos(a1) * rr, p.y + Math.sin(a1) * rr);
          ctx.lineTo(p.x + Math.cos(a2) * rr * 0.6, p.y + Math.sin(a2) * rr * 0.6);
          ctx.stroke();
        }
      }
    }
    for (const e of events) {
      if (e.tick !== curTick || !e.bodyId || !byId.has(e.bodyId)) continue;
      const p = toPx(pos(e.bodyId, t));
      const r0 = (bodyR.get(e.bodyId) ?? 4) * cam.scale;
      const k = Math.min(1, curFrac);
      if (e.kind === 'loss') {
        ctx.fillStyle = `rgba(255,150,70,${(1 - k) * 0.5})`;
        ctx.beginPath(); ctx.arc(p.x, p.y, r0 + 10 + k * 26, 0, Math.PI * 2); ctx.fill();
      } else if (e.kind === 'founded' || e.kind === 'fallen') {
        const fid = owner.get(e.bodyId) ?? null;
        ctx.strokeStyle = hexA(e.kind === 'founded' ? colorOf(fid) : '#ff6a5a', 1 - k);
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(p.x, p.y, r0 + 4 + k * 30, 0, Math.PI * 2); ctx.stroke();
      }
    }

    // Labels, after everything so they sit on top.
    ctx.font = '11px system-ui, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    for (const l of labelAt) {
      ctx.fillStyle = 'rgba(4,8,14,0.7)';
      const w = ctx.measureText(l.name).width + 8;
      ctx.fillRect(l.x - w / 2, l.y + l.r + 4, w, 14);
      ctx.fillStyle = l.fid ? colorOf(l.fid) : '#cfe0ee';
      ctx.fillText(l.name, l.x, l.y + l.r + 5);
    }

    drawHud(t);
  }

  // ---- HUD: the clock and the empires ---------------------------------
  //
  // This is where the metrics earn their keep on screen: every faction's
  // fleet size and stockpiles, live per tick, in its own colour.
  function drawHud(t: number) {
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.font = '600 13px system-ui, sans-serif';
    ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    ctx.fillStyle = 'rgba(4,8,14,0.75)';
    ctx.fillRect(10, 10, 96, 24);
    ctx.fillStyle = '#e6f0f8';
    ctx.fillText(`T+${Math.floor(t)}`, 18, 15);

    const fleets = new Map<string, number>();
    for (const s of world.ships.values()) {
      const k = s.fid ?? 'n'; fleets.set(k, (fleets.get(k) ?? 0) + 1);
    }
    const worlds = new Map<string, number>();
    for (const s of world.stls.values()) {
      if (!s.fid) continue; worlds.set(s.fid, (worlds.get(s.fid) ?? 0) + 1);
    }
    const rows = summary.factions.slice(0, 9);
    const x0 = W - 240, y0 = 10, rowH = 46;
    ctx.fillStyle = 'rgba(4,8,14,0.72)';
    ctx.fillRect(x0, y0, 230, rows.length * rowH + 10);
    let maxStock = 1;
    for (const f of rows) {
      const st = world.stock.get(f.id);
      if (st) maxStock = Math.max(maxStock, ...st.slice(0, 4));
    }
    rows.forEach((f, i) => {
      const y = y0 + 8 + i * rowH;
      ctx.fillStyle = f.color || NEUTRAL;
      ctx.fillRect(x0 + 8, y + 3, 8, 8);
      ctx.fillStyle = '#e6f0f8';
      ctx.font = '600 11px system-ui, sans-serif';
      ctx.fillText(f.name.slice(0, 22), x0 + 22, y);
      ctx.fillStyle = '#9fb3c8';
      ctx.font = '10px system-ui, sans-serif';
      ctx.textAlign = 'right';
      ctx.fillText(`${fleets.get(f.id) ?? 0} ships · ${worlds.get(f.id) ?? 0} worlds`,
        x0 + 222, y);
      ctx.textAlign = 'left';
      // Stock bars: metal, gold, fuel, science.
      const st = world.stock.get(f.id) ?? [0, 0, 0, 0];
      const cols = ['#9aa7b6', '#e8c36a', '#e88a4a', '#6fb4ee'];
      for (let k = 0; k < 4; k++) {
        const bw = Math.max(1, (Math.max(0, st[k]) / maxStock) * 200);
        ctx.fillStyle = 'rgba(255,255,255,0.06)';
        ctx.fillRect(x0 + 22, y + 16 + k * 5, 200, 3);
        ctx.fillStyle = cols[k];
        ctx.fillRect(x0 + 22, y + 16 + k * 5, bw, 3);
      }
    });
  }

  function resize(w: number, h: number) {
    DPR = Math.min(2, window.devicePixelRatio || 1);
    W = w; H = h;
    canvas.width = Math.round(w * DPR); canvas.height = Math.round(h * DPR);
    canvas.style.width = `${w}px`; canvas.style.height = `${h}px`;
  }
  resize(canvas.clientWidth || 1280, canvas.clientHeight || 720);

  return {
    setTick, render, resize,
    applyRows: (rows: SnapshotRow[]) => { timeline.append(rows); rebuildShots(); },
    dispose: () => { /* nothing held */ },
    worldAt: (tick: number) => timeline.worldAt(tick),
    setView: (mode: 'auto' | 'wide') => { viewMode = mode; },
  };
}

// ---- helpers ------------------------------------------------------------

function hexA(hex: string, a: number): string {
  const h = hex.replace('#', '');
  const n = h.length === 3
    ? h.split('').map(c => parseInt(c + c, 16))
    : [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16));
  if (n.some(v => Number.isNaN(v))) return `rgba(138,159,179,${a})`;
  return `rgba(${n[0]},${n[1]},${n[2]},${Math.max(0, Math.min(1, a))})`;
}

function badge(ctx: CanvasRenderingContext2D, x: number, y: number,
               text: string, color: string) {
  ctx.font = '600 10px system-ui, sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  const w = ctx.measureText(text).width + 8;
  ctx.fillStyle = 'rgba(4,8,14,0.8)';
  ctx.fillRect(x - w / 2, y - 7, w, 14);
  ctx.strokeStyle = color; ctx.lineWidth = 1;
  ctx.strokeRect(x - w / 2, y - 7, w, 14);
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
}
