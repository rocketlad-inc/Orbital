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
  /**
   * Standings over the whole match, computed once when rows arrive.
   *
   * Rank changes and eliminations were happening silently -- the panel
   * simply re-sorted and a row greyed out -- so the two most dramatic
   * things in a campaign passed unmarked. Precomputing is also what lets
   * the stockpile bars share ONE scale: normalised per row they were
   * every bar full, which is worse than no bar.
   */
  const rankAt = new Map<number, Map<string, number>>();
  const elimAt = new Map<string, number>();
  let stockMax = 1;
  const rebuildStandings = () => {
    rankAt.clear(); elimAt.clear(); stockMax = 1;
    const lo = summary.ticks.lo ?? 0, hi = summary.ticks.hi ?? lo;
    const alive = new Set<string>();
    for (let t = lo; t <= hi; t++) {
      const w = timeline.worldAt(t);
      const worlds = new Map<string, number>();
      for (const st of w.stls.values()) {
        if (st.fid) worlds.set(st.fid, (worlds.get(st.fid) ?? 0) + 1);
      }
      const fleets = new Map<string, number>();
      for (const sh of w.ships.values()) {
        const k = sh.fid ?? 'n'; fleets.set(k, (fleets.get(k) ?? 0) + 1);
      }
      for (const v of w.stock.values()) {
        for (const n of v) stockMax = Math.max(stockMax, n || 0);
      }
      const order = [...summary.factions].sort((x, y) =>
        (worlds.get(y.id) ?? 0) - (worlds.get(x.id) ?? 0)
        || (fleets.get(y.id) ?? 0) - (fleets.get(x.id) ?? 0));
      const m = new Map<string, number>();
      order.forEach((f, i) => m.set(f.id, i + 1));
      rankAt.set(t, m);
      for (const f of summary.factions) {
        const has = (worlds.get(f.id) ?? 0) + (fleets.get(f.id) ?? 0) > 0;
        if (has) alive.add(f.id);
        else if (alive.has(f.id) && !elimAt.has(f.id)) elimAt.set(f.id, t);
      }
    }
  };

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
  /** The timeline lives here; the camera must never compose under it. */
  const SAFE_BOTTOM = 78;

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
    const availW = W - PANEL_W - SAFE * 2;
    const availH = H - SAFE - SAFE_BOTTOM;
    target.scale = Math.min(availW / bw, availH / bh) * 0.96;
    // Centre in the space LEFT of the panel, not the raw canvas, so the
    // system is never half-hidden behind the empire list.
    target.x = (x0 + x1) / 2 + (PANEL_W / 2) / target.scale;
    target.y = (y0 + y1) / 2 + (SAFE_BOTTOM - SAFE) / 2 / target.scale;
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
    // The frame is the BODY PLUS ITS HARBOUR, and it must fill the shot.
    // Reviewers measured subjects at 1.4-5% of canvas against a 30-45%
    // norm: the old extent was dominated by a +46 constant, so a small
    // asteroid framed the same as a gas giant and rendered ~23px in a
    // 1280 frame. Extent scales with the body, and the body itself has a
    // floor in screen pixels so a rock still reads.
    const extent = br + 26;
    const availW = W - PANEL_W - SAFE * 2;
    const availH = H - SAFE - SAFE_BOTTOM;
    let sc = Math.min(availW, availH) * 0.78 / (extent * 2);
    sc = Math.max(sc, 28 / Math.max(2, br));
    target.scale = sc;
    target.x = p.x + (PANEL_W / 2) / sc;
    target.y = p.y + (SAFE_BOTTOM - SAFE) / 2 / sc;
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
          // NO color2 HERE. prewarmShipIcons warms keys without a trim
          // colour, and the cache key includes it -- so every request
          // with color2 missed the prewarm, returned null while it
          // rasterised, and drew the fallback dot. At harbour scale the
          // primary colour is the whole read anyway.
          const img = getShipIconImage(iconClassOf(s.cls), colorOf(s.fid), s.iv);
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
          // Anchored to the body's own ring, not to the fleet's bounding
          // box: overflow chips were floating ~200px from anything.
          const ang = fa + 0.9;
          const ring = base + iconPx * 0.6;
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
      // COMBAT IS ITS OWN CHANNEL, never a hue from the empire palette.
      // The old red ring read as Frowny Face's pink ownership halo, so a
      // contested rock and an owned rock looked the same.
      const pulse = 0.5 + 0.5 * Math.sin(t * 9);
      ctx.strokeStyle = `rgba(255,255,255,${0.5 + pulse * 0.4})`;
      ctx.lineWidth = 2.5;
      ctx.setLineDash([7, 6]);
      ctx.beginPath(); ctx.arc(p.x, p.y, r + pulse * 5, 0, Math.PI * 2); ctx.stroke();
      ctx.setLineDash([]);
      ctx.strokeStyle = `rgba(210,235,255,${(1 - pulse) * 0.35})`;
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(p.x, p.y, r + 8 + pulse * 22, 0, Math.PI * 2); ctx.stroke();
      // Crossfire between the two biggest harbours at the body.
      const perF = harbour.get(id);
      if (perF && perF.size >= 2) {
        const rnd = mulberry32(hashStr(id) + Math.floor(t * 6));
        const sideCols = [...perF.keys()].filter(k => k !== 'n').map(colorOf);
        for (let i = 0; i < 3; i++) {
          const a1 = rnd() * Math.PI * 2, a2 = a1 + Math.PI * (0.6 + rnd() * 0.8);
          // Short. At 1.7x the ring these ran clear across the planet and
          // out the other side, reading as render scratches.
          const rr = r * 0.72;
          // Near-white and long, so fire never reads as another ship
          // icon: a reviewer counted yellow streaks among yellow hulls
          // and could not tell shooting from parked.
          ctx.strokeStyle = sideCols.length
            ? hexA(sideCols[i % sideCols.length], 0.75 + rnd() * 0.25)
            : `rgba(255,248,224,${0.6 + rnd() * 0.4})`;
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

    // CAPTION, on every tick that has something to say, always in the
    // same form. It used to fire only when the focused body happened to
    // have a live battle, so most fights went unnamed -- and when it did
    // fire it sometimes omitted the participants.
    {
      const shot = shots.find(x => t >= x.from && x.to > t);
      // Prefer a battle actually on screen over the shot's nominal body.
      const onScreen = summary.battles.filter(b => b.body_id
        && curTick >= b.started_tick && curTick <= (b.ended_tick ?? b.started_tick)
        && byId.has(b.body_id));
      const focusId = (onScreen.find(b => b.body_id === shot?.bodyId)?.body_id)
        ?? shot?.bodyId ?? onScreen[0]?.body_id ?? null;
      if (focusId && byId.has(focusId) && drawableAt(byId.get(focusId)!, curTick)) {
        const nm = byId.get(focusId)!.name ?? 'this world';
        const live = onScreen.some(b => b.body_id === focusId);
        const ev = events.find(e => e.bodyId === focusId
          && Math.abs(e.tick - curTick) <= 1 && e.kind !== 'pact');
        const sides = [...(harbour.get(focusId)?.keys() ?? [])]
          .filter(k => k !== 'n').map(k => faction(k)?.name ?? '')
          .filter(Boolean).slice(0, 3);
        let line = '';
        if (live) {
          line = `Battle at ${nm}`
            + (sides.length >= 2 ? ` — ${sides.join(' vs ')}` : '');
        } else if (ev?.kind === 'founded') line = `Settlement founded on ${nm}`;
        else if (ev?.kind === 'fallen') line = `Settlement lost on ${nm}`;
        else if (ev?.kind === 'loss') {
          line = `${ev.count ?? 1} ship${(ev.count ?? 1) === 1 ? '' : 's'} lost at ${nm}`;
        } else {
          const own = owner.get(focusId);
          line = own ? `${nm} — ${faction(own)?.name ?? 'held'}` : `${nm}`;
        }
        const p = toPx(pos(focusId, t));
        const r0 = (bodyR.get(focusId) ?? 6) * cam.scale;
        ctx.font = '600 14px system-ui, sans-serif';
        ctx.textAlign = 'center'; ctx.textBaseline = 'top';
        const wpx = Math.min(W - PANEL_W - 40, ctx.measureText(line).width + 20);
        let cx = Math.max(wpx / 2 + 12, Math.min(W - PANEL_W - wpx / 2 - 12, p.x));
        const cy = Math.min(H - SAFE_BOTTOM - 34, p.y + r0 + 22);
        // A leader line ties the caption to the body it describes.
        ctx.strokeStyle = 'rgba(160,190,220,0.5)'; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(p.x, p.y + r0 + 3); ctx.lineTo(cx, cy - 2); ctx.stroke();
        ctx.fillStyle = 'rgba(4,8,14,0.86)';
        ctx.fillRect(cx - wpx / 2, cy, wpx, 24);
        ctx.strokeStyle = 'rgba(150,180,215,0.4)';
        ctx.strokeRect(cx - wpx / 2 + 0.5, cy + 0.5, wpx - 1, 23);
        ctx.fillStyle = '#e6f0f8';
        ctx.fillText(line, cx, cy + 5);
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
      // WORLDS IS THE SORT KEY, SO WORLDS IS THE BIG NUMBER. Printing
      // fleet large next to a worlds-ordered list made rank look wrong:
      // "62·18 / 28·12 / 61·11" reads as a broken sort.
      ctx.textAlign = 'right';
      ctx.fillStyle = dead ? '#7c8895' : '#e6f0f8';
      ctx.font = '700 15px system-ui, sans-serif';
      ctx.fillText(String(nWorlds), px0 + PW - 10, y - 2);
      ctx.fillStyle = dead ? '#66707c' : '#8ea3b8';
      ctx.font = '10px system-ui, sans-serif';
      ctx.fillText(nShips + ' ships', px0 + PW - 34, y + 3);

      // Rank movement, held briefly so an overtake is an event you see.
      const rNow = rankAt.get(curTick)?.get(f.id);
      const rWas = rankAt.get(Math.max(0, curTick - 6))?.get(f.id);
      if (!dead && rNow != null && rWas != null && rNow !== rWas) {
        const up = rNow < rWas;
        ctx.fillStyle = up ? '#6ee7a5' : '#ff8f7a';
        ctx.font = '700 9px system-ui, sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText((up ? '\u25b2' : '\u25bc') + Math.abs(rNow - rWas),
          px0 + 8, y + 13);
      }

      // ONE stacked bar with a legend, not four unlabelled hairlines.
      // The old bars had no scale, no units and no key, so they taught
      // the viewer to ignore them.
      if (!dead) {
        const st = world.stock.get(f.id) ?? [0, 0, 0, 0];
        // ONE SCALE FOR THE WHOLE MATCH. Normalised per row, every
        // bar rendered near-full and cross-empire comparison -- the
        // only reason to draw them -- was impossible.
        const total = stockMax * 4;
        const cols = ['#9aa7b6', '#e8c36a', '#e88a4a', '#6fb4ee'];
        let bx = px0 + 34;
        const bw = PW - 44;
        ctx.fillStyle = 'rgba(255,255,255,0.07)';
        ctx.fillRect(bx, y + 18, bw, 7);
        for (let k = 0; k < 4; k++) {
          const seg = (Math.max(0, st[k]) / total) * bw;
          if (seg <= 0.4) continue;
          ctx.fillStyle = cols[k];
          ctx.fillRect(bx, y + 18, seg, 7);
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
    // A gradient scrim across the full width: bodies that do bleed to
    // the bottom edge stay legible instead of fighting the rail.
    const scrim = ctx.createLinearGradient(0, H - 88, 0, H);
    scrim.addColorStop(0, 'rgba(3,6,13,0)');
    scrim.addColorStop(1, 'rgba(3,6,13,0.92)');
    ctx.fillStyle = scrim;
    ctx.fillRect(0, H - 88, W, 88);
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    ctx.fillRect(barX, barY, barW, 3);
    // Binned into a histogram so the war has a SHAPE -- a build, a peak
    // and a tail -- rather than an undifferentiated picket fence.
    {
      const BINS = 72;
      const bin = new Array(BINS).fill(0);
      for (const bt of summary.battles) {
        const f = (bt.started_tick - lo) / Math.max(1, hi - lo);
        bin[Math.max(0, Math.min(BINS - 1, Math.floor(f * BINS)))]++;
      }
      const peak = Math.max(1, ...bin);
      const bwid = barW / BINS;
      for (let i = 0; i < BINS; i++) {
        if (!bin[i]) continue;
        const hgt = 4 + (bin[i] / peak) * 14;
        ctx.fillStyle = 'rgba(255,130,95,0.8)';
        ctx.fillRect(barX + i * bwid, barY - 4 - hgt, Math.max(1.2, bwid - 0.8), hgt);
      }
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
    const clockTxt = 'T+' + Math.floor(t);
    ctx.fillText(clockTxt, barX, barY - 6);
    const cw = ctx.measureText(clockTxt).width;
    ctx.font = '10px system-ui, sans-serif';
    ctx.fillStyle = '#7f97ad';
    ctx.fillText(' / ' + hi, barX + cw + 3, barY - 6);
    const clockW = cw + 3 + ctx.measureText(' / ' + hi).width;
    // Reconstructed stretches are shaded INSIDE the rail, so the label
    // shows which span it covers instead of sitting on every frame as a
    // permanent watermark.
    const firstLive = summary.firstLiveTick;
    if (firstLive != null && firstLive > lo) {
      const fw = ((firstLive - lo) / Math.max(1, hi - lo)) * barW;
      ctx.fillStyle = 'rgba(150,175,200,0.16)';
      ctx.fillRect(barX, barY - 2, fw, 7);
      if (Math.floor(t) < firstLive) {
        ctx.textAlign = 'left';
        ctx.fillStyle = '#7f97ad';
        ctx.font = '9px system-ui, sans-serif';
        // Placed after the clock pair has been measured, never under it.
        ctx.fillText('RECONSTRUCTED', barX + clockW + 16, barY - 7);
      }
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
    applyRows: (rows: SnapshotRow[]) => {
      timeline.append(rows); rebuildShots(); rebuildStandings();
    },
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
