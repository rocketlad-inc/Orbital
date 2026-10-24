// ============================================================
// recapVideo — the battle recap as a 9:16 video, for TikTok, YouTube
// Shorts and Instagram Reels.
//
// Lorne, 2026-10-15: "make a vertical video recorder and make me some Tik
// Tok content". The recap renders any moment on demand (its renderer takes
// a playback position and a clock), so this composes each frame into a
// 1080x1920 portrait canvas: a hook line up top, the battle itself scaled
// up through the middle, the sides' live standings under it, and an end
// card with where to play. The browser's own MediaRecorder writes it
// (MP4 where Chrome offers it, WebM otherwise; TikTok takes both).
//
// MediaRecorder stamps frames by wall clock, so recording takes at least
// REAL TIME: a 25-second clip takes 25 seconds plus however long the
// frames take to draw. The recorder is paused while each frame is drawn,
// so a slow machine records a slower RUN, never a slower CLIP.
//
// TikTok covers the top tabs, the right-hand buttons and the bottom
// caption with its own UI; every word here stays out of those zones
// (SAFE_* below), and the scene is what sits under the buttons.
// ============================================================

export const VIDEO_W = 1080;
export const VIDEO_H = 1920;
const FPS = 30;
const FRAME_MS = 1000 / FPS;
/** The end card, after the action. */
const END_MS = 3200;
/** Text never goes left of this or right of SAFE_R (TikTok's buttons). */
const SAFE_L = 64;
const SAFE_R = 900;

/** How the sides stand at a moment, for the overlay. */
export interface RecapFrameState {
  tick: number;
  standings: Array<{ name: string; color: string; alive: number; committed: number; lost: number }>;
}
/** The recap's renderer, as the video uses it: no HUD of its own (the
 *  portrait frame draws its own), and the moment's standings handed back. */
export type RecapVideoRender = (
  g: CanvasRenderingContext2D, pos: number, nowMs: number,
  opts?: { hud?: boolean; onState?: (s: RecapFrameState) => void },
) => void;

export interface VideoText {
  /** The hook, big, top of frame: what a scrolling thumb stops for. */
  hook: string;
  /** One quieter line under it. */
  sub: string;
  /** End card. */
  endTitle: string;
  endUrl: string;
  endLine: string;
}

export interface RecordVideoOptions {
  render: RecapVideoRender;
  srcW: number;
  srcH: number;
  /** Where the world sits across the source canvas, px: the crop centres on it. */
  focusX: number;
  from: number;
  to: number;
  tickMs: number;
  text: VideoText;
  onProgress?: (k: number) => void;
  cancelled?: () => boolean;
}

/** The scene's scale from the recap's own canvas, and where it sits. */
const SCENE_SCALE = 1.95;
const SCENE_Y = 470;

/** The video codecs this browser can record, best first. */
export function pickMime(): string | null {
  if (typeof MediaRecorder === 'undefined') return null;
  for (const m of ['video/mp4;codecs=avc1.640028', 'video/mp4;codecs=avc1', 'video/mp4',
    'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']) {
    if (MediaRecorder.isTypeSupported(m)) return m;
  }
  return null;
}
export const canRecordVideo = () => pickMime() != null
  && typeof HTMLCanvasElement !== 'undefined' && 'captureStream' in HTMLCanvasElement.prototype;

/** Words wrapped to a width, at the current font. */
function wrap(g: CanvasRenderingContext2D, text: string, maxW: number): string[] {
  const out: string[] = [];
  let line = '';
  for (const w of text.split(/\s+/)) {
    const next = line ? `${line} ${w}` : w;
    if (g.measureText(next).width > maxW && line) { out.push(line); line = w; } else line = next;
  }
  if (line) out.push(line);
  return out;
}

/** A starfield for the frame around the scene, fixed per video. */
function makeStars(seed: number) {
  let a = seed >>> 0;
  const rnd = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return Array.from({ length: 220 }, () => ({
    x: rnd() * VIDEO_W, y: rnd() * VIDEO_H, r: 0.6 + rnd() * 1.6, a: 0.15 + rnd() * 0.5, ph: rnd() * 6.28,
  }));
}

/**
 * Which stretch of a battle makes the clip: the whole fight when it is
 * short, otherwise the `beats`-long window with the most deaths in it
 * (ties to the later one, which ends nearer the result).
 */
