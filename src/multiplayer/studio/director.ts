// ============================================================================
// director.ts — the studio's camera, clock and recorder, on the live map.
//
// A SHOT is a small JSON script: where the camera looks, when it moves,
// which ticks to run, what words to put on screen. The director plays it
// two ways. PREVIEW runs it against the wall clock so a person can watch
// it on the map. RECORD runs it on a clock only the director advances,
// one frame at a time, draws each frame into a video canvas and hands the
// frames to the browser's own MediaRecorder, so a frame that took 200ms
// to draw on a slow machine is still exactly 1/30s of video. That is the
// same trick the battle recap's vertical video uses (recapVideo.ts).
//
// It is installed on window.__studio by StudioBridge for admins, so an
// agent driving headless Chrome and a person at the Studio bar use the
// same six verbs. docs/STUDIO.md is the manual.
//
// THE CAMERA is eased here, not by the map: every frame writes an exact
// camera through the 'orbital:studio-camera' event, which MapCanvas
// applies 1:1 (no tween), so a glide is the same in preview and on tape.
// ============================================================================

import type { Body, GameState, Ship } from '../../types';
import { bodyPosition } from '../../physics/orbitalMechanics';
import { torchPositionFromSamples } from '../../physics/torchTransfer';
import { drawnShipWorldPos, torchTrajectorySamples } from '../../render/mapRenderer';
import { shipWorldPosition } from '../../game/combat';
import { smoothedTick, setStudioDisplayTick } from '../../render/tickPhase';
import { setStudioFullVisuals } from '../../render/lightweightMode';
import { apiFetch } from '../api';

export type Target = string; // 'earth' | 'ship:<id>' | 'fleet:<id>' | 'missile:<n>'

export type ShotStep =
  | { at: number; do: 'focus'; target: Target; px?: number; scale?: number }
  | { at: number; do: 'pan'; target: Target; ms?: number; px?: number; scale?: number }
  | { at: number; do: 'zoom'; px?: number; scale?: number; factor?: number; ms?: number; target?: Target }
  | { at: number; do: 'follow'; target: Target }
  | { at: number; do: 'tick'; n?: number }
  | { at: number; do: 'speed'; ms: number }
  | { at: number; do: 'caption'; text: string; color?: string }
  | { at: number; do: 'hook'; text: string }
  | { at: number; do: 'ui'; show: boolean }
  | { at: number; do: 'panel'; id: PanelId | null }
  | { at: number; do: 'click'; selector: string }
  | { at: number; do: 'intercept'; ships: Target; target: Target }
  | { at: number; do: 'strike'; ship: string; ticks?: number };

/** The game's panels, by the name the dock and the shell know them by. */
export type PanelId = 'senate' | 'faction' | 'comms' | 'trades' | 'situation' | 'eventlog' | 'multiplayer'
  | 'settlements' | 'fleet' | 'research';

export interface Shot {
  /** Video shape. 9:16 for TikTok/Shorts/Reels, 16:9 for YouTube and X. */
  format?: '9:16' | '16:9' | '1:1';
  fps?: number;
  /** Length of the clip, seconds, before the end card. */
  seconds: number;
  /** Shown from frame one in the white box, like TikTok's own text. */
  hook?: string;
  /** Page milliseconds one tick glides over. Default 2500, or 900 at the
   *  fast tempo. */
  speed?: number;
  /** 'fast' is the marketing cut: ticks glide over 900 ms and camera moves
   *  default to 1300 ms. Explicit `speed` and per-step `ms` still win. */
  tempo?: 'fast' | 'normal';
  /** The closing card with the URL; on by default. */
  endCard?: boolean;
  /** Extra zoom applied when the map is cropped into the video frame. */
  zoomBoost?: number;
  /** Keep the game's interface (top bar, outliner, dock) in the shot.
   *  Film mode defaults to true, the way the showcase clips were made;
   *  record (the phone cut) defaults to false. The painted debug
   *  readouts and the staging banner are never in a shot. */
  ui?: boolean;
  steps: ShotStep[];
}

export interface RecordStats { frames: number; draws: number; unchanged: number; rafRuns: number }

export interface DirectorHost {
  gameId: string;
  state(): GameState;
  mapCanvas(): HTMLCanvasElement | null;
  deselect(): void;
  /** Send the viewer's own parked hulls to intercept a ship in flight,
   *  with the game's planner, the way the intercept picker does. Returns
   *  how many hulls were sent. */
  intercept?(shipIds: string[], targetShipId: string): Promise<{ sent: number; failed: number; error?: string }>;
  /** The same plan without sending it: per hull, when it would depart,
   *  meet the target, and arrive. For choosing a scene's numbers. */
  planIntercept?(shipIds: string[], targetShipId: string): Array<{ ship: string; depart: number; meet: number | null; arrive: number; accel: number } | { ship: string; none: true }>;
}

interface Cam { x: number; y: number; scale: number }
interface Tween { fromScale: number; toScale: number; fromX: number; fromY: number; t0: number; ms: number; target: Target | null }

