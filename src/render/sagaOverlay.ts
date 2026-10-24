// ============================================================
// sagaOverlay — the graphics the Saga Engine's script adds to the match
// film: the opening crawl, the empires' cards, a veteran captain's last
// moment, the public channel's transmissions, and the roll call that closes
// the film. Drawn over the map in the film's own faces and plates
// (filmOverlay); pure drawing, no state, no clock: matchMap.ts decides what
// is up and how far it has animated.
// ============================================================

import {
  FONT_BODY, FONT_DISPLAY, FONT_MONO, drawEmblem, ease, ellipsize, liftColor, rgba,
  spacing, unitOf, wrapLines, type FilmFaction,
} from './filmOverlay';

const INK = '#eef4fb';
const AMBER = '#ffc878';
const HOLO = '#8fd3e8';

/**
 * THE OPENING CRAWL: the title (a Senate law, or the engine's own), then
 * three short paragraphs, rolling away up a tilted plane toward a horizon,
 * over black. `k` runs 0..1 over the crawl; `alpha` fades it in and out.
 */
export function drawCrawl(ctx: CanvasRenderingContext2D, W: number, H: number,
  c: { show: string; title: string; credit: string; lines: string[] }, k: number, alpha: number) {
  if (alpha <= 0.01) return;
  const u = unitOf(H);
  ctx.save();
  ctx.globalAlpha = 1;
  ctx.fillStyle = `rgba(1,2,6,${0.93 * alpha})`;
  ctx.fillRect(0, 0, W, H);
  // Lay the block out flat, in "page" pixels at full size.
  const maxW = Math.min(W * 0.66, 980 * u);
  type Line = { text: string; font: string; color: string; size: number; gapAfter: number; italic?: boolean };
  const block: Line[] = [];
  const add = (texts: string[], font: string, color: string, size: number, gapAfter: number) =>
    texts.forEach((t, i) => block.push({ text: t, font, color, size, gapAfter: i === texts.length - 1 ? gapAfter : size * 0.28 }));
  ctx.font = `600 ${Math.round(22 * u)}px ${FONT_MONO}`;
  add([c.show.toUpperCase()], ctx.font, AMBER, 22 * u, 30 * u);
  ctx.font = `italic 500 ${Math.round(58 * u)}px ${FONT_BODY}`;
  add(wrapLines(ctx, `“${c.title}”`, maxW, 3), ctx.font, INK, 58 * u, c.credit ? 18 * u : 54 * u);
  if (c.credit) {
    ctx.font = `500 ${Math.round(19 * u)}px ${FONT_MONO}`;
    add([c.credit], ctx.font, 'rgba(200,216,232,0.75)', 19 * u, 56 * u);
  }
  ctx.font = `700 ${Math.round(36 * u)}px ${FONT_BODY}`;
  for (const p of c.lines) add(wrapLines(ctx, p, maxW, 8), ctx.font, AMBER, 36 * u, 34 * u);
  const total = block.reduce((a, l) => a + l.size + l.gapAfter, 0);

  // Scroll: the first line starts at the bottom; by the end the last line
  // is most of the way to the horizon.
  const bottomY = H * 0.97, horizonY = H * 0.12;
  const scroll = (total + H * 0.85) * Math.max(0, Math.min(1, k));
  let pageY = 0;
  ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
  for (const l of block) {
    pageY += l.size;
    const flat = scroll - pageY;          // how far above the bottom edge, flat
    pageY += l.gapAfter;
    if (flat < -l.size) continue;
    const d = Math.max(0, flat) / H;
    const z = 1 + d * 2.6;
    const s = 1 / z;
    const y = horizonY + (bottomY - horizonY) / z;
    const fade = Math.max(0, Math.min(1, (s - 0.28) / 0.22)) * Math.min(1, (flat + l.size) / l.size);
    if (fade <= 0.01) continue;
    ctx.save();
    ctx.globalAlpha = alpha * fade;
    ctx.translate(W / 2, y);
    ctx.scale(s, s);
    ctx.font = l.font;
    ctx.fillStyle = l.color;
    ctx.fillText(l.text, 0, 0);
    ctx.restore();
  }
  ctx.restore();
}

