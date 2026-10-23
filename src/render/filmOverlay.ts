// ============================================================
// filmOverlay — the match film's graphics: everything drawn OVER the
// map. The lower third that names each moment, the clock, the ticker
// of smaller headlines, the battle tally, the standings, and the title
// and result cards that bookend the film.
//
// Broadcast grammar, in the game's own faces (Audiowide for display,
// Chakra Petch for words, Chivo Mono for numbers): the film is meant to
// be shared, and a clip that reads cleanly with the sound off on a
// phone is the one that gets watched. Everything scales off the frame
// height, so a 1080p export and a 720p player look the same.
//
// Pure drawing: no state, no clock. matchMap.ts decides what is on
// screen and how far each element has animated in (0..1).
// ============================================================

import { getEmblemImage } from './emblemCache';

export const FONT_DISPLAY = '"Audiowide", "Chakra Petch", sans-serif';
export const FONT_BODY = '"Chakra Petch", system-ui, sans-serif';
export const FONT_MONO = '"Chivo Mono", ui-monospace, monospace';

const INK = '#eef4fb';
const DIM = 'rgba(200,216,232,0.80)';
const PLATE = 'rgba(4,8,14,0.78)';

export interface FilmFaction {
  id: string;
  name: string;
  color: string;
  emblem?: string | null;
}

/** Frame metrics: one unit is a pixel at 1080p. */
export function unitOf(H: number): number {
  return Math.max(0.42, H / 1080);
}

const ease = (x: number) => { const c = Math.max(0, Math.min(1, x)); return c * c * (3 - 2 * c); };

/** An empire's colour lifted until it reads as text on a dark ground. */
export function liftColor(hex: string | null | undefined, floor = 170): string {
  const h = (hex || '#8a9fb3').replace('#', '');
  const n = h.length === 3
    ? h.split('').map(c => parseInt(c + c, 16))
    : [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16));
  if (n.some(v => Number.isNaN(v))) return 'rgb(206,222,238)';
  const lum = 0.2126 * n[0] + 0.7152 * n[1] + 0.0722 * n[2];
  if (lum >= floor) return `rgb(${n[0]},${n[1]},${n[2]})`;
  const k = Math.min(2.6, floor / Math.max(1, lum));
  const lift = (v: number) => Math.round(Math.min(255, 40 + v * k));
  return `rgb(${lift(n[0])},${lift(n[1])},${lift(n[2])})`;
}

export function rgba(hex: string | null | undefined, a: number): string {
  const h = (hex || '#8a9fb3').replace('#', '');
  const n = h.length === 3
    ? h.split('').map(c => parseInt(c + c, 16))
    : [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16));
  if (n.some(v => Number.isNaN(v))) return `rgba(138,159,179,${a})`;
  return `rgba(${n[0]},${n[1]},${n[2]},${Math.max(0, Math.min(1, a))})`;
}

function spacing(ctx: CanvasRenderingContext2D, px: number) {
  (ctx as unknown as { letterSpacing: string }).letterSpacing = `${px}px`;
}

/** Shrink a font until `text` fits `maxW`; returns the size used. */
function fit(ctx: CanvasRenderingContext2D, text: string, family: string, weight: string,
  size: number, min: number, maxW: number): number {
  let s = size;
  for (;;) {
    ctx.font = `${weight} ${s}px ${family}`;
    if (ctx.measureText(text).width <= maxW || s <= min) return s;
    s = Math.max(min, Math.floor(s * 0.92));
  }
}

/** Break `text` into at most `max` lines of `maxW`, at words; the last
 *  line is ellipsized only if it still does not fit. */
function wrapLines(ctx: CanvasRenderingContext2D, text: string, maxW: number, max: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = '';
  for (let i = 0; i < words.length; i++) {
    const next = cur ? `${cur} ${words[i]}` : words[i];
    if (ctx.measureText(next).width <= maxW || !cur) { cur = next; continue; }
    lines.push(cur);
    cur = words[i];
    if (lines.length === max - 1) { cur = words.slice(i).join(' '); break; }
  }
  if (cur) lines.push(cur);
  if (lines.length) lines[lines.length - 1] = ellipsize(ctx, lines[lines.length - 1], maxW);
  return lines.slice(0, max);
}

function ellipsize(ctx: CanvasRenderingContext2D, text: string, maxW: number): string {
  if (ctx.measureText(text).width <= maxW) return text;
  let lo = 0, hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ctx.measureText(text.slice(0, mid) + '…').width <= maxW) lo = mid; else hi = mid - 1;
  }
  // Cut at a word, never through one ("went down with the ship at Ma…").
  const cut = text.slice(0, lo);
  const sp = cut.lastIndexOf(' ');
  const at = sp > lo * 0.5 ? cut.slice(0, sp) : cut;
  return at.replace(/[\s,;:·—-]+$/u, '') + '…';
}

/**
 * An empire's name, short enough for a scorebug or a name tag: drop a
 * leading "The" / "Empire of" / "Republic of", then cut at a word.
 * "THE MINISTRY OF SILLY..." in every battle read as a broken graphic.
 */
export function shortName(name: string, max = 16): string {
  let n = name.trim().replace(/^(the|empire of|republic of|kingdom of|federation of)\s+/i, '');
  if (n.length <= max) return n;
  const words = n.split(/\s+/);
  let out = '';
  for (const w of words) {
    if ((out ? out.length + 1 : 0) + w.length > max) break;
    out = out ? `${out} ${w}` : w;
  }
  n = out || words[0].slice(0, max);
  return n.replace(/\s+(of|the|and|da|de|do|dos|das)$/i, '');
}

/** The faction's emblem in a ring of its colour; a plain disc while the
 *  emblem raster loads. */