const FORMATS = { '9:16': [1080, 1920], '16:9': [1920, 1080], '1:1': [1080, 1080] } as const;
const FONT = '"Segoe UI", system-ui, sans-serif';
const easeInOut = (u: number) => (1 - Math.cos(Math.PI * Math.min(1, Math.max(0, u)))) / 2;

function pickMime(): string | null {
  if (typeof MediaRecorder === 'undefined') return null;
  for (const m of ['video/mp4;codecs=avc1.640028', 'video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm']) {
    if (MediaRecorder.isTypeSupported(m)) return m;
  }
  return null;
}

export class Director {
  /** Default camera move length for this shot (the tempo), or null. */
  private moveMs: number | null = null;
  private host: DirectorHost;
  private cam: Cam = { x: 0, y: 0, scale: 0.5 };
  private hold: Target | null = null;        // what the centre tracks when no pan is running
  private tween: Tween | null = null;
  private clock = 0;                          // seconds into the shot
  private caption: { text: string; since: number; color?: string } | null = null;
  private hook: string | null = null;
  private running = false;
  private cancelFlag = false;
  private tickSpeedMs: number | null = null;
  private tickWall = new Map<number, number>();
  /** The glide the map draws while filming: from tick `from` (landed at
   *  film time `at`) to from+1 over `ms`. See smoothTicks(). */
  private glide: { from: number; at: number; ms: number } | null = null;
  /** How long the NEXT tick to land should glide: the gap to the tick
   *  step after it, so one tick hands over to the next with no stop. */
  private nextGlideMs: number | null = null;
  private realFetch: typeof fetch | null = null;
  /** The last recording, for the Studio bar's download and the CLI's pull. */
  lastBlob: Blob | null = null;
  lastExt = 'mp4';
  result: { ok: boolean; bytes?: number; mime?: string; error?: string; stats?: RecordStats } | null = null;
  /** The last recording's accounting: how many frames were asked for,
   *  how many map draws the clock produced, how many frames came out of
   *  the map unchanged (Chrome's canvas capture drops those). */
  stats: RecordStats = { frames: 0, draws: 0, unchanged: 0, rafRuns: 0 };
  progress = 0;
  log: string[] = [];

  constructor(host: DirectorHost) { this.host = host; }

  /** The game this director is attached to. A CLI checks it before
   *  recording: the app opens whichever room it last had, and a shot
   *  filmed in the wrong game is wrong in every frame. */
  get gameId(): string { return this.host.gameId; }

  // ---------- targets ----------

  private tick(): number {
    const s = this.host.state();
    return smoothedTick(s.currentTick, s.nextTickAt, s.tickIntervalMs, Date.now());
  }

  private body(id: string): Body | undefined {
    return this.host.state().bodies.find(b => b.id === id);
  }

  /** Ships and fleets carry the game id in front ('<game>:st_fr_0');
   *  shots name them without it, the way the CLI prints them. */
  private ship(id: string): Ship | undefined {
    return this.host.state().ships.find(x => x.id === id || x.id.endsWith(`:${id}`));
  }
  /** Salvos in the order they first appeared during this shot. A salvo's
   *  id carries its launch tick ('<game>:msl_<tick>_<rand>'), which a shot
   *  cannot know ahead, so shots name them 'missile:1', 'missile:2'. */
  private seenMissiles: string[] = [];
  private missile(n: number): Ship | undefined {
    const live = this.host.state().ships
      .filter(x => /:msl_\d+_/.test(x.id))
      .sort((a, b) => {
        const ta = Number(/:msl_(\d+)_/.exec(a.id)?.[1] ?? 0), tb = Number(/:msl_(\d+)_/.exec(b.id)?.[1] ?? 0);
        return ta - tb || a.id.localeCompare(b.id);
      });
    for (const x of live) if (!this.seenMissiles.includes(x.id)) this.seenMissiles.push(x.id);
    const id = this.seenMissiles[n - 1];
    return id ? live.find(x => x.id === id) : undefined;
  }
  private fleetMembers(id: string): Ship[] {
    return this.host.state().ships.filter(x => x.fleetId != null && (x.fleetId === id || x.fleetId.endsWith(`:${id}`)));
  }

  /** Where a target is on the map this frame, in world units. */
  position(target: Target): { x: number; y: number } | null {
    const s = this.host.state();
    const tick = this.tick();
    if (target.startsWith('ship:')) {
      const ship = this.ship(target.slice(5));
      if (!ship) return null;
      return this.shipPos(ship, tick);
    }
    if (target.startsWith('missile:')) {
      const m = this.missile(Math.max(1, Number(target.slice(8)) || 1));
      return m ? this.shipPos(m, tick) : null;
    }
    if (target.startsWith('fleet:')) {
      const members = this.fleetMembers(target.slice(6));
      const lead = members.find(x => x.transit) ?? members[0];
      return lead ? this.shipPos(lead, tick) : null;
    }
    const b = this.body(target);
    if (!b) return null;
    const p = bodyPosition(b, tick, s.bodies);
    return { x: p.x, y: p.y };
  }

