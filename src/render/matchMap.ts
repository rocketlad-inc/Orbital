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

  /** A body is on screen only if it actually orbits something. */
  const drawableAt = (b: Body, tick: number) =>
    (b.type === 'star' || (!!b.parent_body_id && !!b.orbit_period))
    && !(b.destroyed_at_tick != null && tick >= b.destroyed_at_tick);

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
        .filter(e => e.tick >= cursor && e.tick < end && e.bodyId
          && byId.has(e.bodyId) && drawableAt(byId.get(e.bodyId)!, e.tick))
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
  let lastFocus: string | null = null;
  let viewMode: 'auto' | 'wide' = 'auto';

  /** Right-hand panel width; the camera keeps the subject clear of it. */
  const PANEL_W = 250;
  const SAFE = 44;

  const fitAll = (t: number) => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const b of bodies) {
      if (!drawableAt(b, Math.floor(t))) continue;
      const p = pos(b.id, t);
      const r = (bodyR.get(b.id) ?? 4) + 8;
      x0 = Math.min(x0, p.x - r); x1 = Math.max(x1, p.x + r);
      y0 = Math.min(y0, p.y - r); y1 = Math.max(y1, p.y + r);
    }
    if (!isFinite(x0)) { target.x = 0; target.y = 0; target.scale = 1; return; }
    const bw = Math.max(40, x1 - x0), bh = Math.max(40, y1 - y0);
    const availW = W - PANEL_W - SAFE * 2, availH = H - SAFE * 2;
    target.scale = Math.min(availW / bw, availH / bh) * 0.96;
    // Centre in the space LEFT of the panel, not the raw canvas, so the
    // system is never half-hidden behind the empire list.
    target.x = (x0 + x1) / 2 + (PANEL_W / 2) / target.scale;
    target.y = (y0 + y1) / 2;
  };

  /**
   * Frame the tick's subject: the body, its fleet ring and its effect
   * radius, filling a healthy share of the frame.
   *
   * Reviewers measured event subjects at 4-13% of frame width against a
   * ~30-45% norm for shipped replays. The fit box is the whole event,
   * not the body's centre, and there is a zoom floor so a small moon
   * still reads.
   */
  const fitBody = (id: string, t: number) => {
    const p = pos(id, t);
    const br = bodyR.get(id) ?? 6;
    const extent = br + 46;
    const availW = W - PANEL_W - SAFE * 2, availH = H - SAFE * 2;
    target.scale = Math.min(availW, availH) / (extent * 2) * 0.9;
    target.x = p.x + (PANEL_W / 2) / target.scale;
    target.y = p.y;
  };

  const toPx = (p: { x: number; y: number }) =>
    ({ x: W / 2 + (p.x - cam.x) * cam.scale, y: H / 2 + (p.y - cam.y) * cam.scale });

  const aim = (t: number, dTicks: number) => {
    if (!shots.length) rebuildShots();
    const shot = shots.find(s => t >= s.from && t < s.to) ?? shots[shots.length - 1];
    const focusId = viewMode === 'auto' && shot?.bodyId && byId.has(shot.bodyId)
      && drawableAt(byId.get(shot.bodyId)!, Math.floor(t)) ? shot.bodyId : null;
    if (focusId) fitBody(focusId, t); else fitAll(t);

    if (!camInit) {
      cam.x = target.x; cam.y = target.y; cam.scale = target.scale;
      camInit = true; lastFocus = focusId; return;
    }
    // CUT, DON'T PAN, when the subject changes to somewhere far away.
    // A pan between distant bodies at event zoom crosses nothing but
    // starfield -- three reviewers independently reported those as dead
    // frames. A cut costs one frame; a pan costs seconds of empty film.
    if (focusId !== lastFocus) {
      const far = Math.hypot(target.x - cam.x, target.y - cam.y) * cam.scale;
      const zoomJump = Math.max(target.scale / cam.scale, cam.scale / target.scale);
      if (far > W * 0.75 || zoomJump > 2.5) {
        cam.x = target.x; cam.y = target.y; cam.scale = target.scale;
      }
      lastFocus = focusId;
    }
    // Frame-rate INDEPENDENT easing. A fixed per-frame k converges in a
    // second at 60fps and takes half a shot at 12fps, so the camera's
    // speed silently depended on the machine.
    const k = 1 - Math.exp(-7 * Math.max(0.0001, Math.min(0.5, dTicks)));
    cam.x += (target.x - cam.x) * k;
    cam.y += (target.y - cam.y) * k;
    cam.scale += (target.scale - cam.scale) * k;

    // GUARANTEE: never render a frame with nothing in it.
    let visible = false;
    for (const b of bodies) {
      if (!drawableAt(b, Math.floor(t))) continue;
      const q = toPx(pos(b.id, t));
      const r = (bodyR.get(b.id) ?? 4) * cam.scale;
      if (q.x > -r && q.x < W - PANEL_W + r && q.y > -r && q.y < H + r) {
        visible = true; break;
      }
    }
    if (!visible) { cam.x = target.x; cam.y = target.y; cam.scale = target.scale; }
  };
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

  let lastT = -1;
  function setTick(tick: number, frac: number) {
    if (tick !== worldTick) { world = timeline.worldAt(tick); worldTick = tick; }
    curTick = tick; curFrac = frac;
    const t = tick + frac;
    const d = lastT < 0 ? 1 : Math.abs(t - lastT);
    lastT = t;
    aim(t, d);
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
          const rr = r * 1.7;
          // Near-white and long, so fire never reads as another ship
          // icon: a reviewer counted yellow streaks among yellow hulls
          // and could not tell shooting from parked.
          ctx.strokeStyle = `rgba(255,248,224,${0.6 + rnd() * 0.4})`;
          ctx.lineWidth = 1.6;
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

    // CAPTION. Nothing named what you were watching: a red ring pulsed
    // with no indication of who was fighting whom. The participants come
    // from who actually has hulls at the body this tick.
    {
      const shot = shots.find(x => t >= x.from && t < x.to);
      const fid0 = shot?.bodyId;
      if (fid0 && byId.has(fid0) && drawableAt(byId.get(fid0)!, curTick)) {
        const live = summary.battles.some(b => b.body_id === fid0
          && curTick >= b.started_tick && curTick <= (b.ended_tick ?? b.started_tick));
        const ev = events.find(e => e.bodyId === fid0
          && Math.abs(e.tick - curTick) <= 1 && e.kind !== 'pact');
        const sides = [...(harbour.get(fid0)?.keys() ?? [])]
          .filter(k => k !== 'n')
          .map(k => faction(k)?.name ?? '')
          .filter(Boolean).slice(0, 3);
        let line = '';
        if (live) {
          line = `Battle at ${byId.get(fid0)!.name ?? 'this world'}`
            + (sides.length >= 2 ? ` — ${sides.join(' vs ')}` : '');
        } else if (ev?.kind === 'founded') {
          line = `Settlement founded on ${byId.get(fid0)!.name ?? 'this world'}`;
        } else if (ev?.kind === 'fallen') {
          line = `Settlement lost on ${byId.get(fid0)!.name ?? 'this world'}`;
        } else if (ev?.kind === 'loss') {
          line = `${ev.count ?? 1} ship${(ev.count ?? 1) === 1 ? '' : 's'} lost`
            + ` at ${byId.get(fid0)!.name ?? 'this world'}`;
        }
        if (line) {
          const p = toPx(pos(fid0, t));
          const r0 = (bodyR.get(fid0) ?? 6) * cam.scale;
          ctx.font = '600 14px system-ui, sans-serif';
          ctx.textAlign = 'center'; ctx.textBaseline = 'top';
          const wpx = ctx.measureText(line).width + 18;
          const cy = Math.min(H - 46, p.y + r0 + 26);
          ctx.fillStyle = 'rgba(4,8,14,0.82)';
          ctx.fillRect(p.x - wpx / 2, cy, wpx, 22);
          ctx.strokeStyle = 'rgba(150,180,215,0.35)'; ctx.lineWidth = 1;
          ctx.strokeRect(p.x - wpx / 2, cy, wpx, 22);
          ctx.fillStyle = '#e6f0f8';
          ctx.fillText(line, p.x, cy + 4);
        }
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

    const fleets = new Map<string, number>();
    for (const s2 of world.ships.values()) {
      const k = s2.fid ?? 'n'; fleets.set(k, (fleets.get(k) ?? 0) + 1);
    }
    const worlds = new Map<string, number>();
    for (const s2 of world.stls.values()) {
      if (!s2.fid) continue; worlds.set(s2.fid, (worlds.get(s2.fid) ?? 0) + 1);
    }

    // SORTED BY WORLDS, THEN FLEET. The panel used to sit in seat order,
    // so the leader was indistinguishable from an eliminated empire in
    // the same 11px type -- you could not name who was winning at any
    // moment. Rank is now the row order, and overtakes are visible.
    const rows = [...summary.factions].sort((x, y) =>
      (worlds.get(y.id) ?? 0) - (worlds.get(x.id) ?? 0)
      || (fleets.get(y.id) ?? 0) - (fleets.get(x.id) ?? 0)).slice(0, 9);

    const PW = 240, rowH = 30;
    const px0 = W - PW - 8, py0 = 10;
    const panelH = rows.length * rowH + 34;
    ctx.fillStyle = 'rgba(4,8,14,0.8)';
    ctx.fillRect(px0, py0, PW, panelH);
    ctx.strokeStyle = 'rgba(120,150,190,0.25)'; ctx.lineWidth = 1;
    ctx.strokeRect(px0 + 0.5, py0 + 0.5, PW - 1, panelH - 1);

    ctx.font = '600 10px system-ui, sans-serif';
    ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    ctx.fillStyle = '#7f97ad';
    ctx.fillText('EMPIRE', px0 + 26, py0 + 8);
    ctx.textAlign = 'right';
    ctx.fillText('FLEET · WORLDS', px0 + PW - 10, py0 + 8);

    rows.forEach((f, i) => {
      const y = py0 + 24 + i * rowH;
      const nWorlds = worlds.get(f.id) ?? 0, nShips = fleets.get(f.id) ?? 0;
      // Eliminated empires are dimmed and struck, not drawn at full
      // brightness with stale bars implying a live economy.
      const dead = nWorlds === 0 && nShips === 0;
      ctx.globalAlpha = dead ? 0.34 : 1;
      if (i === 0 && !dead) {
        ctx.fillStyle = 'rgba(120,160,210,0.12)';
        ctx.fillRect(px0 + 2, y - 3, PW - 4, rowH - 2);
      }
      ctx.fillStyle = '#6f88a3';
      ctx.font = '600 10px system-ui, sans-serif';
      ctx.textAlign = 'left'; ctx.textBaseline = 'top';
      ctx.fillText(String(i + 1), px0 + 8, y + 2);
      ctx.fillStyle = f.color || NEUTRAL;
      ctx.fillRect(px0 + 20, y + 2, 9, 9);
      ctx.strokeStyle = 'rgba(255,255,255,0.45)'; ctx.lineWidth = 1;
      ctx.strokeRect(px0 + 20.5, y + 2.5, 8, 8);

      // A FIXED GUTTER for the numbers, and the name truncated to fit.
      // Two empires' fleet counts were unreadable in every frame because
      // the name column and the count column shared pixels.
      const GUT = 96;
      const nameMax = PW - 34 - GUT - 10;
      ctx.fillStyle = dead ? '#8d9aa6' : '#e6f0f8';
      ctx.font = '600 11px system-ui, sans-serif';
      let nm = f.name;
      if (ctx.measureText(nm).width > nameMax) {
        while (nm.length > 1 && ctx.measureText(nm + '…').width > nameMax) {
          nm = nm.slice(0, -1);
        }
        nm += '…';
      }
      ctx.fillText(nm, px0 + 34, y + 1);
      if (dead) {
        const wpx = ctx.measureText(nm).width;
        ctx.strokeStyle = '#8d9aa6'; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(px0 + 34, y + 7);
        ctx.lineTo(px0 + 34 + wpx, y + 7); ctx.stroke();
      }
      ctx.textAlign = 'right';
      ctx.fillStyle = dead ? '#7c8895' : '#b9cbdb';
      ctx.font = '11px system-ui, sans-serif';
      ctx.fillText(nShips + ' · ' + nWorlds, px0 + PW - 10, y + 1);

      // ONE stacked bar with a legend, not four unlabelled hairlines.
      // The old bars had no scale, no units and no key, so they taught
      // the viewer to ignore them.
      if (!dead) {
        const st = world.stock.get(f.id) ?? [0, 0, 0, 0];
        const total = Math.max(1, st.reduce((a2, v) => a2 + Math.max(0, v), 0));
        const cols = ['#9aa7b6', '#e8c36a', '#e88a4a', '#6fb4ee'];
        let bx = px0 + 34;
        const bw = PW - 44;
        ctx.fillStyle = 'rgba(255,255,255,0.07)';
        ctx.fillRect(bx, y + 16, bw, 6);
        for (let k = 0; k < 4; k++) {
          const seg = (Math.max(0, st[k]) / total) * bw;
          if (seg <= 0.4) continue;
          ctx.fillStyle = cols[k];
          ctx.fillRect(bx, y + 16, seg, 6);
          bx += seg;
        }
      }
      ctx.globalAlpha = 1;
    });

    // Legend for the stacked bar, once, under the panel.
    {
      const ly = py0 + panelH + 6;
      const keys: Array<[string, string]> = [['metal', '#9aa7b6'],
        ['gold', '#e8c36a'], ['fuel', '#e88a4a'], ['science', '#6fb4ee']];
      ctx.font = '9px system-ui, sans-serif';
      ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      let lx = px0 + 4;
      for (const [name, col] of keys) {
        ctx.fillStyle = col; ctx.fillRect(lx, ly - 3, 7, 7);
        ctx.fillStyle = '#8ea3b8';
        ctx.fillText(name, lx + 10, ly + 1);
        lx += 12 + ctx.measureText(name).width + 10;
      }
    }

    // ---- clock + timeline -------------------------------------------
    //
    // Nothing said where a tick fell in the match. The bar shows the
    // whole war at a glance, with a mark at every battle.
    const lo = summary.ticks.lo ?? 0, hi = summary.ticks.hi ?? lo;
    const barY = H - 26, barX = 16, barW = W - PW - 40;
    ctx.fillStyle = 'rgba(4,8,14,0.8)';
    ctx.fillRect(barX - 8, barY - 16, barW + 16, 30);
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    ctx.fillRect(barX, barY, barW, 3);
    for (const bt of summary.battles) {
      const f = (bt.started_tick - lo) / Math.max(1, hi - lo);
      ctx.fillStyle = 'rgba(255,120,90,0.75)';
      ctx.fillRect(barX + f * barW, barY - 3, 1.5, 9);
    }
    const fx = (Math.floor(t) - lo) / Math.max(1, hi - lo);
    ctx.fillStyle = '#6fb4ee';
    ctx.fillRect(barX, barY, Math.max(1, fx * barW), 3);
    ctx.beginPath();
    ctx.arc(barX + fx * barW, barY + 1.5, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.font = '600 12px system-ui, sans-serif';
    ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
    ctx.fillStyle = '#e6f0f8';
    ctx.fillText('T+' + Math.floor(t), barX, barY - 6);
    ctx.textAlign = 'right';
    ctx.fillStyle = '#7f97ad';
    ctx.fillText('of ' + hi, barX + barW, barY - 6);
    if (world.synthetic) {
      ctx.textAlign = 'left';
      ctx.fillStyle = '#7f97ad';
      ctx.font = '9px system-ui, sans-serif';
      ctx.fillText('RECONSTRUCTED', barX + 54, barY - 7);
    }
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