export function drawEmblem(ctx: CanvasRenderingContext2D, f: FilmFaction | undefined,
  cx: number, cy: number, r: number, alpha = 1) {
  if (!f) return;
  ctx.save();
  ctx.globalAlpha *= alpha;
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(4,8,14,0.92)'; ctx.fill();
  ctx.lineWidth = Math.max(1.5, r * 0.14);
  ctx.strokeStyle = f.color; ctx.stroke();
  const img = getEmblemImage(f.emblem ?? null, liftColor(f.color, 150));
  if (img) {
    const s = r * 1.3;
    ctx.drawImage(img, cx - s / 2, cy - s / 2, s, s);
  } else {
    ctx.beginPath(); ctx.arc(cx, cy, r * 0.42, 0, Math.PI * 2);
    ctx.fillStyle = f.color; ctx.fill();
  }
  ctx.restore();
}

export interface LowerThird {
  kicker: string;
  title: string;
  sub: string;
  color: string | null;
}

/**
 * The caption: a kicker in the empire's colour, the moment in display
 * type, and the event-log line under it. `inK` runs 0..1 as it arrives,
 * `outK` 0..1 as it leaves.
 */
export function drawLowerThird(ctx: CanvasRenderingContext2D, W: number, H: number,
  c: LowerThird, inK: number, outK: number): number {
  if (!c.title && !c.kicker) return 0;
  const u = unitOf(H);
  const a = ease(inK) * (1 - ease(outK));
  if (a <= 0.01) return 0;
  // Inside title-safe (5% of the width), with the accent bar outside it.
  const x0 = Math.max(96 * u, W * 0.05 + 22 * u);
  const maxW = Math.min(W * 0.54, W - 2 * x0);
  const accent = c.color ? liftColor(c.color) : '#9fc4e8';

  ctx.save();
  // ONE title size, film-wide: a long title wraps to a second line rather
  // than shrinking (cap height varied by 40% from beat to beat).
  const titleSize = Math.round(64 * u);
  ctx.font = `400 ${titleSize}px ${FONT_DISPLAY}`;
  const titleLines = wrapLines(ctx, c.title, maxW, 2);
  // Read on a phone: at 400 px wide, 34 units was six pixels tall.
  const subSize = Math.round(40 * u);
  ctx.font = `500 ${subSize}px ${FONT_BODY}`;
  // The sub is the fact that explains the moment: two lines before it is
  // ever cut ("62 ships…" lost the losses; "PASSED…" lost the vote).
  const subLines = c.sub ? wrapLines(ctx, c.sub, maxW, 2) : [];
  const sub = subLines.join(' ');
  const kickSize = Math.round(28 * u);
  const gap = 10 * u;
  const subH = subLines.length ? gap + subSize * (1 + (subLines.length - 1) * 1.15) : 0;
  const blockH = kickSize + gap + titleSize * 1.05 * titleLines.length + subH;
  const yBottom = H - 70 * u;
  const yTop = yBottom - blockH;

  // Measure for the plate.
  ctx.font = `400 ${titleSize}px ${FONT_DISPLAY}`;
  let wide = Math.max(0, ...titleLines.map(l => ctx.measureText(l).width));
  ctx.font = `500 ${subSize}px ${FONT_BODY}`;
  for (const l of subLines) wide = Math.max(wide, ctx.measureText(l).width);

  // A soft plate that fades to the right, so the map still reads past it.
  const plateW = wide + 140 * u;
  const g = ctx.createLinearGradient(0, 0, plateW, 0);
  g.addColorStop(0, `rgba(3,6,12,${0.86 * a})`);
  g.addColorStop(0.7, `rgba(3,6,12,${0.62 * a})`);
  g.addColorStop(1, 'rgba(3,6,12,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, yTop - 26 * u, plateW, blockH + 52 * u);

  // The accent bar grows down first; the words slide in behind it.
  const barH = blockH * ease(inK * 1.6);
  ctx.globalAlpha = 1 - ease(outK);
  ctx.fillStyle = accent;
  ctx.fillRect(x0 - 22 * u, yTop, 5 * u, barH);

  const slide = (1 - ease(Math.max(0, inK * 1.4 - 0.15))) * 26 * u;
  ctx.globalAlpha = a;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.shadowColor = 'rgba(0,0,0,0.75)';
  ctx.shadowBlur = 10 * u;
  ctx.shadowOffsetY = 2 * u;

  let y = yTop;
  if (c.kicker) {
    ctx.font = `700 ${kickSize}px ${FONT_BODY}`;
    spacing(ctx, 4 * u);
    ctx.fillStyle = accent;
    ctx.fillText(c.kicker.toUpperCase(), x0 - slide * 0.5, y);
    spacing(ctx, 0);
  }
  y += kickSize + gap;
  ctx.font = `400 ${titleSize}px ${FONT_DISPLAY}`;
  ctx.fillStyle = INK;
  titleLines.forEach((l, i) => ctx.fillText(l, x0 - slide, y + i * titleSize * 1.05));
  y += titleSize * 1.05 * titleLines.length + gap;
  if (sub) {
    ctx.font = `500 ${subSize}px ${FONT_BODY}`;
    ctx.fillStyle = DIM;
    ctx.globalAlpha = a * ease(Math.max(0, inK * 1.5 - 0.35));
    subLines.forEach((l, i) => ctx.fillText(l, x0 - slide * 1.3, y + i * subSize * 1.15));
  }
  ctx.restore();
  return x0 + wide;
}

/** Top-right: the match clock, and the playback speed when it is fast. */
export function drawClock(ctx: CanvasRenderingContext2D, W: number, H: number,
  tick: number, speedLabel: string | null, alpha = 1, dayLabel = 'T+') {
  const u = unitOf(H);
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'top';
  const x = W * 0.945, y = H * 0.05;
  ctx.shadowColor = 'rgba(0,0,0,0.7)'; ctx.shadowBlur = 8 * u;
  ctx.font = `600 ${Math.round(34 * u)}px ${FONT_MONO}`;
  ctx.fillStyle = INK;
  ctx.fillText(`${dayLabel}${Math.max(0, Math.floor(tick))}`, x, y);
  if (speedLabel) {
    ctx.shadowBlur = 0;
    ctx.font = `700 ${Math.round(20 * u)}px ${FONT_BODY}`;
    spacing(ctx, 2 * u);
    const w = ctx.measureText(speedLabel).width;
    const py = y + 48 * u, ph = 30 * u;
    ctx.fillStyle = 'rgba(255,196,92,0.16)';
    ctx.strokeStyle = 'rgba(255,196,92,0.7)';
    ctx.lineWidth = 1.2 * u;
    ctx.beginPath();
    ctx.roundRect(x - w - 20 * u, py, w + 20 * u, ph, 4 * u);
    ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#ffd38a';
    ctx.textBaseline = 'middle';
    ctx.fillText(speedLabel, x - 8 * u, py + ph / 2 + 1);
    spacing(ctx, 0);
  }
  ctx.restore();
}

export interface TickerItem {
  text: string;
  faction?: FilmFaction;
  /** 0..1 how far into its life on screen. */
  life: number;
}

/** Bottom-right: the smaller headlines, newest at the bottom. */
export function drawTicker(ctx: CanvasRenderingContext2D, W: number, H: number,
  items: TickerItem[], avoidLeft: number) {
  if (!items.length) return;
  const u = unitOf(H);
  const size = Math.round(32 * u);
  const lineH = 56 * u;
  const right = W - 56 * u;
  const maxW = Math.max(200 * u, Math.min(W * 0.36, right - avoidLeft - 40 * u));
  ctx.save();
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  let y = H - 84 * u;
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    const a = Math.min(ease(it.life / 0.12), 1 - ease((it.life - 0.82) / 0.18));
    // Every live item keeps its whole slot while it fades: a half-height
    // slot drew the next line over the one leaving.
    if (a <= 0.01) { y -= lineH; continue; }
    ctx.font = `500 ${size}px ${FONT_BODY}`;
    // Two lines before a cut: the cut always landed on the part that
    // mattered ("destroyed by…", "reached…").
    const lines = wrapLines(ctx, it.text, maxW - 44 * u, 2);
    const text = lines[0] ?? '';
    const w = Math.max(...lines.map(l => ctx.measureText(l).width)) + 58 * u;
    const extra = (lines.length - 1) * size * 1.1;
    y -= extra;
    const x = right - w + (1 - ease(it.life / 0.12)) * 30 * u;
    ctx.globalAlpha = a;
    ctx.fillStyle = PLATE;
    ctx.beginPath(); ctx.roundRect(x, y - lineH / 2 + 3 * u, w, lineH - 6 * u + extra, 5 * u); ctx.fill();
    if (it.faction) drawEmblem(ctx, it.faction, x + 22 * u, y, 14 * u);
    ctx.fillStyle = INK;
    for (let i = 0; i < lines.length; i++) ctx.fillText(lines[i], x + 44 * u, y + 1 + i * size * 1.1);
    void text;
    y -= lineH;
  }
  ctx.restore();
}