  private shipPos(ship: Ship, tick: number): { x: number; y: number } | null {
    const drawn = drawnShipWorldPos(ship.id);
    if (drawn) return drawn;
    if (ship.transit?.currentTransfer) {
      try {
        const samples = torchTrajectorySamples(ship.transit.currentTransfer, this.host.state().bodies);
        const p = torchPositionFromSamples(samples, tick);
        if (p) return { x: p.x, y: p.y };
      } catch { /* fall through */ }
    }
    const p = shipWorldPosition(ship, tick, this.host.state().bodies);
    return p ? { x: p.x, y: p.y } : null;
  }

  /** The world the target sits at, for sizing: a ship's parent when parked. */
  private bodyFor(target: Target): Body | undefined {
    if (target.startsWith('ship:') || target.startsWith('fleet:')) {
      const ship = target.startsWith('ship:')
        ? this.ship(target.slice(5))
        : this.fleetMembers(target.slice(6))[0];
      const pid = ship?.orbit?.parentBodyId;
      return pid ? this.body(pid) : undefined;
    }
    return this.body(target);
  }

  /** The scale that draws `body` `px` pixels across on the map canvas. */
  scaleFor(target: Target | undefined, px: number): number {
    const b = target ? this.bodyFor(target) : undefined;
    const r = b ? Math.max(0.05, b.radius) : 6;
    return Math.max(0.0006, Math.min(60, px / (2 * r)));
  }

  // ---------- the six verbs ----------

  /** Cut to a target. `px` sizes its world across the frame. */
  focus(target: Target, o: { px?: number; scale?: number } = {}): void {
    const p = this.position(target);
    if (!p) { this.note(`focus: no such target ${target}`); return; }
    this.tween = null;
    this.hold = target;
    this.cam.x = p.x; this.cam.y = p.y;
    if (o.scale) this.cam.scale = o.scale;
    else if (o.px) this.cam.scale = this.scaleFor(target, o.px);
    this.push();
  }

  /** Glide to a target over `ms`, then hold on it. */
  pan(target: Target, o: { ms?: number; px?: number; scale?: number } = {}): void {
    if (!this.position(target)) { this.note(`pan: no such target ${target}`); return; }
    const toScale = o.scale ?? (o.px ? this.scaleFor(target, o.px) : this.cam.scale);
    this.tween = { fromX: this.cam.x, fromY: this.cam.y, fromScale: this.cam.scale, toScale, t0: this.clock, ms: o.ms ?? this.moveMs ?? 2000, target };
    this.hold = target;
  }

  /** Change scale over `ms`, holding whatever the camera holds. */
  zoom(o: { px?: number; scale?: number; factor?: number; ms?: number; target?: Target }): void {
    const target = o.target ?? this.hold;
    const toScale = o.scale ?? (o.px ? this.scaleFor(target ?? undefined, o.px) : this.cam.scale * (o.factor ?? 1));
    this.tween = { fromX: this.cam.x, fromY: this.cam.y, fromScale: this.cam.scale, toScale, t0: this.clock, ms: o.ms ?? this.moveMs ?? 1500, target: target ?? null };
  }

  /** Keep the centre on a moving target from now on. */
  follow(target: Target): void { this.hold = target; this.tween = null; }

  /** Hide or show the game's interface around the map. */
  ui(show: boolean): void {
    document.body.classList.toggle('studio-cinema', !show);
    if (!show) this.host.deselect();
  }

  /** Open one of the game's panels the way a tap on the dock would, or
   *  close whatever is open (null). senate / faction / comms are tabs of
   *  the multiplayer dock; trades is the trade dock; situation / eventlog
   *  / multiplayer are the rail's own buttons. */
  panel(id: PanelId | null): void {
    const ev = (name: string, detail: unknown) => {
      try { window.dispatchEvent(new CustomEvent(name, { detail })); } catch { /* no window */ }
    };
    if (id === null) {
      ev('dockrail:set', { active: null });
      ev('orbital:open-panel', { panel: null });
      return;
    }
    if (id === 'situation' || id === 'eventlog' || id === 'multiplayer') {
      ev('dockrail:set', { active: id });
      return;
    }
    ev('orbital:open-panel', { panel: id });
  }

  /** The full ids a target names: a ship, every hull of a fleet. */
  private idsOf(target: Target): string[] {
    if (target.startsWith('ship:')) { const s = this.ship(target.slice(5)); return s ? [s.id] : []; }
    if (target.startsWith('fleet:')) return this.fleetMembers(target.slice(6)).map(s => s.id);
    if (target.startsWith('missile:')) { const m = this.missile(Number(target.slice(8)) || 1); return m ? [m.id] : []; }
    return [];
  }

  /** The viewer's parked hulls intercept a ship (or a fleet's lead) in
   *  flight. They meet it, then fly its plan to its world. The launch is
   *  on the next tick. */
  async intercept(ships: Target, target: Target): Promise<number> {
    const ids = this.idsOf(ships);
    const [targetId] = this.idsOf(target);
    if (!ids.length || !targetId) { this.note(`intercept: nothing for ${ships} -> ${target}`); return 0; }
    if (!this.host.intercept) { this.note('intercept: this build has no intercept'); return 0; }
    const r = await this.host.intercept(ids, targetId);
    this.note(`intercept: ${r.sent} sent, ${r.failed} could not${r.error ? ` (${r.error})` : ''}`);
    return r.sent;
  }

