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
  c: LowerThird, inK: number, outK: number) {
  if (!c.title && !c.kicker) return;
  const u = unitOf(H);
  const a = ease(inK) * (1 - ease(outK));
  if (a <= 0.01) return;
  const x0 = 64 * u;
  const maxW = Math.min(W * 0.54, W - 2 * x0);
  const accent = c.color ? liftColor(c.color) : '#9fc4e8';

  ctx.save();
  const titleSize = fit(ctx, c.title, FONT_DISPLAY, '400', Math.round(64 * u), Math.round(36 * u), maxW);
  const subSize = Math.round(29 * u);
  ctx.font = `500 ${subSize}px ${FONT_BODY}`;
  // The sub is the fact that explains the moment: two lines before it is
  // ever cut ("62 ships…" lost the losses; "PASSED…" lost the vote).
  const subLines = c.sub ? wrapLines(ctx, c.sub, maxW, 2) : [];
  const sub = subLines.join(' ');
  const kickSize = Math.round(25 * u);
  const gap = 10 * u;
  const subH = subLines.length ? gap + subSize * (1 + (subLines.length - 1) * 1.15) : 0;
  const blockH = kickSize + gap + titleSize * 1.05 + subH;
  const yBottom = H - 70 * u;
  const yTop = yBottom - blockH;

  // Measure for the plate.
  ctx.font = `400 ${titleSize}px ${FONT_DISPLAY}`;
  let wide = ctx.measureText(c.title).width;
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
  ctx.fillText(c.title, x0 - slide, y);
  y += titleSize * 1.05 + gap;
  if (sub) {
    ctx.font = `500 ${subSize}px ${FONT_BODY}`;
    ctx.fillStyle = DIM;
    ctx.globalAlpha = a * ease(Math.max(0, inK * 1.5 - 0.35));
    subLines.forEach((l, i) => ctx.fillText(l, x0 - slide * 1.3, y + i * subSize * 1.15));
  }
  ctx.restore();
}

/** Top-right: the match clock, and the playback speed when it is fast. */
export function drawClock(ctx: CanvasRenderingContext2D, W: number, H: number,
  tick: number, speedLabel: string | null, alpha = 1) {
  const u = unitOf(H);
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'top';
  const x = W - 56 * u, y = 44 * u;
  ctx.shadowColor = 'rgba(0,0,0,0.7)'; ctx.shadowBlur = 8 * u;
  ctx.font = `600 ${Math.round(34 * u)}px ${FONT_MONO}`;
  ctx.fillStyle = INK;
  ctx.fillText(`T+${Math.max(0, Math.floor(tick))}`, x, y);
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
  const size = Math.round(25 * u);
  const lineH = 46 * u;
  const right = W - 56 * u;
  const maxW = Math.max(200 * u, Math.min(W * 0.36, right - avoidLeft - 40 * u));
  ctx.save();
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  let y = H - 84 * u;
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    const a = Math.min(ease(it.life / 0.12), 1 - ease((it.life - 0.82) / 0.18));
    if (a <= 0.01) { y -= lineH * 0.3; continue; }
    ctx.font = `500 ${size}px ${FONT_BODY}`;
    const text = ellipsize(ctx, it.text, maxW - 44 * u);
    const w = ctx.measureText(text).width + 58 * u;
    const x = right - w + (1 - ease(it.life / 0.12)) * 30 * u;
    ctx.globalAlpha = a;
    ctx.fillStyle = PLATE;
    ctx.beginPath(); ctx.roundRect(x, y - lineH / 2 + 3 * u, w, lineH - 6 * u, 5 * u); ctx.fill();
    if (it.faction) drawEmblem(ctx, it.faction, x + 22 * u, y, 14 * u);
    ctx.fillStyle = INK;
    ctx.fillText(text, x + 44 * u, y + 1);
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
  sides: TallySide[], alpha: number, vsLabel = 'VS') {
  if (sides.length < 1 || alpha <= 0.01) return;
  const u = unitOf(H);
  ctx.save();
  ctx.globalAlpha = alpha;
  const cy = 64 * u;
  const nameSize = Math.round(23 * u), numSize = Math.round(46 * u);
  const sideW = Math.min(W * 0.34, 520 * u);
  const draw = (s: TallySide, dir: -1 | 1) => {
    const cx = W / 2 + dir * 52 * u;
    const align = dir < 0 ? 'right' : 'left';
    ctx.textAlign = align;
    ctx.textBaseline = 'middle';
    const ex = cx + dir * 22 * u;
    drawEmblem(ctx, s.faction, ex, cy, 24 * u);
    ctx.shadowColor = 'rgba(0,0,0,0.8)'; ctx.shadowBlur = 8 * u;
    ctx.font = `400 ${numSize}px ${FONT_DISPLAY}`;
    ctx.fillStyle = INK;
    const nx = ex + dir * 38 * u;
    ctx.fillText(String(s.ships), nx, cy + 2 * u);
    const nw = ctx.measureText(String(s.ships)).width;
    ctx.font = `700 ${nameSize}px ${FONT_BODY}`;
    spacing(ctx, 1.5 * u);
    ctx.fillStyle = liftColor(s.faction.color);
    const name = ellipsize(ctx, s.faction.name.toUpperCase(), sideW - nw - 120 * u);
    const tx = nx + dir * (nw + 14 * u);
    ctx.fillText(name, tx, cy - 11 * u);
    spacing(ctx, 0);
    if (s.lost > 0) {
      ctx.font = `600 ${Math.round(20 * u)}px ${FONT_MONO}`;
      ctx.fillStyle = '#ff9d7a';
      ctx.fillText(`−${s.lost}`, tx, cy + 16 * u);
    }
    ctx.shadowBlur = 0;
  };
  // A band behind the whole tally.
  const g = ctx.createLinearGradient(W / 2 - sideW - 60 * u, 0, W / 2 + sideW + 60 * u, 0);
  g.addColorStop(0, 'rgba(3,6,12,0)');
  g.addColorStop(0.25, 'rgba(3,6,12,0.7)');
  g.addColorStop(0.75, 'rgba(3,6,12,0.7)');
  g.addColorStop(1, 'rgba(3,6,12,0)');
  ctx.fillStyle = g;
  ctx.fillRect(W / 2 - sideW - 60 * u, cy - 34 * u, (sideW + 60 * u) * 2, 68 * u);
  draw(sides[0], -1);
  if (sides[1]) draw(sides[1], 1);
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.font = `700 ${Math.round(18 * u)}px ${FONT_BODY}`;
  spacing(ctx, 3 * u);
  ctx.fillStyle = 'rgba(255,190,120,0.95)';
  ctx.fillText(vsLabel, W / 2 + 1.5 * u, cy);
  spacing(ctx, 0);
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
  const x = 52 * u;
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
    const rowH = 42 * u;
    const nameW = 250 * u;
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
      ctx.font = `600 ${Math.round(23 * u)}px ${FONT_BODY}`;
      ctx.fillStyle = INK;
      ctx.textBaseline = 'middle';
      ctx.fillText(ellipsize(ctx, r.faction.name, nameW - 14 * u), x + 38 * u, cy + 1);
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
  const r = 24 * u, step = Math.min(70 * u, (W * 0.8) / Math.max(1, n));
  const x0 = W / 2 - step * (n - 1) / 2;
  const y = H * 0.44 + size * 0.75 + 92 * u;
  factions.slice(0, n).forEach((f, i) => {
    const ki = ease((k - 0.25 - i * 0.04) * 3);
    drawEmblem(ctx, f, x0 + i * step, y + (1 - ki) * 10 * u, r, ki);
  });
  ctx.restore();
}