export interface TallySide {
  faction: FilmFaction;
  ships: number;
  lost: number;
}

/** Top-centre during a battle: who is fighting, how many are left. */
export function drawBattleTally(ctx: CanvasRenderingContext2D, W: number, H: number,
  sides: TallySide[], alpha: number, vsLabel = 'VS', more = 0, moreLabel = '') {
  if (sides.length < 1 || alpha <= 0.01) return;
  const u = unitOf(H);
  ctx.save();
  ctx.globalAlpha = alpha;
  const cy = 66 * u;
  const nameSize = Math.round(30 * u), numSize = Math.round(56 * u);
  // FIXED SLOTS. Every element sits at a set distance from the centre and
  // the count is set in a monospaced face inside a three-digit box, so as
  // ships die only the digits change: a proportional count reflowed the
  // whole bug every time it ticked.
  const EMB = 84 * u, NUM = 142 * u, NAME = 250 * u, NAME_W = 330 * u;
  const band = NAME + NAME_W + 40 * u;
  const g = ctx.createLinearGradient(W / 2 - band, 0, W / 2 + band, 0);
  g.addColorStop(0, 'rgba(3,6,12,0)');
  g.addColorStop(0.18, 'rgba(3,6,12,0.74)');
  g.addColorStop(0.82, 'rgba(3,6,12,0.74)');
  g.addColorStop(1, 'rgba(3,6,12,0)');
  ctx.fillStyle = g;
  ctx.fillRect(W / 2 - band, cy - 38 * u, band * 2, 76 * u);
  const draw = (sd: TallySide, dir: -1 | 1) => {
    ctx.textBaseline = 'middle';
    drawEmblem(ctx, sd.faction, W / 2 + dir * EMB, cy, 26 * u);
    ctx.shadowColor = 'rgba(0,0,0,0.8)'; ctx.shadowBlur = 8 * u;
    ctx.font = `600 ${numSize}px ${FONT_MONO}`;
    ctx.fillStyle = INK;
    ctx.textAlign = 'center';
    ctx.fillText(String(Math.min(999, sd.ships)), W / 2 + dir * NUM + dir * 26 * u, cy + 2 * u);
    ctx.textAlign = dir < 0 ? 'right' : 'left';
    ctx.font = `700 ${nameSize}px ${FONT_BODY}`;
    spacing(ctx, 1.5 * u);
    ctx.fillStyle = liftColor(sd.faction.color);
    ctx.fillText(ellipsize(ctx, shortName(sd.faction.name).toUpperCase(), NAME_W), W / 2 + dir * NAME, cy - 12 * u);
    spacing(ctx, 0);
    ctx.font = `600 ${Math.round(26 * u)}px ${FONT_MONO}`;
    ctx.fillStyle = sd.lost > 0 ? '#ff9d7a' : 'rgba(200,216,232,0.45)';
    if (sd.lost > 0) ctx.fillText(`−${sd.lost}`, W / 2 + dir * NAME, cy + 16 * u);
    ctx.shadowBlur = 0;
  };
  draw(sides[0], -1);
  if (sides[1]) draw(sides[1], 1);
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.font = `700 ${Math.round(19 * u)}px ${FONT_BODY}`;
  spacing(ctx, 3 * u);
  ctx.fillStyle = 'rgba(255,190,120,0.95)';
  ctx.fillText(vsLabel, W / 2 + 1.5 * u, cy);
  spacing(ctx, 0);
  // Every other empire in the fight, as one chip under the VS.
  if (more > 0) {
    ctx.font = `700 ${Math.round(16 * u)}px ${FONT_BODY}`;
    const label = moreLabel || `+${more}`;
    const w = ctx.measureText(label).width + 18 * u;
    ctx.fillStyle = 'rgba(255,190,120,0.16)';
    ctx.strokeStyle = 'rgba(255,190,120,0.6)';
    ctx.lineWidth = 1.2 * u;
    ctx.beginPath(); ctx.roundRect(W / 2 - w / 2, cy + 20 * u, w, 22 * u, 11 * u); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#ffd38a';
    ctx.fillText(label, W / 2, cy + 31 * u + 1);
  }
  ctx.restore();
}

