// ============================================================
// battleHaze — a battle, seen from too far away to see its ships.
//
// Close in, a fight is hulls, beams, blasts and wreckage. Far out the hulls
// are not drawn (hullReveal), and nor should their effects be: a dead
// hull's wreckage, drawn at its close-up size over a world that is a few
// pixels across, read as a giant broken ship appearing over the planet
// (Lorne, 2026-10-24). In their place the PLANE shows the fight: a haze
// of fire round the world that grows with the size of the battle, the two
// sides' colours turning in a contested ring, and a pinprick flash for
// each hull lost, the size of a spark, not of a ship.
//
// Pure drawing in screen pixels; matchMap decides where and how much.
// ============================================================

export interface HazeSide { color: string; share: number }

const hash = (s: string) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
};

function rgba(hex: string, a: number) {
  const h = hex.replace('#', '');
  const n = h.length === 3 ? h.split('').map(c => parseInt(c + c, 16)) : [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16));
  if (n.some(v => Number.isNaN(v))) return `rgba(255,140,80,${a})`;
  return `rgba(${n[0]},${n[1]},${n[2]},${Math.max(0, Math.min(1, a))})`;
}

/**
 * The battle at one world, from a distance.
 *   x, y        the world on screen; r its drawn radius (px)
 *   heat        how big the fight is: hulls lost lately, weighted, plus a
 *               little for hulls massed there (0 = nothing; ~1 a skirmish;
 *               10+ a slaughter)
 *   sides       the empires in it and their shares, for the ring
 *   sparks      losses to flash now: an id (for a stable angle) and 0..1 life
 *   tMs         a clock for the motion; alpha fades it with the zoom
 */
export function drawBattleHaze(ctx: CanvasRenderingContext2D, x: number, y: number, r: number,
  heat: number, sides: HazeSide[], sparks: Array<{ id: string; k: number }>, tMs: number, alpha: number, u = 1) {
  if (alpha <= 0.01 || (heat <= 0.05 && !sparks.length)) return;
  const h = Math.max(0, heat);
  // How far the fire reaches: a skirmish hugs the world, a slaughter
  // spreads well past it. Logarithmic, so 100 losses is not ten times 10.
  const reach = r * (1.35 + 0.55 * Math.log2(1 + h)) + 6 * u;
  const pulse = 0.85 + 0.15 * Math.sin(tMs / 260 + hash(`${x | 0}`) % 7);
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.globalCompositeOperation = 'lighter';
  // The haze: hot at the world, fading out to the reach.
  const g = ctx.createRadialGradient(x, y, r * 0.6, x, y, reach);
  const core = Math.min(0.55, 0.12 + 0.07 * Math.log2(1 + h)) * pulse;
  g.addColorStop(0, `rgba(255,150,70,${core})`);
  g.addColorStop(0.45, `rgba(255,90,40,${core * 0.45})`);
  g.addColorStop(1, 'rgba(255,60,30,0)');
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(x, y, reach, 0, Math.PI * 2); ctx.fill();
  ctx.globalCompositeOperation = 'source-over';
  // The contested ring: each side's share of it, in its colour, turning.
  const ringR = r * 1.25 + 4 * u;
  const total = sides.reduce((a, s) => a + s.share, 0) || 1;
  let a0 = (tMs / 2400) % (Math.PI * 2);
  ctx.lineWidth = Math.max(1.2, 1.5 * u + 0.25 * Math.log2(1 + h) * u);
  ctx.lineCap = 'round';
  for (const s of sides) {
    const span = (s.share / total) * Math.PI * 2;
    const gap = Math.min(0.18, span * 0.2);
    ctx.strokeStyle = rgba(s.color, 0.85);
    ctx.beginPath(); ctx.arc(x, y, ringR, a0 + gap / 2, a0 + span - gap / 2); ctx.stroke();
    a0 += span;
  }
  // The losses: a spark each, the size of a spark.
  ctx.globalCompositeOperation = 'lighter';
  for (const sp of sparks) {
    if (sp.k <= 0 || sp.k >= 1) continue;
    const hh = hash(sp.id);
    const ang = (hh % 6283) / 1000;
    const rr = ringR * (0.95 + ((hh >>> 13) % 100) / 100 * 0.7);
    const px = x + Math.cos(ang) * rr, py = y + Math.sin(ang) * rr;
    const life = 1 - sp.k;
    const sz = (2.2 + 2.6 * Math.sin(Math.PI * Math.min(1, sp.k * 2))) * u;
    const sg = ctx.createRadialGradient(px, py, 0, px, py, sz * 3);
    sg.addColorStop(0, `rgba(255,245,220,${0.95 * life})`);
    sg.addColorStop(0.35, `rgba(255,170,90,${0.6 * life})`);
    sg.addColorStop(1, 'rgba(255,90,40,0)');
    ctx.fillStyle = sg;
    ctx.beginPath(); ctx.arc(px, py, sz * 3, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
}