/** One empire's card in the opening act: its flag, its name, its creed. */
export function drawCastCard(ctx: CanvasRenderingContext2D, W: number, H: number,
  c: { faction: FilmFaction; creed: string; quoted: boolean; home: string; index: number; count: number },
  k: number, out: number) {
  const u = unitOf(H);
  const a = ease(k) * (1 - ease(out));
  if (a <= 0.01) return;
  const x0 = Math.max(96 * u, W * 0.05 + 22 * u);
  const maxW = Math.min(W * 0.56, W - 2 * x0 - 120 * u);
  ctx.save();
  ctx.globalAlpha = a;
  const nameSize = Math.round(58 * u);
  ctx.font = `400 ${nameSize}px ${FONT_DISPLAY}`;
  const nameLines = wrapLines(ctx, c.faction.name, maxW, 2);
  const creedSize = Math.round(34 * u);
  ctx.font = `${c.quoted ? 'italic ' : ''}500 ${creedSize}px ${FONT_BODY}`;
  const creed = c.quoted ? `“${c.creed}”` : c.creed;
  const creedLines = c.creed ? wrapLines(ctx, creed, maxW, 2) : [];
  const metaSize = Math.round(22 * u);
  const blockH = metaSize + 12 * u + nameSize * 1.05 * nameLines.length + (creedLines.length ? 14 * u + creedSize * 1.2 * creedLines.length : 0);
  const yBottom = H - 76 * u;
  const yTop = yBottom - blockH;
  const slide = (1 - ease(k)) * 26 * u;
  // The plate, in the empire's colour at the left edge.
  const plate = ctx.createLinearGradient(x0 - 40 * u, 0, x0 + maxW + 160 * u, 0);
  plate.addColorStop(0, 'rgba(4,8,14,0.88)');
  plate.addColorStop(0.75, 'rgba(4,8,14,0.6)');
  plate.addColorStop(1, 'rgba(4,8,14,0)');
  ctx.fillStyle = plate;
  ctx.fillRect(x0 - 40 * u - slide, yTop - 30 * u, maxW + 200 * u, blockH + 58 * u);
  ctx.fillStyle = c.faction.color;
  ctx.fillRect(x0 - 40 * u - slide, yTop - 30 * u, 7 * u, blockH + 58 * u);
  // Emblem, right of the text.
  const R = 54 * u;
  drawEmblem(ctx, c.faction, x0 - slide + maxW + 80 * u, yTop + blockH / 2, R, 1);
  let y = yTop;
  ctx.textAlign = 'left'; ctx.textBaseline = 'top';
  ctx.font = `600 ${metaSize}px ${FONT_MONO}`;
  spacing(ctx, 3 * u);
  ctx.fillStyle = AMBER;
  const meta = [c.home ? `HOME · ${c.home.toUpperCase()}` : '', `${c.index + 1} / ${c.count}`].filter(Boolean).join('   ');
  ctx.fillText(meta, x0 - slide, y);
  spacing(ctx, 0);
  y += metaSize + 12 * u;
  ctx.font = `400 ${nameSize}px ${FONT_DISPLAY}`;
  ctx.fillStyle = liftColor(c.faction.color, 190);
  for (const l of nameLines) { ctx.fillText(l, x0 - slide, y); y += nameSize * 1.05; }
  if (creedLines.length) {
    y += 14 * u;
    ctx.font = `${c.quoted ? 'italic ' : ''}500 ${creedSize}px ${FONT_BODY}`;
    ctx.fillStyle = 'rgba(238,244,251,0.9)';
    for (const l of creedLines) { ctx.fillText(l, x0 - slide, y); y += creedSize * 1.2; }
  }
  ctx.restore();
}

/**
 * A VETERAN FALLS: the captain's card (portrait, rank, bio, record) over
 * the fight that kills them; at `burn` the ship goes and the card burns out.
 */