/** The result card: who won, how, and the final table. */
export function drawResultCard(ctx: CanvasRenderingContext2D, W: number, H: number,
  c: { kicker: string; title: string; sub: string; color: string | null },
  rows: StandingRow[], k: number, labels: { worlds: string; ships: string; url: string },
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
  ctx.fillText(ellipsize(ctx, c.sub, W * 0.8), W / 2, top + 30 * u + size * 1.25);
  ctx.shadowBlur = 0;

  // The table.
  // Every empire: a table that leaves players out is not the result.
  const shown = rows.slice(0, 12);
  const rowH = (shown.length > 6 ? 40 : 52) * u;
  const tw = Math.min(W * 0.62, 760 * u);
  const tx = W / 2 - tw / 2;
  let ty = top + 30 * u + size * 1.25 + 56 * u;
  shown.forEach((r, i) => {
    const ki = ease((k - 0.2 - i * 0.07) * 3);
    if (ki <= 0.01) return;
    const cy = ty + i * rowH + rowH / 2;
    ctx.globalAlpha = a * ki * (r.out ? 0.5 : 1);
    ctx.fillStyle = i === 0 && crowned ? rgba(r.faction.color, 0.3) : 'rgba(6,10,18,0.82)';
    ctx.beginPath(); ctx.roundRect(tx, cy - rowH / 2 + 4 * u, tw, rowH - 8 * u, 6 * u); ctx.fill();
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.font = `600 ${Math.round(22 * u)}px ${FONT_MONO}`;
    ctx.fillStyle = DIM;
    ctx.fillText(String(i + 1), tx + 20 * u, cy + 1);
    drawEmblem(ctx, r.faction, tx + 74 * u, cy, 16 * u);
    ctx.font = `600 ${Math.round(24 * u)}px ${FONT_BODY}`;
    ctx.fillStyle = INK;
    ctx.fillText(ellipsize(ctx, r.faction.name, tw * 0.5), tx + 104 * u, cy + 1);
    ctx.textAlign = 'right';
    ctx.font = `600 ${Math.round(21 * u)}px ${FONT_MONO}`;
    if (r.out) {
      ctx.fillStyle = 'rgba(255,140,120,0.9)';
      ctx.fillText('✕', tx + tw - 20 * u, cy + 1);
    } else {
      ctx.fillStyle = liftColor(r.faction.color);
      ctx.fillText(`${r.worlds} ${labels.worlds}`, tx + tw - 150 * u, cy + 1);
      ctx.fillStyle = DIM;
      ctx.fillText(`${r.ships} ${labels.ships}`, tx + tw - 20 * u, cy + 1);
    }
  });
  ty += shown.length * rowH;
  ctx.globalAlpha = a * ease((k - 0.6) * 3);
  ctx.textAlign = 'center';
  ctx.font = `400 ${Math.round(26 * u)}px ${FONT_DISPLAY}`;
  spacing(ctx, 4 * u);
  ctx.fillStyle = '#9fc4e8';
  ctx.fillText(labels.url.toUpperCase(), W / 2 + 2 * u, Math.min(H - 60 * u, ty + 70 * u));
  spacing(ctx, 0);
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