/** Under the scorebug at the end of a fight: who holds the field. */
export function drawBattleVerdict(ctx: CanvasRenderingContext2D, W: number, H: number,
  text: string, color: string | null, k: number) {
  const a = ease(k);
  if (a <= 0.01 || !text) return;
  const u = unitOf(H);
  ctx.save();
  ctx.globalAlpha = a;
  ctx.font = `700 ${Math.round(24 * u)}px ${FONT_BODY}`;
  spacing(ctx, 3 * u);
  const w = ctx.measureText(text).width + 44 * u, h = 44 * u;
  const y = 118 * u + (1 - a) * 10 * u;
  ctx.fillStyle = 'rgba(3,6,12,0.86)';
  ctx.strokeStyle = color ? liftColor(color) : '#9fc4e8';
  ctx.lineWidth = 2 * u;
  ctx.beginPath(); ctx.roundRect(W / 2 - w / 2, y, w, h, 6 * u); ctx.fill(); ctx.stroke();
  ctx.fillStyle = color ? liftColor(color) : INK;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(text, W / 2 + 1.5 * u, y + h / 2 + 1);
  spacing(ctx, 0);
  ctx.restore();
}

/**
 * A victory in progress (the Dyson Sphere): a labelled bar under the
 * clock, so a win that is built rather than fought is visible all along.
 */
export function drawProgressMeter(ctx: CanvasRenderingContext2D, W: number, H: number,
  label: string, pct: number, color: string | null, alpha: number, flash = 0, note = '') {
  if (alpha <= 0.01) return;
  const u = unitOf(H);
  ctx.save();
  ctx.globalAlpha = alpha;
  const w = 520 * u, h = 116 * u;
  const x = W * 0.945 - w, y = H * 0.05 + 96 * u;
  const accent = color ? liftColor(color) : '#ffd38a';
  ctx.fillStyle = 'rgba(3,6,12,0.82)';
  ctx.beginPath(); ctx.roundRect(x, y, w, h, 8 * u); ctx.fill();
  if (flash > 0.01) {
    // A milestone: the panel lights up and settles.
    ctx.save();
    ctx.globalAlpha = alpha * flash;
    ctx.shadowColor = accent; ctx.shadowBlur = 30 * u;
    ctx.strokeStyle = accent; ctx.lineWidth = 3 * u;
    ctx.beginPath(); ctx.roundRect(x, y, w, h, 8 * u); ctx.stroke();
    ctx.restore();
  }
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.font = `700 ${Math.round(26 * u)}px ${FONT_BODY}`;
  spacing(ctx, 2.5 * u);
  ctx.fillStyle = accent;
  ctx.fillText(label.toUpperCase(), x + 18 * u, y + 26 * u);
  spacing(ctx, 0);
  ctx.textAlign = 'right';
  ctx.font = `600 ${Math.round(42 * u)}px ${FONT_MONO}`;
  ctx.fillStyle = INK;
  // 100% is the WIN: it reads only when the shell is whole, never as
  // 99.6% rounds up while the ring is still open.
  ctx.fillText(`${pct >= 1 ? 100 : Math.min(99, Math.round(pct * 100))}%`, x + w - 18 * u, y + 30 * u);
  if (note) {
    ctx.textAlign = 'left';
    ctx.font = `600 ${Math.round(24 * u)}px ${FONT_BODY}`;
    ctx.fillStyle = INK;
    ctx.fillText(ellipsize(ctx, note, w - 36 * u), x + 18 * u, y + 92 * u);
  }
  const bx = x + 18 * u, bw = w - 36 * u, by = y + 56 * u, bh = 14 * u;
  ctx.fillStyle = 'rgba(255,255,255,0.12)';
  ctx.beginPath(); ctx.roundRect(bx, by, bw, bh, 5 * u); ctx.fill();
  ctx.fillStyle = accent;
  ctx.beginPath(); ctx.roundRect(bx, by, Math.max(bh, bw * Math.max(0, Math.min(1, pct))), bh, 5 * u); ctx.fill();
  ctx.restore();
}

export interface StandingRow {
  faction: FilmFaction;
  worlds: number;
  ships: number;
  /** Knocked out of the match. */
  out: boolean;
}