  /** Dry run of intercept(): what each hull would do, nothing sent. */
  interceptPlan(ships: Target, target: Target): unknown {
    const ids = this.idsOf(ships);
    const [targetId] = this.idsOf(target);
    if (!ids.length || !targetId || !this.host.planIntercept) return [];
    return this.host.planIntercept(ids, targetId);
  }

  /** Arm a Mega Destroyer over the world it has arrived at, firing in
   *  `ticks` ticks (the studio route; the player's order charges 24). */
  async strike(ship: string, ticks = 3): Promise<boolean> {
    const res = await apiFetch<{ fires_at_tick: number }>(`/api/admin/studio/games/${this.host.gameId}/strike`, {
      method: 'POST', body: JSON.stringify({ ship: ship.replace(/^ship:/, ''), ticks }),
    });
    this.note(res.ok ? `strike: fires at tick ${res.data.fires_at_tick}` : `strike: ${res.error?.message ?? res.status}`);
    return !!res.ok;
  }

  /** Click the first element a CSS selector finds: a disclosure's
   *  summary, a tab, a button. Returns false (and notes it) when nothing
   *  matches, so a shot keeps playing. */
  click(selector: string): boolean {
    const el = document.querySelector<HTMLElement>(selector);
    if (!el) { this.note(`click: nothing matches ${selector}`); return false; }
    el.click();
    return true;
  }