export function highlightSpan(deathsPerBeat: readonly number[], beats = 10): { from: number; to: number } {
  const n = deathsPerBeat.length;
  if (n <= beats + 2) return { from: 0, to: Math.max(0.98, n - 1 + 0.98) };
  let best = 0, bestScore = -1;
  for (let s = 0; s + beats <= n; s++) {
    let score = 0;
    for (let i = s; i < s + beats; i++) score += deathsPerBeat[i];
    if (score >= bestScore) { bestScore = score; best = s; }
  }
  return { from: best, to: best + beats - 1 + 0.98 };
}

export async function recordVerticalVideo(o: RecordVideoOptions): Promise<{ blob: Blob; ext: string } | null> {
  const mime = pickMime();
  if (!mime) return null;
  const out = document.createElement('canvas');
  out.width = VIDEO_W; out.height = VIDEO_H;
  const g = out.getContext('2d');
  const src = document.createElement('canvas');
  src.width = o.srcW; src.height = o.srcH;
  const sg = src.getContext('2d');
  if (!g || !sg) return null;

  const stream = (out as HTMLCanvasElement & { captureStream(fps?: number): MediaStream }).captureStream(0);
  const track = stream.getVideoTracks()[0] as MediaStreamTrack & { requestFrame?: () => void };
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 10_000_000 });
  const chunks: Blob[] = [];
  rec.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunks.push(e.data); };
  const stopped = new Promise<void>(r => { rec.onstop = () => r(); });

  const actionMs = (o.to - o.from) * o.tickMs;
  const total = Math.ceil((actionMs + END_MS) / FRAME_MS);
  const stars = makeStars(Math.round(o.from * 7919 + o.to * 104729));
  const t0Clock = 100000;
  let state: RecapFrameState | null = null;

  const sceneH = o.srcH * SCENE_SCALE;
  const cropW = VIDEO_W / SCENE_SCALE;
  const cropX = Math.max(0, Math.min(o.srcW - cropW, o.focusX - cropW / 2));

  const drawFrame = (k: number) => {
    const ms = k * FRAME_MS;
    const inAction = ms < actionMs;
    const pos = Math.min(o.to, o.from + ms / o.tickMs);
    const nowMs = t0Clock + ms;

    // Ground and sky.
    g.fillStyle = '#04060b';
    g.fillRect(0, 0, VIDEO_W, VIDEO_H);
    for (const s of stars) {
      g.fillStyle = `rgba(203, 225, 245, ${(s.a * (0.7 + 0.3 * Math.sin(nowMs / 900 + s.ph))).toFixed(3)})`;
      g.beginPath(); g.arc(s.x, s.y, s.r, 0, Math.PI * 2); g.fill();
    }

    // The battle, scaled up through the middle; it holds its last
    // moment under the end card.
    o.render(sg, pos, inAction ? nowMs : t0Clock + actionMs, { hud: false, onState: (st) => { state = st; } });
    g.save();
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    g.drawImage(src, cropX, 0, cropW, o.srcH, 0, SCENE_Y, VIDEO_W, sceneH);
    g.restore();
    // Feather the scene's top and bottom into the sky.
    for (const [y0, y1] of [[SCENE_Y, SCENE_Y + 90], [SCENE_Y + sceneH, SCENE_Y + sceneH - 90]] as const) {
      const gr = g.createLinearGradient(0, y0, 0, y1);
      gr.addColorStop(0, 'rgba(4, 6, 11, 1)');
      gr.addColorStop(1, 'rgba(4, 6, 11, 0)');
      g.fillStyle = gr;
      g.fillRect(0, Math.min(y0, y1), VIDEO_W, Math.abs(y1 - y0));
    }

    // The hook.
    g.textAlign = 'left';
    g.textBaseline = 'alphabetic';
    g.fillStyle = '#ffffff';
    g.font = '800 64px system-ui, sans-serif';
    let y = 205;
    for (const line of wrap(g, o.text.hook, SAFE_R - SAFE_L).slice(0, 3)) {
      g.fillText(line, SAFE_L, y);
      y += 74;
    }
    g.fillStyle = '#9fc2dc';
    g.font = '500 34px system-ui, sans-serif';
    for (const line of wrap(g, o.text.sub, SAFE_R - SAFE_L).slice(0, 2)) {
      g.fillText(line, SAFE_L, y + 4);
      y += 44;
    }

    // The sides, as they stand right now.
    const st = state as RecapFrameState | null;
    if (st) {
      let sy = SCENE_Y + sceneH + 30;
      g.fillStyle = '#6f8ba3';
      g.font = '600 30px system-ui, sans-serif';
      g.fillText(`T+${st.tick}`, SAFE_L, sy);
      sy += 52;
      for (const s of st.standings.slice(0, 4)) {
        g.fillStyle = s.color;
        g.fillRect(SAFE_L, sy - 30, 14, 36);
        g.fillStyle = s.alive === 0 ? '#7a8794' : '#e8f1f9';
        g.font = '700 40px system-ui, sans-serif';
        let name = s.name;
        while (name.length > 3 && g.measureText(name).width > 520) name = name.slice(0, -2);
        if (name !== s.name) name += '…';
        g.fillText(name, SAFE_L + 32, sy);
        g.textAlign = 'right';
        g.fillStyle = s.lost > 0 ? '#ff8a80' : '#9fc2dc';
        g.fillText(`${s.alive}/${s.committed}`, SAFE_R, sy);
        g.textAlign = 'left';
        // A bar of what is left.
        const bw = SAFE_R - SAFE_L - 32;
        g.fillStyle = 'rgba(255,255,255,0.08)';
        g.fillRect(SAFE_L + 32, sy + 14, bw, 8);
        g.fillStyle = s.color;
        g.fillRect(SAFE_L + 32, sy + 14, bw * (s.committed ? s.alive / s.committed : 0), 8);
        sy += 74;
      }
    }

    // The end card.
    if (!inAction) {
      const a = Math.min(1, (ms - actionMs) / 400);
      g.fillStyle = `rgba(4, 6, 11, ${(0.82 * a).toFixed(3)})`;
      g.fillRect(0, 0, VIDEO_W, VIDEO_H);
      g.globalAlpha = a;
      g.textAlign = 'center';
      g.fillStyle = '#ffd07a';
      g.font = '800 96px system-ui, sans-serif';
      g.fillText(o.text.endTitle, VIDEO_W / 2 - 40, 820);
      g.fillStyle = '#ffffff';
      g.font = '700 64px system-ui, sans-serif';
      g.fillText(o.text.endUrl, VIDEO_W / 2 - 40, 920);
      g.fillStyle = '#9fc2dc';
      g.font = '500 36px system-ui, sans-serif';
      let ey = 1010;
      for (const line of wrap(g, o.text.endLine, SAFE_R - SAFE_L - 40)) {
        g.fillText(line, VIDEO_W / 2 - 40, ey);
        ey += 48;
      }
      g.globalAlpha = 1;
      g.textAlign = 'left';
    }
  };

  // THE RECORDER IS PAUSED WHILE A FRAME IS DRAWN. MediaRecorder stamps
  // frames by the wall clock, so a frame that took 90ms to draw on a slow
  // machine came out 90ms long: the first clip, recorded in headless
  // Chrome, ran 70 seconds instead of 25, in slow motion. Paused time is
  // not recorded, so each frame now gets exactly its 1/30s on the
  // timeline however long it took to draw.
  const pause = () => { if (rec.state === 'recording') rec.pause(); };
  const resume = () => { if (rec.state === 'paused') rec.resume(); };
  // A timer asked for 33ms runs a few ms over, and that added up to an
  // eighth too long (28.4s for a 25.2s clip). So the time actually
  // RECORDED is tracked, and each frame is held for whatever brings the
  // total back to where frame k should end.
  let recorded = 0;
  rec.start(1000);
  pause();
  for (let k = 0; k < total; k++) {
    if (o.cancelled?.()) { resume(); rec.stop(); await stopped; return null; }
    drawFrame(k);
    resume();
    const on = performance.now();
    track.requestFrame?.();
    const hold = Math.max(4, (k + 1) * FRAME_MS - recorded);
    await new Promise<void>(r => setTimeout(r, hold));
    pause();
    recorded += performance.now() - on;
    o.onProgress?.((k + 1) / total);
  }
  resume();
  rec.stop();
  await stopped;
  track.stop();
  const type = mime.split(';')[0];
  return { blob: new Blob(chunks, { type }), ext: type === 'video/mp4' ? 'mp4' : 'webm' };
}