export function drawCaptainCard(ctx: CanvasRenderingContext2D, W: number, H: number,
  c: { name: string; rank: number; faction: FilmFaction; ship: string; bio: string; record: string;
    ledger: string[]; portrait: HTMLImageElement | null; kicker: string },
  k: number, burn: number, out: number) {
  const u = unitOf(H);
  const a = ease(k) * (1 - ease(out));
  if (a <= 0.01) return;
  const x = Math.max(80 * u, W * 0.05), y = Math.max(80 * u, H * 0.07);
  const w = Math.min(W * 0.5, 760 * u), h = 250 * u;
  ctx.save();
  ctx.globalAlpha = a * (1 - 0.65 * ease(burn));
  ctx.fillStyle = 'rgba(8,4,5,0.9)';
  ctx.beginPath(); ctx.roundRect(x, y, w, h, 10 * u); ctx.fill();
  ctx.fillStyle = burn > 0 ? '#ff4d4d' : c.faction.color;
  ctx.fillRect(x, y, w, 5 * u);
  const P = 180 * u, px = x + 24 * u, py = y + 36 * u;
  if (c.portrait && c.portrait.complete && c.portrait.naturalWidth > 0) {
    ctx.save();
    ctx.beginPath(); ctx.roundRect(px, py, P, P, 8 * u); ctx.clip();
    (ctx as CanvasRenderingContext2D & { filter: string }).filter = burn > 0 ? `grayscale(${Math.min(1, burn * 1.5)})` : 'none';
    ctx.drawImage(c.portrait, px, py, P, P);
    ctx.restore();
  } else {
    drawEmblem(ctx, c.faction, px + P / 2, py + P / 2, P * 0.38, 1);
  }
  ctx.strokeStyle = 'rgba(255,255,255,0.18)'; ctx.lineWidth = 1.5 * u;
  ctx.beginPath(); ctx.roundRect(px, py, P, P, 8 * u); ctx.stroke();
  const tx = px + P + 26 * u, tw = w - (tx - x) - 24 * u;
  let ty = y + 36 * u;
  ctx.textAlign = 'left'; ctx.textBaseline = 'top';
  ctx.font = `600 ${Math.round(19 * u)}px ${FONT_MONO}`;
  spacing(ctx, 3 * u);
  ctx.fillStyle = '#ff7b6e';
  ctx.fillText(ellipsize(ctx, `${c.kicker} · RANK ${c.rank}`, tw), tx, ty);
  spacing(ctx, 0);
  ty += 30 * u;
  ctx.font = `400 ${Math.round(40 * u)}px ${FONT_DISPLAY}`;
  ctx.fillStyle = INK;
  ctx.fillText(ellipsize(ctx, `Captain ${c.name}`, tw), tx, ty);
  ty += 50 * u;
  ctx.font = `500 ${Math.round(22 * u)}px ${FONT_BODY}`;
  ctx.fillStyle = liftColor(c.faction.color);
  ctx.fillText(ellipsize(ctx, `${c.faction.name}${c.ship ? ` · the ${c.ship}` : ''}`, tw), tx, ty);
  ty += 32 * u;
  if (c.bio) {
    ctx.font = `italic 500 ${Math.round(24 * u)}px ${FONT_BODY}`;
    ctx.fillStyle = 'rgba(238,244,251,0.88)';
    for (const l of wrapLines(ctx, `“${c.bio}”`, tw, 2)) { ctx.fillText(l, tx, ty); ty += 29 * u; }
  }
  ctx.font = `500 ${Math.round(18 * u)}px ${FONT_MONO}`;
  ctx.fillStyle = 'rgba(200,216,232,0.8)';
  ctx.fillText(ellipsize(ctx, c.record.toUpperCase(), tw), tx, y + h - 34 * u);
  // The record: the ships this captain destroyed, running underneath.
  if (c.ledger.length) {
    ctx.font = `500 ${Math.round(17 * u)}px ${FONT_MONO}`;
    ctx.fillStyle = 'rgba(255,123,110,0.85)';
    ctx.fillText(ellipsize(ctx, `KILLS · ${c.ledger.join(' · ')}`, w - 48 * u), x + 24 * u, y + h + 14 * u);
  }
  if (burn > 0) {
    ctx.save();
    ctx.globalAlpha = a * Math.min(1, burn * 2);
    ctx.translate(px + P / 2, py + P / 2);
    ctx.rotate(-0.16);
    ctx.font = `400 ${Math.round(44 * u)}px ${FONT_DISPLAY}`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const sw = ctx.measureText('LOST').width + 26 * u;
    ctx.strokeStyle = '#ff4d4d'; ctx.lineWidth = 4 * u;
    ctx.strokeRect(-sw / 2, -30 * u, sw, 60 * u);
    ctx.fillStyle = '#ff4d4d';
    ctx.fillText('LOST', 0, 2 * u);
    ctx.restore();
  }
  ctx.restore();
}

