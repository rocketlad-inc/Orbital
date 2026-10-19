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
import { smoothedTick } from '../../render/tickPhase';
import { setStudioFullVisuals } from '../../render/lightweightMode';
import { apiFetch } from '../api';

export type Target = string; // 'earth' | 'ship:<id>' | 'fleet:<id>'

export type ShotStep =
  | { at: number; do: 'focus'; target: Target; px?: number; scale?: number }
  | { at: number; do: 'pan'; target: Target; ms?: number; px?: number; scale?: number }
  | { at: number; do: 'zoom'; px?: number; scale?: number; factor?: number; ms?: number; target?: Target }
  | { at: number; do: 'follow'; target: Target }
  | { at: number; do: 'tick'; n?: number }
  | { at: number; do: 'speed'; ms: number }
  | { at: number; do: 'caption'; text: string; color?: string }
  | { at: number; do: 'hook'; text: string }
  | { at: number; do: 'ui'; show: boolean };

export interface Shot {
  /** Video shape. 9:16 for TikTok/Shorts/Reels, 16:9 for YouTube and X. */
  format?: '9:16' | '16:9' | '1:1';
  fps?: number;
  /** Length of the clip, seconds, before the end card. */
  seconds: number;
  /** Shown from frame one in the white box, like TikTok's own text. */
  hook?: string;
  /** Page milliseconds one tick glides over; 2500 reads well for battles. */
  speed?: number;
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

  /** Where a target is on the map this frame, in world units. */
  position(target: Target): { x: number; y: number } | null {
    const s = this.host.state();
    const tick = this.tick();
    if (target.startsWith('ship:')) {
      const id = target.slice(5);
      const ship = s.ships.find(x => x.id === id);
      if (!ship) return null;
      return this.shipPos(ship, tick);
    }
    if (target.startsWith('fleet:')) {
      const id = target.slice(6);
      const members = s.ships.filter(x => x.fleetId === id);
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
      const s = this.host.state();
      const ship = target.startsWith('ship:')
        ? s.ships.find(x => x.id === target.slice(5))
        : s.ships.find(x => x.fleetId === target.slice(6));
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
    this.tween = { fromX: this.cam.x, fromY: this.cam.y, fromScale: this.cam.scale, toScale, t0: this.clock, ms: o.ms ?? 2000, target };
    this.hold = target;
  }

  /** Change scale over `ms`, holding whatever the camera holds. */
  zoom(o: { px?: number; scale?: number; factor?: number; ms?: number; target?: Target }): void {
    const target = o.target ?? this.hold;
    const toScale = o.scale ?? (o.px ? this.scaleFor(target ?? undefined, o.px) : this.cam.scale * (o.factor ?? 1));
    this.tween = { fromX: this.cam.x, fromY: this.cam.y, fromScale: this.cam.scale, toScale, t0: this.clock, ms: o.ms ?? 1500, target: target ?? null };
  }

  /** Keep the centre on a moving target from now on. */
  follow(target: Target): void { this.hold = target; this.tween = null; }

  /** Hide or show the game's interface around the map. */
  ui(show: boolean): void {
    document.body.classList.toggle('studio-cinema', !show);
    if (!show) this.host.deselect();
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
    const res = await apiFetch<{ current_tick: number }>(`/api/admin/studio/games/${this.host.gameId}/tick`, {
      method: 'POST', body: JSON.stringify({ n }),
    });
    if (!res.ok) throw new Error(`tick: ${res.error?.message ?? res.status}`);
    const want = res.data.current_tick ?? before + n;
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

  /** Fire every step whose time has come. Ticks are awaited: the clock
   *  does not move while the server works. */
  private async fire(steps: ShotStep[], fired: Set<ShotStep>): Promise<void> {
    for (const st of steps) {
      if (fired.has(st) || st.at > this.clock + 1e-9) continue;
      fired.add(st);
      switch (st.do) {
        case 'focus': this.focus(st.target, st); break;
        case 'pan': this.pan(st.target, st); break;
        case 'zoom': this.zoom(st); break;
        case 'follow': this.follow(st.target); break;
        case 'speed': this.speed(st.ms); break;
        case 'ui': this.ui(st.show); break;
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
    this.speed(shot.speed ?? 2500);
  }
  private end(): void {
    this.running = false;
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
    uninstall() {
      Date.now = D; performance.now = P;
      window.requestAnimationFrame = RAF; window.cancelAnimationFrame = CAF;
      // Hand the map's loop back to the real clock.
      const cbs = queue; queue = [];
      for (const q of cbs) RAF(q.cb);
    },
  };
}