/** Top-left: the race, as it stands. */
export function drawStandings(ctx: CanvasRenderingContext2D, W: number, H: number,
  rows: StandingRow[], alpha: number, labels: { worlds: string; brand: string }) {
  const u = unitOf(H);
  ctx.save();
  ctx.globalAlpha = alpha;
  const x = W * 0.055;
  let y = 44 * u;
  ctx.textBaseline = 'top'; ctx.textAlign = 'left';
  ctx.shadowColor = 'rgba(0,0,0,0.7)'; ctx.shadowBlur = 6 * u;
  ctx.font = `400 ${Math.round(18 * u)}px ${FONT_DISPLAY}`;
  spacing(ctx, 2 * u);
  ctx.fillStyle = 'rgba(214,230,246,0.72)';
  ctx.fillText(labels.brand.toUpperCase(), x, y);
  spacing(ctx, 0);
  ctx.shadowBlur = 0;
  y += 40 * u;
  if (alpha > 0.01 && rows.length) {
    const rowH = 46 * u;
    const nameW = 260 * u;
    const w = nameW + 120 * u;
    ctx.fillStyle = 'rgba(3,6,12,0.62)';
    ctx.beginPath(); ctx.roundRect(x - 12 * u, y - 8 * u, w, rows.length * rowH + 16 * u, 8 * u); ctx.fill();
    const maxWorlds = Math.max(1, ...rows.map(r => r.worlds));
    rows.forEach((r, i) => {
      const cy = y + i * rowH + rowH / 2;
      ctx.globalAlpha = alpha * (r.out ? 0.45 : 1);
      // A bar for each empire's share of the worlds held.
      ctx.fillStyle = rgba(r.faction.color, 0.26);
      ctx.fillRect(x + 30 * u, cy - rowH / 2 + 5 * u, (nameW + 10 * u) * (r.worlds / maxWorlds), rowH - 10 * u);
      drawEmblem(ctx, r.faction, x + 13 * u, cy, 14 * u);
      ctx.font = `600 ${Math.round(26 * u)}px ${FONT_BODY}`;
      ctx.fillStyle = INK;
      ctx.textBaseline = 'middle';
      ctx.fillText(ellipsize(ctx, shortName(r.faction.name, 18), nameW - 14 * u), x + 38 * u, cy + 1);
      ctx.font = `600 ${Math.round(22 * u)}px ${FONT_MONO}`;
      ctx.textAlign = 'right';
      ctx.fillStyle = r.out ? 'rgba(255,140,120,0.9)' : liftColor(r.faction.color);
      ctx.fillText(r.out ? '✕' : String(r.worlds), x + w - 22 * u, cy + 1);
      ctx.textAlign = 'left';
    });
    ctx.globalAlpha = alpha * 0.7;
    ctx.font = `500 ${Math.round(16 * u)}px ${FONT_BODY}`;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'top';
    ctx.fillStyle = DIM;
    ctx.fillText(labels.worlds.toUpperCase(), x + w - 22 * u, y + rows.length * rowH + 12 * u);
  }
  ctx.restore();
}