  /** Make each server tick glide over `ms` of page time (2500 reads
   *  well for a battle; 1000 for a crossing). The map paints ticks by
   *  the wall clock between /state polls, so the poll is rewritten here. */
  speed(ms: number | null): void {
    this.tickSpeedMs = ms;
    if (ms == null) { this.restoreFetch(); return; }
    if (this.realFetch) return;
    const real = window.fetch.bind(window);
    this.realFetch = real;
    const self = this;
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const res = await real(input, init);
      if (!/\/api\/games\/[^/]+\/state/.test(url) || self.tickSpeedMs == null) return res;
      try {
        const data = await res.clone().json();
        const g = data?.game;
        if (!g || typeof g.current_tick !== 'number') return res;
        if (!self.tickWall.has(g.current_tick)) self.tickWall.set(g.current_tick, Date.now());
        g.tick_interval_ms = self.tickSpeedMs;
        g.next_tick_at = (self.tickWall.get(g.current_tick) ?? Date.now()) + self.tickSpeedMs;
        return new Response(JSON.stringify(data), { status: res.status, statusText: res.statusText, headers: res.headers });
      } catch { return res; }
    };
  }
  private restoreFetch(): void {
    if (this.realFetch) { window.fetch = this.realFetch; this.realFetch = null; }
  }

  /** Run `n` server ticks and wait until the map has them. */
  async ticks(n = 1): Promise<number> {
    const before = this.host.state().currentTick;
    // Bounded: a tick request that never answers froze two takes for an
    // hour. After 30 s, assume the server ticked and wait on the map.
    const res = await Promise.race([
      apiFetch<{ current_tick: number }>(`/api/admin/studio/games/${this.host.gameId}/tick`, {
        method: 'POST', body: JSON.stringify({ n }),
      }),
      realSleep(30_000).then(() => null),
    ]);
    if (res && !res.ok) throw new Error(`tick: ${res.error?.message ?? res.status}`);
    if (!res) this.note(`tick: no answer in 30 s at tick ${before}; waiting on the map`);
    const want = res?.data?.current_tick ?? before + n;
    const t0 = Date.now();
    while (this.host.state().currentTick < want && Date.now() - t0 < 90_000) await realSleep(250);
    return this.host.state().currentTick;
  }

  // ---------- frame ----------

  /** Where the camera is after `dt` more seconds of the shot. */
  private step(dt: number): void {
    this.clock += dt;
    const tw = this.tween;
    if (tw) {
      const u = easeInOut((this.clock - tw.t0) * 1000 / Math.max(1, tw.ms));
      const dest = tw.target ? this.position(tw.target) : null;
      const tx = dest ? dest.x : tw.fromX, ty = dest ? dest.y : tw.fromY;
      this.cam.x = tw.fromX + (tx - tw.fromX) * u;
      this.cam.y = tw.fromY + (ty - tw.fromY) * u;
      this.cam.scale = Math.exp(Math.log(tw.fromScale) + (Math.log(tw.toScale) - Math.log(tw.fromScale)) * u);
      if (u >= 1) this.tween = null;
    } else if (this.hold) {
      const p = this.position(this.hold);
      if (p) { this.cam.x = p.x; this.cam.y = p.y; }
    }
    this.push();
  }

  private push(): void {
    window.dispatchEvent(new CustomEvent('orbital:studio-camera', {
      detail: { x: this.cam.x, y: this.cam.y, scale: this.cam.scale, focusedBodyId: undefined },
    }));
  }

  private note(s: string): void { this.log.push(s); if (this.log.length > 200) this.log.shift(); }

  /** Seconds from a tick step to the next tick step, or null. */
  private static gapAfter(steps: ShotStep[], at: number): number | null {
    let next: number | null = null;
    for (const s of steps) if (s.do === 'tick' && s.at > at + 1e-9 && (next == null || s.at < next)) next = s.at;
    return next == null ? null : next - at;
  }

  /**
   * Smooth motion through ticks while filming. The map draws at a tick the
   * director computes on the film's clock: each landed tick glides to the
   * next over exactly the time until the next tick step, so ships and
   * worlds keep moving at an even pace through every boundary instead of
   * stopping and jumping. Before the first tick the glide is already
   * under way at the same pace and lands as that tick fires. After the
   * last tick it glides one more tick at the shot's speed and holds.
   */
  private smoothTicks(shot: Shot, now: () => number): void {
    const ticks = shot.steps.filter(s => s.do === 'tick').map(s => s.at).sort((a, b) => a - b);
    const pace = (ticks.length > 1 ? (ticks[1] - ticks[0]) * 1000 : null) ?? this.tickSpeedMs ?? 2500;
    const startTick = this.host.state().currentTick;
    if (ticks.length) {
      const firstMs = Math.max(0, ticks[0] * 1000);
      // Phase at the opening frame, so tick 1 lands as the glide ends.
      this.glide = { from: startTick, at: now() - Math.max(0, pace - firstMs), ms: Math.max(firstMs, pace) };
    } else {
      this.glide = { from: startTick, at: now(), ms: this.tickSpeedMs ?? 2500 };
    }
    setStudioDisplayTick((ct: number) => {
      const t = now();
      if (!this.glide || ct !== this.glide.from) {
        this.glide = { from: ct, at: t, ms: this.nextGlideMs ?? this.tickSpeedMs ?? 2500 };
      }
      const u = (t - this.glide.at) / Math.max(1, this.glide.ms);
      return ct + (u < 0 ? 0 : u > 1 ? 1 : u);
    });
  }
  private unsmoothTicks(): void {
    setStudioDisplayTick(null);
    this.glide = null;
    this.nextGlideMs = null;
  }

  /** Fire every step whose time has come. Ticks are awaited: the clock
   *  does not move while the server works. */
  private async fire(steps: ShotStep[], fired: Set<ShotStep>): Promise<void> {
    for (const st of steps) {
      if (fired.has(st) || st.at > this.clock + 1e-9) continue;
      fired.add(st);
      if (st.do === 'tick') {
        const gap = Director.gapAfter(steps, st.at);
        this.nextGlideMs = gap != null && gap <= 6 ? gap * 1000 : null;
      }
      switch (st.do) {
        case 'focus': this.focus(st.target, st); break;
        case 'pan': this.pan(st.target, st); break;
        case 'zoom': this.zoom(st); break;
        case 'follow': this.follow(st.target); break;
        case 'speed': this.speed(st.ms); break;
        case 'ui': this.ui(st.show); break;
        case 'panel': this.panel(st.id); break;
        case 'click': this.click(st.selector); break;
        case 'intercept': await this.intercept(st.ships, st.target); break;
        case 'strike': await this.strike(st.ship, st.ticks); break;
        case 'hook': this.hook = st.text; break;
        case 'caption': this.caption = { text: st.text, since: this.clock, color: st.color }; break;
        case 'tick': await this.ticks(st.n ?? 1); break;
      }
    }
  }

  // ---------- preview ----------

  /** Play the shot on the map in real time. Resolves when it ends. */
  async preview(shot: Shot): Promise<void> {
    if (this.running) throw new Error('already running');
    this.running = true; this.cancelFlag = false;
    this.begin(shot);
    const fired = new Set<ShotStep>();
    let last = performance.now();
    try {
      while (this.clock < shot.seconds && !this.cancelFlag) {
        await this.fire(shot.steps, fired);
        await new Promise<void>(r => requestAnimationFrame(() => r()));
        const now = performance.now();
        this.step(Math.min(0.1, (now - last) / 1000));
        last = now;
        this.progress = this.clock / shot.seconds;
      }
    } finally { this.end(); }
  }

  cancel(): void { this.cancelFlag = true; }

  private begin(shot: Shot): void {
    this.clock = 0; this.tween = null; this.hold = null; this.caption = null;
    this.hook = shot.hook ?? null; this.progress = 0; this.result = null;
    // Every effect, every frame: lightweight mode (a phone's or the
    // server's choice) freezes animation and caps the map at 15fps.
    setStudioFullVisuals(true);
    document.body.classList.add('studio-filming');   // no debug HUD, no staging banner
    if (shot.ui) this.host.deselect(); else this.ui(false);
    const fast = shot.tempo === 'fast';
    this.moveMs = fast ? 1300 : null;
    this.speed(shot.speed ?? (fast ? 900 : 2500));
  }
  private end(): void {
    this.running = false;
    this.unsmoothTicks();
    this.moveMs = null;
    this.seenMissiles = [];
    this.speed(null);
    this.ui(true);
    document.body.classList.remove('studio-filming');
    setStudioFullVisuals(false);
  }

  // ---------- record ----------

  /**
   * Record the shot to a video. The page's clock (Date.now, performance
   * .now, requestAnimationFrame) is replaced for the duration with one
   * the director advances 1/fps per frame; the map draws into its own
   * canvas on each advance, and that canvas is cropped into the video.
   */
  async record(shot: Shot, o: { download?: boolean; name?: string } = {}): Promise<Blob | null> {
    if (this.running) throw new Error('already running');
    const mime = pickMime();
    if (!mime) throw new Error('this browser cannot record video');
    this.running = true; this.cancelFlag = false;
    const fps = shot.fps ?? 30;
    const frameMs = 1000 / fps;
    const [W, H] = FORMATS[shot.format ?? '9:16'];
    const out = document.createElement('canvas');
    out.width = W; out.height = H;
    const g = out.getContext('2d')!;
    const endFrames = shot.endCard === false ? 0 : Math.round(3.2 * fps);
    const total = Math.round(shot.seconds * fps) + endFrames;

    const stream = (out as HTMLCanvasElement & { captureStream(fps?: number): MediaStream }).captureStream(0);
    const track = stream.getVideoTracks()[0] as MediaStreamTrack & { requestFrame?: () => void };
    const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 12_000_000 });
    const chunks: Blob[] = [];
    rec.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
    const stopped = new Promise<void>(r => { rec.onstop = () => r(); });

    const vclock = installVirtualClock();
    this.begin(shot);
    this.smoothTicks(shot, vclock.virtualNow);
    const fired = new Set<ShotStep>();
    let recorded = 0;
    this.stats = { frames: 0, draws: 0, unchanged: 0, rafRuns: 0 };
    // THE MAP IS DRAWN HERE, ONCE PER FRAME. MapCanvas's own loop runs on
    // requestAnimationFrame, which the virtual clock holds; its draw hook
    // (__benchDraw, a synchronous render) is called directly instead, so
    // every recorded frame is a fresh render at this frame's time. Canvas
    // capture emits nothing for an unchanged canvas, which is how a missed
    // draw became a dropped frame rather than a repeated one.
    const draw = (window as unknown as { __benchDraw?: (n?: number) => number }).__benchDraw;
    const probe = document.createElement('canvas');
    probe.width = 48; probe.height = 48;
    const pg = probe.getContext('2d', { willReadFrequently: true })!;
    let lastHash = -1;
    try {
      rec.start(1000);
      rec.pause();
      for (let k = 0; k < total; k++) {
        if (this.cancelFlag) break;
        const inShot = k < total - endFrames;
        if (inShot) {
          // Ticks wait on the server in real time; the virtual clock holds.
          await vclock.real(() => this.fire(shot.steps, fired));
          this.step(1 / fps);
          await vclock.real(() => realSleep(0));   // let React commit the camera
        }
        this.stats.rafRuns += vclock.advance(frameMs, !draw);   // time moves; the loop draws only without the hook
        if (draw) { draw(1); this.stats.draws++; }
        const map = this.host.mapCanvas();
        if (map) {
          pg.drawImage(map, 0, 0, 48, 48);
          const d = pg.getImageData(0, 0, 48, 48).data;
          let h = 2166136261;
          for (let i = 0; i < d.length; i += 16) h = Math.imul(h ^ d[i] ^ (d[i + 1] << 8) ^ (d[i + 2] << 16), 16777619) >>> 0;
          if (h === lastHash) this.stats.unchanged++;
          lastHash = h;
        }
        this.stats.frames++;
        this.compose(g, W, H, shot, inShot ? 0 : (k - (total - endFrames)) / Math.max(1, endFrames));
        rec.resume();
        const on = vclock.realNow();
        track.requestFrame?.();
        const hold = Math.max(4, (k + 1) * frameMs - recorded);
        await vclock.real(() => realSleep(hold));
        rec.pause();
        recorded += vclock.realNow() - on;
        this.progress = (k + 1) / total;
      }
      rec.resume();
      rec.stop();
      await vclock.real(() => stopped);
    } finally {
      vclock.uninstall();
      track.stop();
      this.end();
    }
    if (this.cancelFlag) { this.result = { ok: false, error: 'cancelled' }; return null; }
    const type = mime.split(';')[0];
    const blob = new Blob(chunks, { type });
    this.lastBlob = blob;
    this.lastExt = type === 'video/mp4' ? 'mp4' : 'webm';
    this.result = { ok: true, bytes: blob.size, mime: type, stats: { ...this.stats } };
    if (o.download) this.download(o.name);
    return blob;
  }

  // ---------- film: one frame at a time, for an outside camera ----------
  //
  // The Reddit clips were made this way: a stepped clock, one PNG per
  // frame taken by the DevTools protocol, encoded afterwards. Nothing can
  // drop a frame, because the screenshot is the frame. The CLI's `film`
  // command drives these three calls; the map canvas is the whole shot
  // (cinema mode hides the interface), with no overlays of any kind.

  private film: { vclock: ReturnType<typeof installVirtualClock>; shot: Shot; fired: Set<ShotStep>; k: number; total: number; draw?: (n?: number) => number } | null = null;

  /** Start a stepped shot. Returns the frame count. */
  openFilm(shot: Shot): number {
    if (this.running) throw new Error('already running');
    this.running = true; this.cancelFlag = false;
    const fps = shot.fps ?? 30;
    const total = Math.round(shot.seconds * fps);
    const vclock = installVirtualClock();
    this.begin({ ui: true, ...shot });
    this.smoothTicks(shot, vclock.virtualNow);
    this.stats = { frames: 0, draws: 0, unchanged: 0, rafRuns: 0 };
    this.film = { vclock, shot, fired: new Set(), k: 0, total, draw: (window as unknown as { __benchDraw?: (n?: number) => number }).__benchDraw };
    return total;
  }

  /** Advance one frame: run due steps (ticks wait on the server), move the
   *  camera, draw the map. Resolves {k, done}; the caller screenshots. */
  async filmFrame(): Promise<{ k: number; done: boolean }> {
    const f = this.film;
    if (!f) throw new Error('openFilm first');
    const fps = f.shot.fps ?? 30;
    await f.vclock.real(() => this.fire(f.shot.steps, f.fired));
    this.step(1 / fps);
    await f.vclock.real(() => realSleep(0));
    this.stats.rafRuns += f.vclock.advance(1000 / fps, !f.draw);
    if (f.draw) { f.draw(1); this.stats.draws++; }
    this.stats.frames++;
    f.k++;
    this.progress = f.k / f.total;
    return { k: f.k - 1, done: f.k >= f.total };
  }

  /** Hand the clock back and restore the interface. */
  closeFilm(): void {
    const f = this.film;
    this.film = null;
    if (f) f.vclock.uninstall();
    this.end();
  }

  download(name?: string): void {
    if (!this.lastBlob) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(this.lastBlob);
    a.download = `${name ?? 'orbital-studio'}.${this.lastExt}`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  }

  /** The recording in 2MB base64 slices, for a CLI driving the page over
   *  the DevTools protocol, which cannot receive a Blob. */
  async blobChunk(i: number, size = 2_000_000): Promise<string | null> {
    if (!this.lastBlob) return null;
    const from = i * size;
    if (from >= this.lastBlob.size) return null;
    const buf = new Uint8Array(await this.lastBlob.slice(from, from + size).arrayBuffer());
    let s = '';
    for (let j = 0; j < buf.length; j += 0x8000) s += String.fromCharCode(...buf.subarray(j, j + 0x8000));
    return btoa(s);
  }

  /** One video frame: the map cropped to the format, then the words. */
  private compose(g: CanvasRenderingContext2D, W: number, H: number, shot: Shot, endK: number): void {
    const map = this.host.mapCanvas();
    g.fillStyle = '#04060b';
    g.fillRect(0, 0, W, H);
    if (map && map.width > 0 && map.height > 0) {
      const boost = shot.zoomBoost ?? 1;
      const s = Math.max(W / map.width, H / map.height) * boost;
      const dw = map.width * s, dh = map.height * s;
      g.drawImage(map, (W - dw) / 2, (H - dh) / 2, dw, dh);
    }
    const SAFE_L = W * 0.065, SAFE_R = W * 0.935, MID = W / 2;
    const k = W / 1080;
    if (this.hook) {
      g.font = `800 ${64 * k}px ${FONT}`;
      const full = SAFE_R - SAFE_L - 56 * k;
      const count = wrap(g, this.hook, full).length;
      let lo = full * 0.4, hi = full;
      for (let i = 0; i < 14; i++) { const mid = (lo + hi) / 2; if (wrap(g, this.hook, mid).length > count) lo = mid; else hi = mid; }
      const lines = wrap(g, this.hook, hi).slice(0, 3);
      const lh = 76 * k, padX = 28 * k, padY = 18 * k;
      let y = (shot.format === '16:9' ? 120 : 190) * k;
      for (const l of lines) {
        const w = g.measureText(l).width + padX * 2;
        g.fillStyle = '#ffffff';
        roundRect(g, MID - w / 2, y - 56 * k - padY / 2, w, lh, 14 * k); g.fill();
        g.fillStyle = '#0b0d12';
        g.textAlign = 'center';
        g.fillText(l, MID, y);
        y += lh;
      }
    }
    if (this.caption) {
      const a = Math.min(1, (this.clock - this.caption.since) / 0.25);
      g.save();
      g.globalAlpha = a;
      g.font = `800 ${62 * k}px ${FONT}`;
      g.textAlign = 'center';
      g.lineJoin = 'round';
      let y = (shot.format === '16:9' ? H - 140 * k : 430 * k);
      for (const l of wrap(g, this.caption.text, SAFE_R - SAFE_L)) {
        g.lineWidth = 14 * k; g.strokeStyle = '#000'; g.strokeText(l, MID, y);
        g.fillStyle = this.caption.color ?? '#fff'; g.fillText(l, MID, y);
        y += 74 * k;
      }
      g.restore();
    }
    if (endK > 0) {
      const a = Math.min(1, endK * 10);
      g.fillStyle = `rgba(4,6,11,${(0.86 * a).toFixed(3)})`;
      g.fillRect(0, 0, W, H);
      g.globalAlpha = a;
      g.textAlign = 'center';
      const cy = H / 2;
      g.fillStyle = '#ffd07a'; g.font = `900 ${120 * k}px ${FONT}`; g.fillText('ORBITAL', MID, cy - 200 * k);
      g.fillStyle = '#fff'; g.font = `800 ${64 * k}px ${FONT}`; g.fillText('Play free in your browser', MID, cy - 90 * k);
      g.font = `800 ${60 * k}px ${FONT}`;
      const url = 'orbital-empire.com';
      const w = g.measureText(url).width + 60 * k;
      g.fillStyle = '#fff'; roundRect(g, MID - w / 2, cy - 35 * k, w, 92 * k, 16 * k); g.fill();
      g.fillStyle = '#0b0d12'; g.fillText(url, MID, cy + 33 * k);
      g.fillStyle = '#9fc2dc'; g.font = `600 ${38 * k}px ${FONT}`;
      let ey = cy + 140 * k;
      for (const l of wrap(g, 'The real solar system. Up to ten players. Ticks that keep running while you are away.', SAFE_R - SAFE_L - 20 * k)) { g.fillText(l, MID, ey); ey += 50 * k; }
      g.globalAlpha = 1;
    }
  }

  /** Validate a shot without running it. Returns the problems found. */
  static lint(shot: unknown): string[] {
    const out: string[] = [];
    const s = shot as Shot;
    if (!s || typeof s !== 'object') return ['shot must be an object'];
    if (!(Number(s.seconds) > 0 && Number(s.seconds) <= 180)) out.push('seconds must be 1..180');
    if (s.format && !(s.format in FORMATS)) out.push(`format must be ${Object.keys(FORMATS).join(', ')}`);
    if (!Array.isArray(s.steps)) out.push('steps must be an array');
    else s.steps.forEach((st, i) => {
      if (!(Number(st.at) >= 0)) out.push(`steps[${i}].at must be >= 0 seconds`);
      const needsTarget = st.do === 'focus' || st.do === 'pan' || st.do === 'follow';
      if (needsTarget && typeof (st as { target?: unknown }).target !== 'string') out.push(`steps[${i}] needs a target`);
      if (!['focus', 'pan', 'zoom', 'follow', 'tick', 'speed', 'caption', 'hook', 'ui'].includes(st.do)) out.push(`steps[${i}].do '${st.do}' is not a verb`);
    });
    return out;
  }
}