/** The light of a ship going up, over the whole frame. */
export function drawFlash(ctx: CanvasRenderingContext2D, W: number, H: number, x: number, y: number, k: number) {
  if (k <= 0 || k >= 1) return;
  const u = unitOf(H);
  const a = Math.sin(Math.PI * Math.min(1, k * 1.6)) * (1 - k);
  if (a <= 0.01) return;
  ctx.save();
  ctx.globalCompositeOperation = 'screen';
  const R = (120 + 900 * ease(k)) * u;
  const g = ctx.createRadialGradient(x, y, 0, x, y, R);
  g.addColorStop(0, `rgba(255,248,226,${0.95 * a})`);
  g.addColorStop(0.25, `rgba(255,170,90,${0.6 * a})`);
  g.addColorStop(1, 'rgba(255,90,40,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = `rgba(255,240,220,${0.18 * a})`;
  ctx.fillRect(0, 0, W, H);
  ctx.restore();
}

/** A line from the public channel, as it was sent. */
export function drawTransmission(ctx: CanvasRenderingContext2D, W: number, H: number,
  c: { faction: FilmFaction; text: string; label: string }, life: number) {
  if (life <= 0 || life >= 1) return;
  const u = unitOf(H);
  const a = Math.min(1, life / 0.06) * Math.min(1, (1 - life) / 0.1);
  if (a <= 0.01) return;
  const w = Math.min(W * 0.62, 980 * u);
  const x = (W - w) / 2, y = Math.max(70 * u, H * 0.06);
  ctx.save();
  ctx.globalAlpha = a;
  ctx.font = `500 ${Math.round(30 * u)}px ${FONT_MONO}`;
  const lines = wrapLines(ctx, c.text, w - 56 * u, 3);
  const h = 108 * u + lines.length * 40 * u;
  ctx.fillStyle = 'rgba(3,14,20,0.86)';
  ctx.beginPath(); ctx.roundRect(x, y, w, h, 10 * u); ctx.fill();
  // Scan lines: a signal, not a caption.
  ctx.fillStyle = 'rgba(143,211,232,0.05)';
  for (let sy = y + 2 * u; sy < y + h; sy += 5 * u) ctx.fillRect(x, sy, w, 2 * u);
  ctx.strokeStyle = rgba(HOLO, 0.45); ctx.lineWidth = 1.5 * u;
  ctx.beginPath(); ctx.roundRect(x, y, w, h, 10 * u); ctx.stroke();
  ctx.textAlign = 'left'; ctx.textBaseline = 'top';
  // The blinking dot, and who is talking.
  const blink = Math.floor(life * 24) % 2 === 0 ? 1 : 0.4;
  ctx.fillStyle = rgba(HOLO, blink);
  ctx.beginPath(); ctx.arc(x + 32 * u, y + 34 * u, 7 * u, 0, Math.PI * 2); ctx.fill();
  ctx.font = `600 ${Math.round(19 * u)}px ${FONT_MONO}`;
  spacing(ctx, 3 * u);
  ctx.fillStyle = HOLO;
  ctx.fillText(c.label.toUpperCase(), x + 50 * u, y + 24 * u);
  spacing(ctx, 0);
  ctx.font = `400 ${Math.round(30 * u)}px ${FONT_DISPLAY}`;
  ctx.fillStyle = liftColor(c.faction.color, 190);
  ctx.fillText(ellipsize(ctx, c.faction.name, w - 60 * u), x + 28 * u, y + 52 * u);
  ctx.font = `500 ${Math.round(30 * u)}px ${FONT_MONO}`;
  ctx.fillStyle = '#dff4fb';
  let ty = y + 98 * u;
  const typed = Math.min(1, life / 0.35);
  let budget = Math.ceil(lines.join(' ').length * typed);
  for (const l of lines) {
    const shown = l.slice(0, Math.max(0, budget));
    budget -= l.length + 1;
    ctx.fillText(shown, x + 28 * u, ty);
    ty += 40 * u;
  }
  ctx.restore();
}

export interface RollRow { faction: FilmFaction; label: string; receipt: string; fallen: boolean; winner: boolean }

/** THE ROLL CALL: every empire back on screen with its role and record,
 *  the fallen first, the winner last. */
export function drawRollCall(ctx: CanvasRenderingContext2D, W: number, H: number,
  title: string, rows: RollRow[], k: number, url: string) {
  if (k <= 0 || !rows.length) return;
  const u = unitOf(H);
  const a = ease(k * 3);
  ctx.save();
  ctx.globalAlpha = a;
  ctx.fillStyle = 'rgba(2,4,9,0.84)';
  ctx.fillRect(0, 0, W, H);
  const n = rows.length;
  const rowH = Math.min(78 * u, (H * 0.7) / Math.max(1, n));
  const w = Math.min(W * 0.86, 1500 * u);
  const x = (W - w) / 2;
  let y = H / 2 - (rowH * n) / 2 + 20 * u;
  ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
  ctx.font = `600 ${Math.round(22 * u)}px ${FONT_MONO}`;
  spacing(ctx, 6 * u);
  ctx.fillStyle = AMBER;
  ctx.fillText(title.toUpperCase(), W / 2, y - 34 * u);
  spacing(ctx, 0);
  const nameW = w * 0.3, roleW = w * 0.25;
  rows.forEach((r, i) => {
    const ki = ease((k - 0.08 - i * (0.6 / Math.max(1, n))) * 6);
    if (ki <= 0.01) { y += rowH; return; }
    ctx.save();
    ctx.globalAlpha = a * ki;
    const cy = y + rowH / 2;
    if (r.winner) {
      ctx.fillStyle = rgba(r.faction.color, 0.22);
      ctx.fillRect(x, y + 4 * u, w, rowH - 8 * u);
    }
    drawEmblem(ctx, r.faction, x + 30 * u, cy, Math.min(24 * u, rowH * 0.32), r.fallen ? 0.55 : 1);
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    const size = Math.round(Math.min(30 * u, rowH * 0.42));
    ctx.font = `600 ${size}px ${FONT_BODY}`;
    ctx.fillStyle = r.fallen ? 'rgba(200,190,196,0.75)' : liftColor(r.faction.color, 190);
    ctx.fillText(ellipsize(ctx, r.faction.name, nameW - 70 * u), x + 66 * u, cy);
    ctx.font = `400 ${Math.round(size * 0.82)}px ${FONT_DISPLAY}`;
    ctx.fillStyle = r.winner ? INK : AMBER;
    ctx.fillText(ellipsize(ctx, r.label, roleW - 20 * u), x + nameW, cy);
    ctx.font = `500 ${Math.round(size * 0.86)}px ${FONT_BODY}`;
    ctx.fillStyle = 'rgba(220,230,242,0.86)';
    ctx.fillText(ellipsize(ctx, r.receipt, w - nameW - roleW - 10 * u), x + nameW + roleW, cy);
    ctx.restore();
    y += rowH;
  });
  if (url) {
    ctx.textAlign = 'center';
    ctx.font = `600 ${Math.round(20 * u)}px ${FONT_MONO}`;
    spacing(ctx, 5 * u);
    ctx.fillStyle = 'rgba(200,216,232,0.7)';
    ctx.fillText(url.toUpperCase(), W / 2, Math.min(H - 40 * u, y + 56 * u));
    spacing(ctx, 0);
  }
  ctx.restore();
}