/** A whole-frame dim behind a card, heavier at the centre line. */
function dimFrame(ctx: CanvasRenderingContext2D, W: number, H: number, a: number) {
  const g = ctx.createRadialGradient(W / 2, H / 2, H * 0.1, W / 2, H / 2, W * 0.7);
  g.addColorStop(0, `rgba(2,4,9,${0.72 * a})`);
  g.addColorStop(1, `rgba(2,4,9,${0.4 * a})`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
}

/** The opening card: the match's name and who played. */
export function drawTitleCard(ctx: CanvasRenderingContext2D, W: number, H: number,
  c: { kicker: string; title: string; sub: string }, factions: FilmFaction[], k: number, out: number,
  /** How hard to dim what is behind: less over a battle worth seeing. */
  dim = 1) {
  const u = unitOf(H);
  const a = ease(k) * (1 - ease(out));
  if (a <= 0.01) return;
  ctx.save();
  dimFrame(ctx, W, H, a * dim);
  {
    const band = ctx.createLinearGradient(0, H * 0.26, 0, H * 0.7);
    band.addColorStop(0, 'rgba(2,4,9,0)');
    band.addColorStop(0.25, `rgba(2,4,9,${0.62 * a})`);
    band.addColorStop(0.75, `rgba(2,4,9,${0.62 * a})`);
    band.addColorStop(1, 'rgba(2,4,9,0)');
    ctx.fillStyle = band;
    ctx.fillRect(0, H * 0.26, W, H * 0.44);
  }
  ctx.globalAlpha = a;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.shadowColor = 'rgba(0,0,0,0.8)'; ctx.shadowBlur = 16 * u;
  ctx.font = `700 ${Math.round(24 * u)}px ${FONT_BODY}`;
  spacing(ctx, 8 * u);
  ctx.fillStyle = '#9fc4e8';
  ctx.fillText(c.kicker.toUpperCase(), W / 2 + 4 * u, H * 0.34);
  spacing(ctx, 0);
  const size = fit(ctx, c.title, FONT_DISPLAY, '400', Math.round(104 * u), Math.round(44 * u), W * 0.86);
  ctx.font = `400 ${size}px ${FONT_DISPLAY}`;
  ctx.fillStyle = INK;
  const rise = (1 - ease(k)) * 18 * u;
  ctx.fillText(c.title, W / 2, H * 0.44 + rise);
  ctx.font = `500 ${Math.round(30 * u)}px ${FONT_BODY}`;
  ctx.fillStyle = DIM;
  ctx.fillText(c.sub, W / 2, H * 0.44 + size * 0.75 + rise);
  ctx.shadowBlur = 0;
  // The empires, in seat order: who is in this.
  const n = Math.min(12, factions.length);
  const r = 26 * u, step = Math.min(150 * u, (W * 0.86) / Math.max(1, n));
  const x0 = W / 2 - step * (n - 1) / 2;
  const y = H * 0.44 + size * 0.75 + 92 * u;
  factions.slice(0, n).forEach((f, i) => {
    const ki = ease((k - 0.25 - i * 0.04) * 3);
    drawEmblem(ctx, f, x0 + i * step, y + (1 - ki) * 10 * u, r, ki);
    // Who they are: the cast, named once at the start.
    ctx.save();
    ctx.globalAlpha *= ki;
    ctx.font = `600 ${Math.round(15 * u)}px ${FONT_BODY}`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    ctx.fillStyle = liftColor(f.color);
    ctx.fillText(ellipsize(ctx, shortName(f.name, 12), step - 8 * u), x0 + i * step, y + r + 10 * u);
    ctx.restore();
  });
  ctx.restore();
}

/** The result card: who won, how, and the final table. */
export function drawResultCard(ctx: CanvasRenderingContext2D, W: number, H: number,
  c: { kicker: string; title: string; sub: string; color: string | null },
  rows: StandingRow[], k: number, labels: { worlds: string; ships: string; url: string; out: string },
  /** Row one is a winner to crown, not just whoever is listed first. */
  crowned = true) {
  const u = unitOf(H);
  const a = ease(k);
  if (a <= 0.01) return;
  ctx.save();
  dimFrame(ctx, W, H, a * 1.25);
  ctx.globalAlpha = a;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.shadowColor = 'rgba(0,0,0,0.8)'; ctx.shadowBlur = 16 * u;
  const accent = c.color ? liftColor(c.color) : '#ffd38a';
  ctx.font = `700 ${Math.round(26 * u)}px ${FONT_BODY}`;
  spacing(ctx, 10 * u);
  ctx.fillStyle = accent;
  const top = H * 0.17;
  ctx.fillText(c.kicker.toUpperCase(), W / 2 + 5 * u, top);
  spacing(ctx, 0);
  const size = fit(ctx, c.title, FONT_DISPLAY, '400', Math.round(92 * u), Math.round(40 * u), W * 0.86);
  ctx.font = `400 ${size}px ${FONT_DISPLAY}`;
  ctx.fillStyle = INK;
  ctx.fillText(c.title, W / 2, top + 30 * u + size * 0.6);
  ctx.font = `500 ${Math.round(28 * u)}px ${FONT_BODY}`;
  ctx.fillStyle = DIM;
  ctx.fillText(ellipsize(ctx, c.sub, W * 0.8), W / 2, top + 30 * u + size * 1.42);
  ctx.shadowBlur = 0;

  // The table.
  // The top of the table at a size a phone can read; everyone knocked
  // out is one line under it.
  const alive = rows.filter(r => !r.out);
  const shown = rows.slice(0, Math.max(1, Math.min(5, alive.length || 1)));
  const fallen = rows.filter(r => r.out && !shown.includes(r));
  const rowH = 64 * u;
  const tw = Math.min(W * 0.7, 940 * u);
  const tx = W / 2 - tw / 2;
  let ty = top + 30 * u + size * 1.42 + 56 * u;
  shown.forEach((r, i) => {
    const ki = ease((k - 0.2 - i * 0.07) * 3);
    if (ki <= 0.01) return;
    const cy = ty + i * rowH + rowH / 2;
    ctx.globalAlpha = a * ki * (r.out ? 0.5 : 1);
    ctx.fillStyle = i === 0 && crowned ? rgba(r.faction.color, 0.3) : 'rgba(6,10,18,0.82)';
    ctx.beginPath(); ctx.roundRect(tx, cy - rowH / 2 + 4 * u, tw, rowH - 8 * u, 6 * u); ctx.fill();
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.font = `600 ${Math.round(28 * u)}px ${FONT_MONO}`;
    ctx.fillStyle = DIM;
    if (crowned) ctx.fillText(String(i + 1), tx + 20 * u, cy + 1);
    drawEmblem(ctx, r.faction, tx + 84 * u, cy, 21 * u);
    ctx.font = `600 ${Math.round(32 * u)}px ${FONT_BODY}`;
    ctx.fillStyle = INK;
    ctx.fillText(ellipsize(ctx, r.faction.name, tw * 0.46), tx + 122 * u, cy + 1);
    ctx.textAlign = 'right';
    ctx.font = `600 ${Math.round(26 * u)}px ${FONT_MONO}`;
    if (r.out) {
      ctx.fillStyle = 'rgba(255,140,120,0.9)';
      ctx.fillText('✕', tx + tw - 190 * u, cy + 1);
      if (r.ships > 0) {
        ctx.fillStyle = DIM;
        ctx.fillText(`${r.ships} ${labels.ships}`, tx + tw - 20 * u, cy + 1);
      }
    } else {
      ctx.fillStyle = liftColor(r.faction.color);
      ctx.fillText(`${r.worlds} ${labels.worlds}`, tx + tw - 190 * u, cy + 1);
      ctx.fillStyle = DIM;
      ctx.fillText(`${r.ships} ${labels.ships}`, tx + tw - 20 * u, cy + 1);
    }
  });
  ty += shown.length * rowH;
  if (fallen.length) {
    ctx.globalAlpha = a * ease((k - 0.5) * 3);
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = `500 ${Math.round(24 * u)}px ${FONT_BODY}`;
    ctx.fillStyle = 'rgba(255,160,140,0.85)';
    ctx.fillText(ellipsize(ctx, `${labels.out} ${fallen.map(r => shortName(r.faction.name, 18)).join(' · ')}`, tw),
      W / 2, ty + 30 * u);
    ty += 50 * u;
  }
  ctx.globalAlpha = a * ease((k - 0.6) * 3);
  ctx.textAlign = 'center';
  ctx.font = `400 ${Math.round(26 * u)}px ${FONT_DISPLAY}`;
  spacing(ctx, 4 * u);
  ctx.fillStyle = '#9fc4e8';
  ctx.fillText(labels.url.toUpperCase(), W / 2 + 2 * u, Math.min(H - 60 * u, ty + 70 * u));
  spacing(ctx, 0);
  ctx.restore();
}

/** The cold open's one line, slammed over the action. */
export function drawHookLine(ctx: CanvasRenderingContext2D, W: number, H: number,
  text: string, k: number, out: number) {
  const a = Math.min(1, k * 6) * (1 - ease(out));
  if (a <= 0.01 || !text) return;
  const u = unitOf(H);
  const slam = 1 + 0.22 * (1 - ease(k * 5));
  ctx.save();
  ctx.globalAlpha = a;
  ctx.translate(W / 2, H * 0.8);
  ctx.scale(slam, slam);
  const size = fit(ctx, text, FONT_DISPLAY, '400', Math.round(88 * u), Math.round(44 * u), W * 0.86);
  ctx.font = `400 ${size}px ${FONT_DISPLAY}`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.shadowColor = 'rgba(0,0,0,0.9)'; ctx.shadowBlur = 24 * u;
  ctx.fillStyle = INK;
  ctx.fillText(text, 0, 0);
  ctx.restore();
}

/**
 * The Dyson Sphere as the film shows it: a shell of segments round the
 * star that fill as it is built, in its builder's colour, closing into a
 * whole ring that flares at completion. Drawn over the game's own lattice,
 * which at film scale read as a thin line round the sun.
 */
export function drawDysonShell(ctx: CanvasRenderingContext2D, x: number, y: number, r: number,
  progress: number, complete: boolean, color: string | null, flare: number, nowMs: number,
  seal = complete ? 1 : 0) {
  if (r < 6) return;
  const c = color ? liftColor(color, 150) : '#ffb84d';
  const R = r * 1.6;
  const SEG = 24;
  // The last segment lights only at 100%: at 99% one is still dark.
  const lit = complete || progress >= 1 ? SEG : Math.min(SEG - 1, Math.floor(Math.max(0, progress) * SEG));
  // THE SHELL CLOSES segment by segment, round the star: the gaps shut in
  // order as `seal` runs 0..1.
  const sealed = Math.floor(Math.max(0, Math.min(1, seal)) * SEG + 1e-6);
  const spin = (nowMs / 90000) * Math.PI * 2;
  const seg = (Math.PI * 2) / SEG, gap = seg * 0.16;
  ctx.save();
  ctx.lineCap = 'round';
  // The scaffold still to come.
  ctx.strokeStyle = 'rgba(255,200,120,0.16)';
  ctx.lineWidth = Math.max(1, r * 0.03);
  for (let i = lit; i < SEG; i++) {
    ctx.beginPath(); ctx.arc(x, y, R, spin + i * seg + gap, spin + (i + 1) * seg - gap); ctx.stroke();
  }
  // What is built, glowing.
  ctx.globalCompositeOperation = 'lighter';
  ctx.shadowColor = c; ctx.shadowBlur = r * 0.25;
  ctx.strokeStyle = c;
  for (let i = 0; i < lit; i++) {
    const shut = i < sealed;
    ctx.lineWidth = Math.max(2, r * (shut ? 0.12 : 0.08));
    ctx.beginPath(); ctx.arc(x, y, R, spin + i * seg + (shut ? 0 : gap), spin + (i + 1) * seg - (shut ? 0 : gap)); ctx.stroke();
  }
  if (flare > 0.01) {
    const g = ctx.createRadialGradient(x, y, R * 0.6, x, y, R * (1.4 + flare));
    g.addColorStop(0, `rgba(255,236,190,${0.55 * flare})`);
    g.addColorStop(1, 'rgba(255,200,120,0)');
    ctx.shadowBlur = 0;
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(x, y, R * (1.4 + flare), 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
}

/** A hairline along the very bottom: how far through the film. */
export function drawProgress(ctx: CanvasRenderingContext2D, W: number, H: number, k: number) {
  const u = unitOf(H);
  ctx.save();
  ctx.fillStyle = 'rgba(255,255,255,0.10)';
  ctx.fillRect(0, H - 4 * u, W, 4 * u);
  ctx.fillStyle = 'rgba(159,196,232,0.85)';
  ctx.fillRect(0, H - 4 * u, W * Math.max(0, Math.min(1, k)), 4 * u);
  ctx.restore();
}

/** A frame-edge vignette: the film look, and a ground for the graphics. */
export function drawVignette(ctx: CanvasRenderingContext2D, W: number, H: number) {
  const g = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.42, W / 2, H / 2, Math.hypot(W, H) * 0.56);
  g.addColorStop(0, 'rgba(0,0,0,0)');
  g.addColorStop(1, 'rgba(0,0,0,0.5)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
}

/**
 * A world's ships as counted pills, one per empire, for when the camera
 * is too far out for hulls to read (the game's own badge, in miniature).
 */
export function drawCountChips(ctx: CanvasRenderingContext2D, H: number,
  x: number, y: number, counts: Array<{ faction: FilmFaction; n: number }>, alpha: number) {
  if (alpha <= 0.02 || !counts.length) return;
  const u = Math.max(0.7, unitOf(H));
  const fs = Math.round(13 * u), ph = fs + 8 * u, gap = 3 * u, pad = 5 * u, em = fs;
  ctx.save();
  ctx.globalAlpha *= alpha;
  ctx.font = `400 ${fs}px ${FONT_DISPLAY}`;
  ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
  const widths = counts.map(c => em + pad * 2 + 3 * u + ctx.measureText(String(c.n)).width);
  const total = widths.reduce((s, w) => s + w, 0) + gap * (counts.length - 1);
  let cx = x - total / 2;
  counts.forEach((c, i) => {
    const w = widths[i];
    ctx.beginPath(); ctx.roundRect(cx, y - ph / 2, w, ph, 4 * u);
    ctx.fillStyle = 'rgba(4,8,14,0.92)'; ctx.fill();
    ctx.lineWidth = 1.6 * u; ctx.strokeStyle = c.faction.color; ctx.stroke();
    const img = getEmblemImage(c.faction.emblem ?? null, liftColor(c.faction.color, 150));
    if (img) ctx.drawImage(img, cx + pad, y - em / 2, em, em);
    else { ctx.fillStyle = c.faction.color; ctx.beginPath(); ctx.arc(cx + pad + em / 2, y, em * 0.3, 0, Math.PI * 2); ctx.fill(); }
    ctx.fillStyle = liftColor(c.faction.color);
    ctx.fillText(String(c.n), cx + pad + em + 3 * u, y + 1);
    cx += w + gap;
  });
  ctx.restore();
}

export interface SenateCard {
  label: string;
  /** The bill's own name. */
  bill: string;
  yea: number;
  nay: number;
  /** How long it held ("In force for 24 days"). */
  term: string;
  /** What came of it, measured from the record ("212 ships built while it held"). */
  impact: string;
  /** "+1 more law passed the same day", or ''. */
  more: string;
}

/**
 * THE SENATE AT WORK: a law that passed, how the vote went, how long it
 * held and what came of it. Right of frame, clear of the lower third,
 * under the Sphere meter's slot.
 */
export function drawSenateCard(ctx: CanvasRenderingContext2D, W: number, H: number,
  c: SenateCard, inK: number, outK: number) {
  const a = Math.max(0, Math.min(1, inK)) * (1 - Math.max(0, Math.min(1, outK)));
  if (a <= 0.01) return;
  const u = unitOf(H);
  const accent = '#f0c66e';
  const w = 600 * u, pad = 22 * u;
  ctx.save();
  ctx.globalAlpha = a;
  ctx.font = `600 ${Math.round(34 * u)}px ${FONT_BODY}`;
  const billLines = wrapLines(ctx, `\u201c${c.bill}\u201d`, w - pad * 2, 2);
  const impactSize = Math.round(32 * u);
  ctx.font = `700 ${impactSize}px ${FONT_BODY}`;
  const impactLines = c.impact ? wrapLines(ctx, c.impact, w - pad * 2, 2) : [];
  const h = pad + 26 * u + 14 * u + billLines.length * 40 * u + 16 * u + 18 * u + 22 * u
    + 30 * u + impactLines.length * impactSize * 1.15 + (c.more ? 32 * u : 0) + pad;
  const slide = (1 - Math.max(0, Math.min(1, inK))) * 24 * u;
  const x = W * 0.945 - w + slide, y = H * 0.05 + 96 * u + 116 * u + 24 * u;
  ctx.fillStyle = 'rgba(3,6,12,0.86)';
  ctx.beginPath(); ctx.roundRect(x, y, w, h, 8 * u); ctx.fill();
  ctx.fillStyle = accent;
  ctx.fillRect(x, y, 5 * u, h);
  let cy = y + pad;
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';
  ctx.font = `700 ${Math.round(24 * u)}px ${FONT_BODY}`;
  spacing(ctx, 2.5 * u);
  ctx.fillStyle = accent;
  ctx.fillText(c.label.toUpperCase(), x + pad, cy);
  spacing(ctx, 0);
  cy += 26 * u + 14 * u;
  ctx.font = `600 ${Math.round(34 * u)}px ${FONT_BODY}`;
  ctx.fillStyle = INK;
  for (const l of billLines) { ctx.fillText(l, x + pad, cy); cy += 40 * u; }
  cy += 16 * u;
  // The vote: yea against nay, one bar.
  const bw = w - pad * 2, bh = 18 * u, tot = Math.max(1, c.yea + c.nay);
  ctx.fillStyle = 'rgba(224,103,92,0.85)';
  ctx.beginPath(); ctx.roundRect(x + pad, cy, bw, bh, 5 * u); ctx.fill();
  ctx.fillStyle = 'rgba(127,211,138,0.95)';
  ctx.beginPath(); ctx.roundRect(x + pad, cy, Math.max(bh, bw * (c.yea / tot)), bh, 5 * u); ctx.fill();
  cy += bh + 6 * u;
  ctx.font = `600 ${Math.round(22 * u)}px ${FONT_MONO}`;
  ctx.fillStyle = 'rgba(127,211,138,1)';
  ctx.fillText(`YEA ${c.yea}`, x + pad, cy);
  ctx.textAlign = 'right';
  ctx.fillStyle = 'rgba(234,130,120,1)';
  ctx.fillText(`NAY ${c.nay}`, x + w - pad, cy);
  ctx.textAlign = 'left';
  cy += 22 * u + 10 * u;
  ctx.font = `500 ${Math.round(24 * u)}px ${FONT_BODY}`;
  ctx.fillStyle = 'rgba(238,244,251,0.72)';
  ctx.fillText(c.term, x + pad, cy);
  cy += 30 * u;
  ctx.font = `700 ${impactSize}px ${FONT_BODY}`;
  ctx.fillStyle = INK;
  for (const l of impactLines) { ctx.fillText(l, x + pad, cy); cy += impactSize * 1.15; }
  if (c.more) {
    cy += 6 * u;
    ctx.font = `500 ${Math.round(22 * u)}px ${FONT_BODY}`;
    ctx.fillStyle = 'rgba(238,244,251,0.6)';
    ctx.fillText(c.more, x + pad, cy);
  }
  ctx.restore();
}
