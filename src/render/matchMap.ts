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
import type { ShipIconClass, ShipIconVariant } from '../components/ShipIcons';

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
  const byIdRaw = byId;
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
  const ORBIT_MAX = Math.max(1, ...bodies
    .filter(b => b.parent_body_id && byIdRaw.get(b.parent_body_id)?.type === 'star')
    .map(b => b.orbit_radius ?? 0));
  const ORBIT_SPAN = 1500;

  const moonRadius = new Map<string, number>();
  {
    const kids = new Map<string, Body[]>();
    for (const b of bodies) {
      if (!b.parent_body_id || b.parent_body_id === starId) continue;
      if (!kids.has(b.parent_body_id)) kids.set(b.parent_body_id, []);
      kids.get(b.parent_body_id)!.push(b);
    }
    // A MOON SYSTEM MUST FIT INSIDE ITS OWN ORBITAL GAP. Stacking moons
    // outward at a fixed pitch pushed Jupiter's family straight through
    // the asteroid belt: the stack was sized by moon count, with no idea
    // how much room the planet actually had. Each system now gets at
    // most 40% of the distance to its nearest neighbouring orbit, and
    // its moons are distributed inside that budget.
    const starOrbit = new Map<string, number>();
    for (const b of bodies) {
      if (b.parent_body_id === starId && b.orbit_radius) {
        starOrbit.set(b.id, ORBIT_SPAN * Math.sqrt(b.orbit_radius / ORBIT_MAX));
      }
    }
    for (const [pid, arr] of kids) {
      arr.sort((a, b) => (a.orbit_radius ?? 0) - (b.orbit_radius ?? 0));
      const pr = bodyR.get(pid) ?? 6;
      const mine = starOrbit.get(pid);
      let budget = 90;
      if (mine != null) {
        let gap = Infinity;
        for (const [oid, orr] of starOrbit) {
          if (oid === pid) continue;
          const d = Math.abs(orr - mine);
          if (d > 1e-6 && d < gap) gap = d;
        }
        if (Number.isFinite(gap)) budget = Math.max(pr + 14, gap * 0.40);
      }
      const inner = pr + 6;
      const room = Math.max(8, budget - inner);
      arr.forEach((m, i) => {
        const f = arr.length === 1 ? 0.6 : i / (arr.length - 1);
        moonRadius.set(m.id, inner + room * (0.35 + 0.65 * f));
      });
    }
  }
  // SQUARE ROOT, NOT LOG. log10(1 + r) * 230 put Mercury at 497 and
  // Sedna at 884: a 500-unit void around the sun with all thirty-two
  // bodies crushed into the outer 40%, because log10(145) is already
  // 2.16 -- the curve spends its whole useful range before the first
  // planet. sqrt is the standard orbital-map scale: it opens the inner
  // system, keeps the outer one on screen, and leaves no hole in the
  // middle. Normalised to the outermost orbit so any map fills the
  // same canvas.
  const orbitR = (b: Body) => {
    if (!b.orbit_radius || b.orbit_radius <= 0) return 0;
    const moon = moonRadius.get(b.id);
    if (moon != null) return moon;
    const pr = b.parent_body_id ? (bodyR.get(b.parent_body_id) ?? 0) : 0;
    return ORBIT_SPAN * Math.sqrt(b.orbit_radius / ORBIT_MAX)
      + pr + (bodyR.get(b.id) ?? 0) + 10;
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

  // ---- political lanes -------------------------------------------------
  //
  // THE MAP'S OWN TERRITORY MODEL, not a glow around each planet. In the
  // game a faction holds the ORBITAL BAND its worlds sit in -- "a planet
  // system owns its whole lane around the sun; that's what territory
  // means on this map" -- so the recap draws annuli, with the same lane
  // arithmetic and the same ownership rule (a strict majority of the
  // claimed worlds in a region owns it; a tie reads contested).
  // The game's lane widths are fractions of the REAL orbit radius. This
  // layout log-compresses orbits, so those fractions are meaningless
  // here: a floor of r * 0.035 gives a 40-unit band where the median gap
  // between neighbouring orbits is 3.4, and every lane merges into one
  // rainbow donut. Widths are gap-relative instead, with absolute
  // bounds, which is the same INTENT -- fill your orbital neighbourhood,
  // leave a seam -- expressed in the space actually being drawn.
  /** How many ticks a crossing is shown flying. */
  const TRANSIT_TICKS = 4;
  const LANE_GAP_FRACTION = 0.40;
  const LANE_HALF_MIN = 2.5;
  const LANE_HALF_MAX = 22;
  const SYSTEM_DISC_PAD = 1.15;

  interface Lane { id: string; label: string; rInner: number; rOuter: number;
    bodyIds: string[]; anchor: string }
  const lanes: Lane[] = (() => {
    const out: Lane[] = [];
    const star = bodies.find(b => b.type === 'star');
    if (!star) return out;
    const orbiters = bodies
      .filter(b => b.parent_body_id === star.id && b.orbit_radius)
      .sort((a, b) => (a.orbit_radius ?? 0) - (b.orbit_radius ?? 0));
    // Lane widths come off the DRAWN radii, so the bands sit where the
    // orbits actually are in this compressed layout.
    const drawn = orbiters.map(o => orbitR(o));
    const halfOf = (b: Body, r: number) => {
      let gap = Infinity;
      for (const other of drawn) {
        const d = Math.abs(other - r);
        if (d > 1e-6 && d < gap) gap = d;
      }
      if (!Number.isFinite(gap)) gap = r;
      return Math.min(Math.max(gap * LANE_GAP_FRACTION, LANE_HALF_MIN),
        LANE_HALF_MAX);
    };
    orbiters.forEach((b, i) => {
      const r = drawn[i];
      const moons = bodies.filter(m => m.parent_body_id === b.id);
      // Only real systems get a lane. The game groups loose rubble into
      // named belts; drawing a ring per asteroid would stack twenty
      // overlapping bands across the same few map units.
      if (!moons.length && (Number(b.radius) || 0) < 2) return;
      let half = halfOf(b, r);
      if (moons.length) {
        // The lane must at minimum contain the moon system it represents.
        const outermost = Math.max(...moons.map(m => orbitR(m)));
        half = Math.max(half, outermost * SYSTEM_DISC_PAD);
      }
      out.push({
        id: 'lane:' + b.id,
        label: moons.length ? `${b.name ?? 'System'} System` : (b.name ?? ''),
        rInner: Math.max(0, r - half),
        rOuter: r + half,
        bodyIds: [b.id, ...moons.map(m => m.id)],
        anchor: b.id,
      });
    });
    return out;
  })();

  /** Who holds a lane: strict majority of its CLAIMED worlds, else contested. */
  const laneOwner = (lane: Lane, owner: Map<string, string | null>) => {
    const tally = new Map<string, number>();
    let claimed = 0;
    for (const id of lane.bodyIds) {
      const f = owner.get(id);
      if (!f) continue;
      claimed++;
      tally.set(f, (tally.get(f) ?? 0) + 1);
    }
    if (!claimed) return { kind: 'unowned' as const, fid: null as string | null };
    let bestF: string | null = null, bestN = 0;
    for (const [f, n] of tally) if (n > bestN) { bestF = f; bestN = n; }
    if (bestN * 2 > claimed) return { kind: 'exclusive' as const, fid: bestF };
    return { kind: 'contested' as const, fid: null as string | null };
  };

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
  /** Worlds changing hands, per tick: the campaign's real headlines. */
  const captureAt = new Map<number, Array<{ body: string; from: string | null;
    to: string | null }>>();
  const leadAt = new Map<number, string>();
  let stockMax = 1;
  /** Ticks on which at least one hull changes world, and where from. */
  const transitAt = new Map<number, Array<{ id: string; from: string; to: string;
    fid: string | null; cls: string; iv: ShipIconVariant }>>();
  const rebuildTransits = () => {
    transitAt.clear();
    const lo = summary.ticks.lo ?? 0, hi = summary.ticks.hi ?? lo;
    let prev = timeline.worldAt(lo);
    for (let t = lo + 1; t <= hi; t++) {
      const now = timeline.worldAt(t);
      const moves: Array<{ id: string; from: string; to: string;
        fid: string | null; cls: string; iv: ShipIconVariant }> = [];
      for (const [id, sh] of now.ships) {
        const was = prev.ships.get(id);
        if (!was || !was.parent || !sh.parent || was.parent === sh.parent) continue;
        moves.push({ id, from: was.parent, to: sh.parent,
          fid: sh.fid, cls: sh.cls, iv: sh.iv });
      }
      if (moves.length) transitAt.set(t - 1, moves);
      prev = now;
    }
  };

  const rebuildStandings = () => {
    rankAt.clear(); elimAt.clear(); captureAt.clear(); leadAt.clear();
    stockMax = 1;
    const ownerPrev = new Map<string, string | null>();
    let leaderPrev: string | null = null;
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

      // Worlds changing hands. A capture is the single most captionable
      // thing a campaign does, and it was invisible: the film cut to a
      // world and told you who owned it, never that it had just fallen.
      const ownerNow = new Map<string, string | null>();
      for (const st of w.stls.values()) if (st.fid) ownerNow.set(st.body, st.fid);
      for (const [body, to] of ownerNow) {
        const from = ownerPrev.get(body) ?? null;
        if (from !== to) {
          if (!captureAt.has(t)) captureAt.set(t, []);
          captureAt.get(t)!.push({ body, from, to });
        }
      }
      for (const [body, from] of ownerPrev) {
        if (!ownerNow.has(body) && from) {
          if (!captureAt.has(t)) captureAt.set(t, []);
          captureAt.get(t)!.push({ body, from, to: null });
        }
      }
      ownerPrev.clear();
      for (const [k, v] of ownerNow) ownerPrev.set(k, v);

      const leadNow = order[0]?.id ?? null;
      if (leadNow && leadNow !== leaderPrev && (worlds.get(leadNow) ?? 0) > 0) {
        leadAt.set(t, leadNow);
        leaderPrev = leadNow;
      }
      for (const f of summary.factions) {
        const has = (worlds.get(f.id) ?? 0) + (fleets.get(f.id) ?? 0) > 0;
        if (has) alive.add(f.id);
        else if (alive.has(f.id) && !elimAt.has(f.id)) elimAt.set(f.id, t);
      }
    }
  };

  let wideRun = 0, closeRun = 0;
  const rebuildShots = () => {
    wideRun = 0; closeRun = 0;
    events = mineEvents(timeline.rows, summary);
    shots = [];
    const lo = summary.ticks.lo ?? 0, hi = summary.ticks.hi ?? lo;
    let cursor = lo;
    while (cursor <= hi) {
      const end = cursor + MIN_SHOT_TICKS;
      // CUT TO EVENTS, NOT TO WORLDS. Five of eight sampled frames used
      // to caption "Body — Empire", a string that is true on every tick
      // of the match, so the director looked like it was stopping on
      // nothing. A shot now needs something to have HAPPENED; otherwise
      // it holds the system wide, which is itself informative.
      const cand = events.filter(e => e.tick >= cursor && e.tick < end
        && e.bodyId && byId.has(e.bodyId)
        && drawableAt(byId.get(e.bodyId)!, e.tick));
      // Captures outrank everything: a world changing hands is the story.
      let bestBody: string | null = null; let bestW = -1;
      for (let tk = cursor; tk < end; tk++) {
        for (const c of captureAt.get(tk) ?? []) {
          if (byId.has(c.body) && drawableAt(byId.get(c.body)!, tk) && bestW < 12) {
            bestBody = c.body; bestW = 12;
          }
        }
      }
      const top = cand.sort((a, b) => b.weight - a.weight)[0];
      if (top && top.weight > bestW) { bestBody = top.bodyId!; bestW = top.weight; }

      // A fleet actually crossing between worlds is worth cutting to: it
      // is the only time the map shows MOVEMENT rather than state.
      for (let tk = cursor; tk < end; tk++) {
        for (const mv of transitAt.get(tk) ?? []) {
          if (byId.has(mv.from) && drawableAt(byId.get(mv.from)!, tk) && bestW < 9) {
            bestBody = mv.from; bestW = 9;
          }
        }
      }

      // HOLD THE WHOLE SYSTEM WHEN SEVERAL THINGS MATTER AT ONCE.
      // Cutting to one body during a system-wide moment is the worst
      // possible framing: it shows the least of what is happening and
      // hides that it is happening everywhere. If a window carries
      // events at three or more worlds, or at worlds in two or more
      // different systems, the shot stays wide -- plus a regular
      // establisher so the viewer is re-oriented through quiet stretches.
      // A fleet actually crossing between worlds is worth cutting to;
      // it is also the only time the map shows movement rather than
      // state, so it should never be missed.
      for (let tk = cursor; tk < end; tk++) {
        for (const mv of transitAt.get(tk) ?? []) {
          if (byId.has(mv.from) && drawableAt(byId.get(mv.from)!, tk) && bestW < 9) {
            bestBody = mv.from; bestW = 9;
          }
        }
      }

      const hitBodies = new Set<string>();
      for (const e of cand) if (e.bodyId) hitBodies.add(e.bodyId);
      for (let tk = cursor; tk < end; tk++) {
        for (const c of captureAt.get(tk) ?? []) hitBodies.add(c.body);
        for (const mv of transitAt.get(tk) ?? []) { hitBodies.add(mv.from); hitBodies.add(mv.to); }
      }
      const systemsHit = new Set<string>();
      for (const b of hitBodies) {
        const bb = byId.get(b);
        if (!bb) continue;
        const par = bb.parent_body_id;
        systemsHit.add(par && byId.get(par)?.type !== 'star' ? par : bb.id);
      }
      // MEASURED: at 3 bodies / 2 systems / every third establisher, 67%
      // of shots were wide -- and because the breath below also spent the
      // ends of every close shot pulled out, the camera was actually
      // pushed in for only 21% of the film. "More wide shots" had quietly
      // become "no close shots". A system-wide moment is now a genuinely
      // system-wide one, which puts the film at 44% wide / 46% pushed in.
      const establisher = Math.round((cursor - lo) / MIN_SHOT_TICKS) % 5 === 0;
      let wide = hitBodies.size >= 6 || systemsHit.size >= 4 || establisher;

      // RHYTHM BEATS ACTIVITY. Deciding wide-or-close purely on how much
      // is happening sounds right and films badly: by the endgame the war
      // is everywhere, every window clears any threshold, and the camera
      // sits wide for the whole climax -- measured at 100% wide from tick
      // 135 on, which is exactly the stretch a viewer most wants to see
      // up close. A film needs to cut between scale and detail no matter
      // how busy the board is, so the run lengths are capped: never more
      // than two wide shots together, never more than three close ones.
      if (wide && wideRun >= 2 && bestBody) wide = false;
      else if (!wide && closeRun >= 3) wide = true;
      wideRun = wide ? wideRun + 1 : 0;
      closeRun = wide ? 0 : closeRun + 1;

      shots.push({ from: cursor, to: end, bodyId: wide ? null : bestBody });
      cursor = end;
    }
  };

  /**
   * What the senate is doing at a tick.
   *
   * A bill runs proposed -> debating -> voting -> resolved, and every one
   * of those is a campaign beat the film had no idea about. Vote weight
   * comes from worlds held, so the chamber is also a second scoreboard.
   */
  type SenatePhase = 'debate' | 'vote' | 'resolved' | null;
  const senateAt = (tick: number) => {
    const bills = summary.senate ?? [];
    for (const b of bills) {
      const prop = b.proposed_at_tick ?? 0;
      const opens = b.vote_opens_at_tick ?? prop;
      const closes = b.vote_closes_at_tick ?? opens;
      if (tick >= prop && tick < opens) return { bill: b, phase: 'debate' as SenatePhase };
      if (tick >= opens && tick <= closes) return { bill: b, phase: 'vote' as SenatePhase };
      const res = b.resolved_at_tick;
      if (res != null && tick > res && tick <= res + 6) {
        return { bill: b, phase: 'resolved' as SenatePhase };
      }
    }
    return { bill: null, phase: null as SenatePhase };
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
  // The panel is wider: three of eight empire names were truncated in
  // every frame, and there was dead canvas to its left in nearly all
  // of them.
  const PANEL_W = 300;
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
    // FRAME THE NEIGHBOURHOOD, not the rock. Five of eight frames were
    // one isolated body at ~3% of canvas: you could not tell where in
    // the system the event was, and the fleets in harbour at nearby
    // worlds -- the film's whole force-disposition story -- were off
    // screen. The fit box is the body plus its siblings and its parent.
    const b0 = byId.get(id)!;
    const kin = bodies.filter(x => x.id === id
      || x.id === b0.parent_body_id
      || (x.parent_body_id && x.parent_body_id === b0.parent_body_id));
    let kx0 = p.x - br, kx1 = p.x + br, ky0 = p.y - br, ky1 = p.y + br;
    for (const k of kin) {
      if (!drawableAt(k, Math.floor(t))) continue;
      const q = pos(k.id, t);
      const kr = (bodyR.get(k.id) ?? 4) + 22;
      kx0 = Math.min(kx0, q.x - kr); kx1 = Math.max(kx1, q.x + kr);
      ky0 = Math.min(ky0, q.y - kr); ky1 = Math.max(ky1, q.y + kr);
    }
    // Never let the neighbourhood swallow the subject: cap how far the
    // box may extend from the focused body.
    const CAP = br + 190;
    kx0 = Math.max(kx0, p.x - CAP); kx1 = Math.min(kx1, p.x + CAP);
    ky0 = Math.max(ky0, p.y - CAP); ky1 = Math.min(ky1, p.y + CAP);
    const bw = Math.max(2 * (br + 26), kx1 - kx0);
    const bh = Math.max(2 * (br + 26), ky1 - ky0);
    const availW = W - PANEL_W - SAFE * 2;
    const availH = H - SAFE - SAFE_BOTTOM;
    let sc = Math.min(availW / bw, availH / bh) * 0.9;
    // Floor: the focused body must still read as a body.
    sc = Math.max(sc, 30 / Math.max(2, br));
    target.scale = sc;
    target.x = (kx0 + kx1) / 2 + (PANEL_W / 2) / sc;
    target.y = (ky0 + ky1) / 2 + (SAFE_BOTTOM - SAFE) / 2 / sc;
  };

  const toPx = (p: { x: number; y: number }) =>
    ({ x: W / 2 + (p.x - cam.x) * cam.scale, y: H / 2 + (p.y - cam.y) * cam.scale });

  const aim = (t: number, dTicks: number) => {
    if (!shots.length) rebuildShots();
    const shot = shots.find(s => t >= s.from && t < s.to) ?? shots[shots.length - 1];
    const rawFocus = viewMode === 'auto' && shot?.bodyId && byId.has(shot.bodyId)
      && drawableAt(byId.get(shot.bodyId)!, Math.floor(t)) ? shot.bodyId : null;

    // THE BREATH. A campaign film needs the grand scale as often as the
    // detail: the whole map is the context that makes a single fight
    // mean anything. Every shot now opens WIDE on the system, pushes in
    // to its subject, holds, and pulls back out before the cut -- so the
    // viewer is repeatedly reminded where in the war they are.
    let focusId = rawFocus;
    let blend = 0;   // 0 = system wide, 1 = fully on the subject
    if (shot && rawFocus) {
      const span = Math.max(1, shot.to - shot.from);
      const u = Math.max(0, Math.min(1, (t - shot.from) / span));
      // The breath is a glance outward, not the resting state: the shot
      // belongs to its subject and the wide ends only bookend it.
      const IN = 0.12, OUT = 0.90;
      blend = u < IN ? u / IN
        : u > OUT ? Math.max(0, 1 - (u - OUT) / (1 - OUT))
        : 1;
      // Ease so the push and the pull are cinematic, not linear.
      blend = blend * blend * (3 - 2 * blend);
    } else if (rawFocus) {
      blend = 1;
    }
    if (focusId && blend > 0.02) {
      fitBody(focusId, t);
      if (blend < 0.995) {
        const bx = target.x, by = target.y, bs = target.scale;
        fitAll(t);
        target.x += (bx - target.x) * blend;
        target.y += (by - target.y) * blend;
        // Scale interpolates geometrically: a linear blend between two
        // very different zooms spends most of its time near the wide end.
        target.scale = Math.exp(Math.log(target.scale)
          + (Math.log(bs) - Math.log(target.scale)) * blend);
      }
    } else {
      focusId = null;
      fitAll(t);
    }

    // Only a firmly-held subject counts as "the shot" for cut purposes;
    // the wide ends of the breath must not each read as a new target.
    const focusKey = blend > 0.5 ? focusId : null;
    if (!camInit) {
      cam.x = target.x; cam.y = target.y; cam.scale = target.scale;
      camInit = true; lastFocus = focusKey; return;
    }
    // CUT, DON'T PAN, when the subject changes to somewhere far away.
    // A pan between distant bodies at event zoom crosses nothing but
    // starfield -- three reviewers independently reported those as dead
    // frames. A cut costs one frame; a pan costs seconds of empty film.
    if (focusKey !== lastFocus) {
      const far = Math.hypot(target.x - cam.x, target.y - cam.y) * cam.scale;
      const zoomJump = Math.max(target.scale / cam.scale, cam.scale / target.scale);
      if (far > W * 0.75 || zoomJump > 2.5) {
        cam.x = target.x; cam.y = target.y; cam.scale = target.scale;
      }
      lastFocus = focusKey;
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
  /**
   * The NEXT tick's world, cached beside the current one.
   *
   * Ships carry no transit state -- a hull simply has a different parent
   * body on the following tick -- so a crossing has to be derived by
   * comparing the two. That is the whole trajectory layer: where a ship
   * is now, where it will be, and the line between.
   */
  let nextWorld: MatchWorld = world;
  let worldTick = -1;
  let curTick = 0, curFrac = 0;
  /** Hulls drawn mid-crossing this frame; harbour stacks skip them. */
  let transiting = new Set<string>();

  let lastT = -1;
  function setTick(tick: number, frac: number) {
    if (tick !== worldTick) {
      world = timeline.worldAt(tick);
      nextWorld = timeline.worldAt(tick + 1);
      worldTick = tick;
    }
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
    // THE MAP HAS ITS OWN RECT AND STAYS IN IT. Planets were drawing
    // over the timeline and under the empire panel; a camera safe area
    // alone cannot fix that, because bodies OTHER than the subject land
    // wherever the orbit puts them.
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, W - PANEL_W + 6, H - SAFE_BOTTOM + 10);
    ctx.clip();

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

    // THE POLITICAL WASH: ORBITAL LANES, the way the map paints them.
    // A radial glow around each planet was wrong -- territory in this
    // game is the BAND a faction holds around the star, so the recap
    // shades annuli, names them, and leaves a seam between neighbours.
    {
      const sunPx = toPx(pos(starId, t));
      ctx.save();
      for (const lane of lanes) {
        const own = laneOwner(lane, owner);
        if (own.kind === 'unowned') continue;
        const rin = lane.rInner * cam.scale, rout = lane.rOuter * cam.scale;
        if (rout < 6 || rin > Math.hypot(W, H) * 1.6) continue;
        const col = own.kind === 'exclusive' ? colorOf(own.fid) : '#9db0c4';
        // THE GAME PAINTS TERRITORY BOLDLY. Faint rings at 0.15 read as
        // decoration; on the real map a held lane is a wide saturated
        // band you can name from across the room, and that is the single
        // biggest reason the recap did not look like the game.
        const alpha = own.kind === 'exclusive' ? 0.5 : 0.2;
        // The band itself: a thick stroked ring is cheaper and cleaner
        // than filling an even-odd annulus, and gives a soft inner and
        // outer edge for free.
        ctx.beginPath();
        ctx.arc(sunPx.x, sunPx.y, (rin + rout) / 2, 0, Math.PI * 2);
        ctx.strokeStyle = hexA(col, alpha);
        ctx.lineWidth = Math.max(1, rout - rin);
        ctx.stroke();
        // Soft shoulders rather than hard edges: the game's bands fade
        // into each other instead of being outlined.
        ctx.lineWidth = Math.max(1, (rout - rin) * 0.22);
        ctx.strokeStyle = hexA(col, alpha * 0.5);
        ctx.beginPath(); ctx.arc(sunPx.x, sunPx.y, rin, 0, Math.PI * 2); ctx.stroke();
        ctx.beginPath(); ctx.arc(sunPx.x, sunPx.y, rout, 0, Math.PI * 2); ctx.stroke();
        // Name the territory at its anchor body's angle, as the map does,
        // so a dozen concentric rings do not stack their labels.
        if (lane.label && rout - rin > 16 && byId.has(lane.anchor)) {
          const ap = pos(lane.anchor, t);
          const ang = Math.atan2(ap.y, ap.x);
          const rr = (rin + rout) / 2;
          const lx = sunPx.x + Math.cos(ang) * rr;
          const ly = sunPx.y + Math.sin(ang) * rr;
          if (lx > -80 && lx < W - PANEL_W + 80 && ly > -40 && ly < H) {
            ctx.font = '600 10px system-ui, sans-serif';
            ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
            ctx.fillStyle = hexA(col, 0.75);
            ctx.fillText(
              own.kind === 'contested' ? lane.label + ' · CONTESTED' : lane.label,
              lx, ly - Math.min(26, (rout - rin) / 2 - 4));
          }
        }
      }
      ctx.restore();
    }

    // Bodies.    // Bodies.
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
      // The real map names its worlds at system zoom -- PLUTO, NEPTUNE,
      // CERES are all legible in a full-system view. Gating labels on
      // drawn pixel radius hid every name the moment the camera pulled
      // out, which is exactly when a viewer needs them. Named if the
      // body is a real world, or if it is simply big on screen.
      const worthNaming = (Number(b.radius) || 0) >= 2
        || bodies.some(m => m.parent_body_id === b.id);
      if (b.name && (r >= 5 || worthNaming)) {
        labelAt.push({ x: p.x, y: p.y, r, name: b.name, fid });
      }
    }

    // Ships: clustered at their parent, arranged per faction in an arc,
    // drawn as the map's own icons. Big harbours get a count badge.
    const harbour = new Map<string, Map<string, string[]>>();
    for (const [id, s] of world.ships) {
      if (transiting.has(id)) continue;   // drawn on its course instead
      const parent = s.parent ?? '';
      if (!harbour.has(parent)) harbour.set(parent, new Map());
      const perF = harbour.get(parent)!;
      const key = s.fid ?? 'n';
      if (!perF.has(key)) perF.set(key, []);
      perF.get(key)!.push(id);
    }
    const iconPx = Math.max(9, Math.min(22, cam.scale * 5.5));
    // Where every drawn hull ended up, so combat can be fired between
    // the ACTUAL ships rather than scribbled near the planet.
    const shipPx = new Map<string, { x: number; y: number; fid: string | null }>();
    // Chips are collected and drawn after the hulls, so a plate is never
    // buried under a ship icon.
    const chips: Array<{ x: number; y: number; n: number; col: string }> = [];
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
          const lane = Math.floor(i / 4);
          const ring = base + iconPx * (0.9 + lane * 0.9);
          // SHIPS ORBIT. The old drift was 0.002 rad/tick -- thirty
          // degrees across an entire match, which is why fleets looked
          // pinned to their world rather than flying around it. Inner
          // ranks come round faster than outer ones, so a busy harbour
          // reads as traffic instead of a frozen rosette.
          const rate = 0.16 / (1 + lane * 0.55);
          const ang = fa + (i % 4) * 0.42 + t * rate;
          const x = pp.x + Math.cos(ang) * ring, y = pp.y + Math.sin(ang) * ring;
          shipPx.set(ids[i], { x, y, fid: s.fid });
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
        // ALWAYS a chip, carrying the faction's WHOLE count at this
        // world -- not a "+N" overflow. On the real map the chip is how
        // strength is read; the hulls are texture around it.
        chips.push({ x: pp.x, y: pp.y - base - 14 - fi * 21,
          n: ids.length, col: colorOf(fid === 'n' ? null : fid) });
        fi++;
      }
    }

    for (const c of chips) badge(ctx, c.x, c.y, String(c.n), c.col);

    // SHIPS IN TRANSIT. A hull whose parent changes between this tick
    // and the next is crossing; it is drawn ON the line between the two
    // worlds, at the fraction of the tick already elapsed, with a dashed
    // trajectory ahead of it and a fading wake behind. Without this the
    // fleets teleport between harbours and the map never shows a
    // campaign's actual movement.
    {
      const seen = new Set<string>();
      // A crossing used to be drawn only on the single tick where the
      // ship's parent changed: ONE SECOND of film out of two hundred and
      // sixty, which is why the fleets still looked like they teleported
      // even after the journeys were reconstructed -- the data was there
      // and the film blinked past it. A crossing recorded on tick tk
      // arrives on tk+1, so it is now flown over the ticks leading up to
      // that arrival: a departure, a passage and an arrival the eye can
      // actually follow.
      for (let tk = curTick - 1; tk <= curTick + TRANSIT_TICKS; tk++) {
        for (const mv of transitAt.get(tk) ?? []) {
          if (seen.has(mv.id)) continue;
          const depart = tk + 1 - TRANSIT_TICKS;
          const u0 = (t - depart) / TRANSIT_TICKS;
          if (u0 < 0 || u0 > 1) continue;
          if (!world.ships.has(mv.id)) continue;
          if (!byId.has(mv.from) || !byId.has(mv.to)) continue;
          if (!drawableAt(byId.get(mv.from)!, curTick)) continue;
          if (!drawableAt(byId.get(mv.to)!, curTick)) continue;
          seen.add(mv.id);
          const a = toPx(pos(mv.from, t));
          const b = toPx(pos(mv.to, t));
          const col = colorOf(mv.fid);
          // The lane it is flying: a cold teal that belongs to no
          // faction, laid over a soft glow so the course survives at
          // system zoom -- the width the camera spends most of its
          // time at, and where a 1.6px hairline simply disappeared.
          ctx.save();
          ctx.strokeStyle = 'rgba(90,210,205,0.16)';
          ctx.lineWidth = 5;
          ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
          ctx.setLineDash([9, 7]);
          // The dashes crawl toward the destination, so the line reads as
          // motion even when the hull on it is a few pixels across.
          ctx.lineDashOffset = -t * 9;
          ctx.strokeStyle = 'rgba(120,235,230,0.9)';
          ctx.lineWidth = 1.8;
          ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
          ctx.setLineDash([]);
          // Where it has got to, eased so departures and arrivals settle.
          const u = u0 * u0 * (3 - 2 * u0);
          const px = a.x + (b.x - a.x) * u, py = a.y + (b.y - a.y) * u;
          // Wake: the stretch already flown, brighter near the hull.
          const wake = ctx.createLinearGradient(a.x, a.y, px, py);
          wake.addColorStop(0, hexA(col, 0));
          wake.addColorStop(1, hexA(col, 0.9));
          ctx.strokeStyle = wake; ctx.lineWidth = 3;
          ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(px, py); ctx.stroke();
          ctx.restore();
          // The hull itself, nose along the course.
          const ang = Math.atan2(b.y - a.y, b.x - a.x);
          const ipx = Math.max(9, Math.min(20, cam.scale * 5));
          const img = getShipIconImage(iconClassOf(mv.cls), col, mv.iv);
          if (img) {
            ctx.save();
            ctx.translate(px, py); ctx.rotate(ang + Math.PI / 2);
            ctx.drawImage(img, -ipx / 2, -ipx / 2, ipx, ipx);
            ctx.restore();
          } else {
            ctx.fillStyle = col;
            ctx.beginPath(); ctx.arc(px, py, ipx * 0.28, 0, Math.PI * 2); ctx.fill();
          }
        }
      }
      transiting = seen;
    }

    // Where the caption ends up, so the body names can keep clear of it.
    let capRect: { x: number; y: number; w: number; h: number } | null = null;

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
      // THEY SHOOT AT EACH OTHER. This used to be random chords drawn
      // near the planet; now every tracer runs from one real hull to
      // another real hull of an opposing faction, using the positions
      // those icons were actually drawn at. Rounds are staggered across
      // the tick so a battle is a rolling exchange, not a starburst.
      const perF = harbour.get(id);
      if (perF) {
        const sides = [...perF.entries()].filter(([k]) => k !== 'n');
        // ONE SIDE PRESENT IS A BOMBARDMENT, NOT A GAP. 19 of this
        // match's 68 battles have hulls from a single faction at the
        // body -- a fleet working over a world it does not hold. Those
        // ships fire on the planet itself rather than standing silent.
        if (sides.length === 1) {
          const rnd = mulberry32(hashStr(id) * 11 + curTick);
          const [fid2, ids2] = sides[0];
          const col = colorOf(fid2);
          const SAL = 5;
          for (let k = 0; k < SAL; k++) {
            const sp = shipPx.get(ids2[Math.floor(rnd() * ids2.length)]);
            if (!sp) continue;
            const u = (curFrac - k / SAL) * SAL * 1.6;
            if (u <= 0 || u >= 1.35) continue;
            // Land on the disc's near edge, not its centre.
            const ang2 = Math.atan2(sp.y - p.y, sp.x - p.x);
            const br2 = (bodyR.get(id) ?? 5) * cam.scale;
            const tx = p.x + Math.cos(ang2) * br2, ty = p.y + Math.sin(ang2) * br2;
            const flight = Math.min(1, u);
            const dx2 = tx - sp.x, dy2 = ty - sp.y;
            const hx = sp.x + dx2 * flight, hy = sp.y + dy2 * flight;
            const tail2 = Math.min(0.3, flight);
            ctx.strokeStyle = hexA(col, 0.95);
            ctx.lineWidth = 1.8;
            ctx.beginPath();
            ctx.moveTo(sp.x + dx2 * Math.max(0, flight - tail2),
              sp.y + dy2 * Math.max(0, flight - tail2));
            ctx.lineTo(hx, hy); ctx.stroke();
            if (u > 1) {
              const k2 = (u - 1) / 0.35;
              ctx.fillStyle = `rgba(255,220,160,${(1 - k2) * 0.9})`;
              ctx.beginPath(); ctx.arc(tx, ty, 2 + k2 * 8, 0, Math.PI * 2); ctx.fill();
            }
          }
        }
        if (sides.length >= 2) {
          const rnd = mulberry32(hashStr(id) * 7 + curTick);
          const SALVOES = 7;
          for (let k = 0; k < SALVOES; k++) {
            const ai = Math.floor(rnd() * sides.length);
            let bi = Math.floor(rnd() * sides.length);
            if (bi === ai) bi = (bi + 1) % sides.length;
            const shooters = sides[ai][1], targets = sides[bi][1];
            if (!shooters.length || !targets.length) continue;
            const sp = shipPx.get(shooters[Math.floor(rnd() * shooters.length)]);
            const tp = shipPx.get(targets[Math.floor(rnd() * targets.length)]);
            if (!sp || !tp) continue;
            // Each salvo has its own slot in the tick, so shots leave,
            // fly and land instead of all existing at once.
            const t0 = k / SALVOES;
            const u = (curFrac - t0) * SALVOES * 1.6;
            if (u <= 0 || u >= 1.35) continue;
            const dx = tp.x - sp.x, dy = tp.y - sp.y;
            const flight = Math.min(1, u);
            const hx = sp.x + dx * flight, hy = sp.y + dy * flight;
            const tail = Math.min(0.28, flight);
            // A SALVO IS SEVERAL PARALLEL BEAMS IN AMBER, which is how
            // the game draws fire: a battery firing together, not one
            // hairline. Offset perpendicular to the line of fire.
            const len = Math.hypot(dx, dy) || 1;
            const nx = -dy / len, ny = dx / len;
            for (let bi = -1; bi <= 1; bi++) {
              const off = bi * 2.2;
              ctx.strokeStyle = bi === 0
                ? 'rgba(255,214,140,0.98)' : 'rgba(232,150,60,0.85)';
              ctx.lineWidth = bi === 0 ? 2 : 1.3;
              ctx.beginPath();
              ctx.moveTo(sp.x + dx * Math.max(0, flight - tail) + nx * off,
                sp.y + dy * Math.max(0, flight - tail) + ny * off);
              ctx.lineTo(hx + nx * off, hy + ny * off);
              ctx.stroke();
            }
            const col = colorOf(sp.fid);
            // Muzzle flash while the round is leaving the gun.
            if (u < 0.3) {
              ctx.fillStyle = hexA(col, (1 - u / 0.3) * 0.9);
              ctx.beginPath();
              ctx.arc(sp.x, sp.y, 2.5 + (1 - u / 0.3) * 3, 0, Math.PI * 2);
              ctx.fill();
            }
            // Impact on arrival.
            if (u > 1) {
              const k2 = (u - 1) / 0.35;
              ctx.fillStyle = `rgba(255,235,190,${(1 - k2) * 0.95})`;
              ctx.beginPath();
              ctx.arc(tp.x, tp.y, 2 + k2 * 7, 0, Math.PI * 2);
              ctx.fill();
            }
          }
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

    // CAPTION: VERB-LED, WITH A CONSEQUENCE. The old fallback said
    // "Body — Empire", a sentence that is true on every tick of the
    // match, so the director's cuts read as stopping on nothing.
    {
      const shot = shots.find(x => t >= x.from && x.to > t);
      const onScreen = summary.battles.filter(b => b.body_id
        && curTick >= b.started_tick && curTick <= (b.ended_tick ?? b.started_tick)
        && byId.has(b.body_id));
      const caps = captureAt.get(curTick) ?? [];
      const focusId = caps.find(c => c.body === shot?.bodyId)?.body
        ?? (onScreen.find(b => b.body_id === shot?.bodyId)?.body_id)
        ?? shot?.bodyId ?? onScreen[0]?.body_id ?? caps[0]?.body ?? null;

      let line = '', sub = '';
      // On a system-wide hold, describe the SYSTEM rather than silently
      // showing a busy map.
      if (!shot?.bodyId && onScreen.length >= 2) {
        const names = onScreen.slice(0, 3)
          .map(b => byId.get(b.body_id!)?.name ?? '').filter(Boolean);
        line = `${onScreen.length} battles across the system`;
        if (names.length) {
          sub = names.join(' · ') + (onScreen.length > names.length ? ' · …' : '');
        }
      } else if (!shot?.bodyId && caps.length >= 2) {
        line = `${caps.length} worlds change hands`;
      } else if (!shot?.bodyId && (transitAt.get(curTick)?.length ?? 0) >= 3) {
        line = `${transitAt.get(curTick)!.length} fleets under way`;
      }
      if (!line && focusId && byId.has(focusId)
          && drawableAt(byId.get(focusId)!, curTick)) {
        const nm = byId.get(focusId)!.name ?? 'this world';
        const cap = caps.find(c => c.body === focusId);
        const live = onScreen.some(b => b.body_id === focusId);
        const ev = events.find(e => e.bodyId === focusId
          && Math.abs(e.tick - curTick) <= 1 && e.kind !== 'pact');
        const sides = [...(harbour.get(focusId)?.keys() ?? [])]
          .filter(k => k !== 'n').map(k => faction(k)?.name ?? '')
          .filter(Boolean).slice(0, 3);
        if (cap && cap.to) {
          line = cap.from
            ? `${nm} FALLS — ${faction(cap.to)?.name ?? 'a rival'} takes it`
              + ` from ${faction(cap.from)?.name ?? 'its holder'}`
            : `${nm} SETTLED — ${faction(cap.to)?.name ?? 'a new colony'}`;
        } else if (cap && !cap.to) {
          line = `${nm} LOST — ${faction(cap.from)?.name ?? 'its holder'} driven off`;
        } else if (live) {
          line = `Battle at ${nm}`
            + (sides.length >= 2 ? ` — ${sides.join(' vs ')}` : '');
          const others = onScreen.filter(b => b.body_id !== focusId).length;
          if (others > 0) sub = `+${others} more battle${others === 1 ? '' : 's'} in system`;
        } else if (ev?.kind === 'loss') {
          const n = ev.count ?? 1;
          line = `${n} ship${n === 1 ? '' : 's'} lost at ${nm}`;
        } else if (ev?.kind === 'founded') line = `${nm} SETTLED`;
        else if (ev?.kind === 'fallen') line = `${nm} — settlement lost`;
      }
      // Eliminations and lead changes are headline events in their own
      // right; they used to happen only as a number change in the panel.
      for (const [fid, tk] of elimAt) {
        if (Math.abs(tk - curTick) <= 2) {
          line = `${faction(fid)?.name ?? 'An empire'} ELIMINATED`;
          sub = `T+${tk}`;
        }
      }
      // A bill landing outranks a quiet map moment: it changes the
      // rules for everyone, which is the biggest thing that can happen
      // on a tick with no shooting.
      {
        const { bill, phase } = senateAt(curTick);
        const res = bill?.resolved_at_tick;
        if (bill && res != null && Math.abs(res - curTick) <= 1) {
          const passed = bill.status === 'passed';
          line = `SENATE — "${bill.title || bill.kind}" ${passed ? 'PASSES' : 'FAILS'}`;
          let yea = 0, nay = 0;
          for (const v of bill.votes) {
            if (v.vote === 'yea') yea += v.weight || 1;
            else if (v.vote === 'nay') nay += v.weight || 1;
          }
          sub = `${yea} yea · ${nay} nay`
            + (bill.proposer_faction_id
              ? ` · proposed by ${faction(bill.proposer_faction_id)?.name ?? 'a member'}`
              : '');
        } else if (bill && phase === 'vote' && !line) {
          line = `SENATE VOTES — "${bill.title || bill.kind}"`;
        }
      }

      const lead = leadAt.get(curTick);
      if (lead && !line) {
        line = `${faction(lead)?.name ?? 'A new empire'} TAKES THE LEAD`;
      }

      if (line) {
        // A LOWER THIRD, NOT A SPEECH BUBBLE. The caption used to hang off
        // whichever body the shot was on, so it wandered into other
        // worlds' labels -- reported in three separate rounds, and not
        // fixable by nudging, because at some zoom the anchor always lands
        // on something. Pinning it above the timeline, the way match film
        // has always captioned itself, makes the collision impossible
        // rather than merely unlikely.
        ctx.font = '600 15px system-ui, sans-serif';
        ctx.textAlign = 'center'; ctx.textBaseline = 'top';
        const wMain = ctx.measureText(line).width;
        ctx.font = '11px system-ui, sans-serif';
        const wSub = sub ? ctx.measureText(sub).width : 0;
        const boxW = Math.min(W - PANEL_W - 40, Math.max(wMain, wSub) + 24);
        const boxH = sub ? 42 : 26;
        const cx = (W - PANEL_W) / 2;
        const cy = H - SAFE_BOTTOM - boxH - 16;
        capRect = { x: cx - boxW / 2, y: cy, w: boxW, h: boxH };
        ctx.fillStyle = 'rgba(4,8,14,0.88)';
        ctx.fillRect(cx - boxW / 2, cy, boxW, boxH);
        ctx.strokeStyle = 'rgba(150,180,215,0.45)';
        ctx.strokeRect(cx - boxW / 2 + 0.5, cy + 0.5, boxW - 1, boxH - 1);
        ctx.fillStyle = '#eef4fb';
        ctx.font = '600 15px system-ui, sans-serif';
        ctx.fillText(line, cx, cy + 5);
        if (sub) {
          ctx.fillStyle = '#93a9bf';
          ctx.font = '11px system-ui, sans-serif';
          ctx.fillText(sub, cx, cy + 25);
        }
      }
    }

    // Labels, after everything so they sit on top.
    // Body names as the game sets them: uppercase, letter-spaced, a
    // muted blue-grey, and no plate behind them.
    ctx.font = '600 11px system-ui, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    const placed: Array<{ x: number; y: number; w: number }> = [];
    // Seed the collision list with the caption, a row at a time: the test
    // below compares a 12px band, so one entry would only shield a sliver
    // of a two-line box.
    if (capRect) {
      for (let y = capRect.y; y <= capRect.y + capRect.h; y += 10) {
        placed.push({ x: capRect.x + capRect.w / 2, y, w: capRect.w + 10 });
      }
    }
    for (const l of labelAt) {
      const caps = l.name.toUpperCase();
      const spaced = caps.split('').join('\u2009');
      const w = ctx.measureText(spaced).width;
      const ly = l.y + l.r + 6;
      // Skip a name that would land on one already drawn: at system
      // zoom the asteroid cluster otherwise stacks six labels in a heap.
      let clash = false;
      for (const q of placed) {
        if (Math.abs(q.y - ly) < 12 && Math.abs(q.x - l.x) < (q.w + w) / 2 + 4) {
          clash = true; break;
        }
      }
      if (clash) continue;
      placed.push({ x: l.x, y: ly, w });
      ctx.fillStyle = 'rgba(3,7,14,0.55)';
      ctx.fillRect(l.x - w / 2 - 3, ly - 1, w + 6, 13);
      ctx.fillStyle = l.fid ? hexA(colorOf(l.fid), 0.95) : 'rgba(190,208,228,0.9)';
      ctx.fillText(spaced, l.x, ly);
    }

    ctx.restore();   // end map clip
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

    const PW = PANEL_W - 12, rowH = 32;
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
      ctx.fillText(nShips + (nShips === 1 ? ' ship' : ' ships'),
        px0 + PW - 34, y + 3);

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
        const st = world.stock.get(f.id) ?? [0, 0, 0];
        // ONE SCALE FOR THE WHOLE MATCH. Normalised per row, every
        // bar rendered near-full and cross-empire comparison -- the
        // only reason to draw them -- was impossible.
        // Square-root scale. On a linear match-wide scale the first
        // half of the film was 3%-fill nubs carrying no information.
        const total = Math.sqrt(stockMax) * 3;
        // metal, credits, science -- the three resources the game has.
        const cols = ['#9aa7b6', '#e8c36a', '#6fb4ee'];
        let bx = px0 + 34;
        const bw = PW - 44;
        ctx.fillStyle = 'rgba(255,255,255,0.07)';
        ctx.fillRect(bx, y + 18, bw, 7);
        for (let k = 0; k < 3; k++) {
          const seg = (Math.sqrt(Math.max(0, st[k])) / total) * bw;
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
        ['credits', '#e8c36a'], ['science', '#6fb4ee']];
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

    // ---- the senate --------------------------------------------------
    //
    // The chamber gets its own strip under the standings: which bill is
    // live, what phase it is in, and how the vote is falling. Weight is
    // worlds held, so this doubles as a second reading of the balance
    // of power.
    {
      const { bill, phase } = senateAt(curTick);
      const sx = W - PANEL_W - 8, sy = py0 + panelH + 22;
      const sw = PANEL_W - 12;
      const sh = bill ? 62 : 26;
      ctx.fillStyle = 'rgba(4,8,14,0.8)';
      ctx.fillRect(sx, sy, sw, sh);
      ctx.strokeStyle = 'rgba(120,150,190,0.25)'; ctx.lineWidth = 1;
      ctx.strokeRect(sx + 0.5, sy + 0.5, sw - 1, sh - 1);
      ctx.font = '600 10px system-ui, sans-serif';
      ctx.textAlign = 'left'; ctx.textBaseline = 'top';
      ctx.fillStyle = '#7f97ad';
      ctx.fillText('THE SENATE', sx + 10, sy + 7);
      if (!bill) {
        ctx.textAlign = 'right';
        ctx.fillStyle = '#5d7189';
        ctx.fillText('in recess', sx + sw - 10, sy + 7);
      } else {
        const label = phase === 'debate' ? 'DEBATING'
          : phase === 'vote' ? 'VOTING'
          : bill.status === 'passed' ? 'PASSED' : 'FAILED';
        const lc = phase === 'vote' ? '#e8c36a'
          : phase === 'resolved'
            ? (bill.status === 'passed' ? '#6ee7a5' : '#ff8f7a')
            : '#8ea3b8';
        ctx.textAlign = 'right';
        ctx.fillStyle = lc;
        ctx.fillText(label, sx + sw - 10, sy + 7);

        ctx.textAlign = 'left';
        ctx.fillStyle = '#e6f0f8';
        ctx.font = '600 12px system-ui, sans-serif';
        let ttl = bill.title || bill.kind;
        const tmax = sw - 20;
        if (ctx.measureText(ttl).width > tmax) {
          while (ttl.length > 1 && ctx.measureText(ttl + '…').width > tmax) {
            ttl = ttl.slice(0, -1);
          }
          ttl += '…';
        }
        ctx.fillText(ttl, sx + 10, sy + 21);

        // The vote as a weighted bar: yea / nay / not yet cast.
        let yea = 0, nay = 0;
        for (const v of bill.votes) {
          if (v.vote === 'yea') yea += v.weight || 1;
          else if (v.vote === 'nay') nay += v.weight || 1;
        }
        const cast = yea + nay;
        const barW2 = sw - 20;
        const total = Math.max(1, cast);
        ctx.fillStyle = 'rgba(255,255,255,0.08)';
        ctx.fillRect(sx + 10, sy + 40, barW2, 7);
        ctx.fillStyle = '#6ee7a5';
        ctx.fillRect(sx + 10, sy + 40, (yea / total) * barW2, 7);
        ctx.fillStyle = '#ff8f7a';
        ctx.fillRect(sx + 10 + (yea / total) * barW2, sy + 40,
          (nay / total) * barW2, 7);
        ctx.font = '9px system-ui, sans-serif';
        ctx.fillStyle = '#8ea3b8';
        ctx.textAlign = 'left';
        ctx.fillText('yea ' + yea, sx + 10, sy + 50);
        ctx.textAlign = 'right';
        ctx.fillText('nay ' + nay, sx + sw - 10, sy + 50);
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
      ctx.fillStyle = 'rgba(255,255,255,0.09)';
      ctx.fillRect(barX, barY - 5, barW, 1);
      const peak = Math.max(1, ...bin);
      const bwid = barW / BINS;
      for (let i = 0; i < BINS; i++) {
        if (!bin[i]) continue;
        const hgt = 4 + (bin[i] / peak) * 14;
        ctx.fillStyle = 'rgba(255,130,95,0.8)';
        ctx.fillRect(barX + i * bwid, barY - 4 - hgt, Math.max(1.2, bwid - 0.8), hgt);
      }
    }
    // Senate marks sit above the battle histogram: the political track
    // and the military one, on one timeline.
    for (const b of summary.senate ?? []) {
      const at = b.resolved_at_tick ?? b.vote_closes_at_tick;
      if (at == null) continue;
      const f = (at - lo) / Math.max(1, hi - lo);
      ctx.fillStyle = b.status === 'passed'
        ? 'rgba(110,231,165,0.9)' : 'rgba(255,143,122,0.9)';
      ctx.beginPath();
      ctx.arc(barX + f * barW, barY - 26, 3, 0, Math.PI * 2);
      ctx.fill();
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
      ctx.fillStyle = 'rgba(150,175,200,0.3)';
      ctx.fillRect(barX, barY - 3, fw, 9);
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
      timeline.append(rows); rebuildStandings(); rebuildTransits(); rebuildShots();
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

/**
 * A fleet chip, drawn the way the game draws them: a black rounded
 * plate with a bright faction-coloured border, a small glyph, and the
 * count in white. These are the strongest thing on the real map -- you
 * read force disposition off the chips, not off the hulls.
 */
function badge(ctx: CanvasRenderingContext2D, x: number, y: number,
               text: string, color: string) {
  ctx.font = '700 11px system-ui, sans-serif';
  ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  const tw = ctx.measureText(text).width;
  const w = tw + 22, h = 18, r = 5;
  const x0 = x - w / 2, y0 = y - h / 2;
  ctx.beginPath();
  ctx.moveTo(x0 + r, y0);
  ctx.arcTo(x0 + w, y0, x0 + w, y0 + h, r);
  ctx.arcTo(x0 + w, y0 + h, x0, y0 + h, r);
  ctx.arcTo(x0, y0 + h, x0, y0, r);
  ctx.arcTo(x0, y0, x0 + w, y0, r);
  ctx.closePath();
  ctx.fillStyle = 'rgba(6,10,16,0.94)';
  ctx.fill();
  ctx.strokeStyle = color; ctx.lineWidth = 1.6;
  ctx.stroke();
  // Glyph: a small hull mark in the faction's colour.
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(x0 + 6, y0 + 5);
  ctx.lineTo(x0 + 14, y0 + 9);
  ctx.lineTo(x0 + 6, y0 + 13);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#f2f7fc';
  ctx.fillText(text, x0 + 17, y);
}