// ---------- helpers ----------

const realSetTimeout = window.setTimeout.bind(window);
const realSleep = (ms: number) => new Promise<void>(r => realSetTimeout(r, ms));

function wrap(g: CanvasRenderingContext2D, text: string, maxW: number): string[] {
  const lines: string[] = []; let line = '';
  for (const w of String(text).split(/\s+/)) {
    const next = line ? `${line} ${w}` : w;
    if (g.measureText(next).width > maxW && line) { lines.push(line); line = w; } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}
function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  g.beginPath();
  g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
}

/**
 * A clock only the caller advances. Date.now, performance.now and
 * requestAnimationFrame are swapped for the recording; `advance(ms)` moves
 * time and runs the frame callbacks that were waiting, which is how the
 * map draws exactly one frame per call. `real(fn)` runs fn against the
 * wall clock (server waits, the recorder's own hold timers).
 */
function installVirtualClock() {
  const D = Date.now, P = performance.now.bind(performance);
  const RAF = window.requestAnimationFrame, CAF = window.cancelAnimationFrame;
  const baseD = D(), baseP = P();
  let v = 0;
  let queue: Array<{ id: number; cb: FrameRequestCallback }> = [];
  let nextId = 1;
  let inReal = 0;
  const vNow = () => baseD + v;
  Date.now = () => (inReal ? D() : vNow());
  performance.now = () => (inReal ? P() : baseP + v);
  window.requestAnimationFrame = (cb: FrameRequestCallback) => { const id = nextId++; queue.push({ id, cb }); return id; };
  window.cancelAnimationFrame = (id: number) => { queue = queue.filter(q => q.id !== id); };
  return {
    /** Move time by `ms`. With `runCallbacks` the waiting frame callbacks
     *  run (the map's loop draws); without it they stay queued for the
     *  next call, or for uninstall. Returns how many ran. */
    advance(ms: number, runCallbacks = true): number {
      v += ms;
      if (!runCallbacks) return 0;
      const cbs = queue; queue = [];
      for (const q of cbs) { try { q.cb(baseP + v); } catch (e) { console.error(e); } }
      return cbs.length;
    },
    async real<T>(fn: () => Promise<T> | T): Promise<T> {
      inReal++;
      try { return await fn(); } finally { inReal--; }
    },
    realNow: () => P(),
    /** The film's clock, even inside real(): what a frame is drawn at. */
    virtualNow: () => vNow(),
    uninstall() {
      Date.now = D; performance.now = P;
      window.requestAnimationFrame = RAF; window.cancelAnimationFrame = CAF;
      // Hand the map's loop back to the real clock.
      const cbs = queue; queue = [];
      for (const q of cbs) RAF(q.cb);
    },
  };
}
