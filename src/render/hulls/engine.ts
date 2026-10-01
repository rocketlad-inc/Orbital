// @ts-nocheck -- authored as a data DSL (see engine.ts); the shapes are data, not typed code.
// The hull language. Every ship, capital and structure is authored as a
// list of parts in a 64x64 box, nose toward +x, centreline y = 0 (drawn at
// y = 32). One renderer shades them all from the empire's two tones:
//   primary   -> the hull body (lit top half, base, shadowed plates), drive glow
//   secondary -> trim: livery stripes, panel lines, the dark edge
// Parts mirror across the centreline unless m:false, so a symmetric hull
// is written as its top half only.
//
//   hull(pts)            main body: top-half outline, nose -> tail
//   wing(pts)            polygon (top side, y<0), drawn under the hull
//   pod(x,y,w,h,r)       rounded box centred at (x,y)
//   poly(pts, role)      free polygon; role = base|top|plate|plate2|liv|dark|glass
//   ring(cx,cy,rx,ry,w)  hollow ellipse (habitat rings, halos)
//   disc(cx,cy,r)        lit sphere/disc
//   line(pts, w, role)   polyline (panel lines, struts)
//   glass(pts)           canopy
//   drive(x,y,r)         engine bell + plume (plume trails -x)
//   gun(x,y,len,w)       barrel pointing +x from x
//   turret(x,y,r)        round mount with a barrel
export const hull = (pts, o = {}) => ({ t: 'hull', pts, ...o });
export const wing = (pts, o = {}) => ({ t: 'wing', pts, ...o });
export const pod = (x, y, w, h, r = 1.5, o = {}) => ({ t: 'pod', x, y, w, h, r, ...o });
export const poly = (pts, role = 'plate', o = {}) => ({ t: 'poly', pts, role, ...o });
export const ring = (cx, cy, rx, ry, w = 3, o = {}) => ({ t: 'ring', cx, cy, rx, ry, w, ...o });
export const disc = (cx, cy, r, o = {}) => ({ t: 'disc', cx, cy, r, ...o });
export const line = (pts, w = 0.8, role = 'liv', o = {}) => ({ t: 'line', pts, w, role, ...o });
export const glass = (pts, o = {}) => ({ t: 'glass', pts, ...o });
export const drive = (x, y, r = 2.2, o = {}) => ({ t: 'drive', x, y, r, ...o });
export const gun = (x, y, len, w = 1.2, o = {}) => ({ t: 'gun', x, y, len, w, ...o });
export const turret = (x, y, r = 2, o = {}) => ({ t: 'turret', x, y, r, ...o });

// curve helpers -> point arrays
export function bez(p0, p1, p2, n = 8) {
  const out = [];
  for (let i = 0; i <= n; i++) { const t = i / n, u = 1 - t; out.push([u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0], u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1]]); }
  return out;
}
export function arc(cx, cy, r, a0, a1, n = 10, ry = r) {
  const out = [];
  for (let i = 0; i <= n; i++) { const a = (a0 + (a1 - a0) * i / n) * Math.PI / 180; out.push([cx + Math.cos(a) * r, cy + Math.sin(a) * ry]); }
  return out;
}

const Y0 = 32;
const f = (v) => +v.toFixed(2);
const P = (pts) => pts.map(([x, y]) => `${f(x)},${f(Y0 + y)}`).join(' ');
const mir = (pts) => pts.map(([x, y]) => [x, -y]);
const isMirrored = (p, defaultOn = true) => p.m === undefined ? defaultOn : p.m;

// palette: concrete hexes (sheet renders) or var(--h*) strings (map)
const mix = (a, b, t) => { const q = (h) => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16)); const x = q(a), y = q(b); return '#' + x.map((v, i) => Math.round(v + (y[i] - v) * t).toString(16).padStart(2, '0')).join(''); };
export function palette(primary, secondary) {
  const s2 = secondary || mix(primary, '#000000', 0.78);
  return {
    top: mix(primary, '#ffffff', 0.14), base: mix(primary, '#000000', 0.38), plate: mix(primary, '#000000', 0.58),
    plate2: mix(primary, '#000000', 0.22), liv: s2, edge: mix(s2, '#000000', 0.6), bevel: mix(primary, '#ffffff', 0.6),
    glow: mix(primary, '#ffffff', 0.35), dark: mix(s2, '#000000', 0.25), glass: '#e8f8ff',
  };
}
export const VARS = { top: 'var(--ht)', base: 'var(--hb)', plate: 'var(--hp)', plate2: 'var(--hq)', liv: 'var(--hs)', edge: 'var(--he)', bevel: 'var(--hl)', glow: 'var(--hg)', dark: 'var(--hd)', glass: '#e8f8ff' };

// Render one design (array of parts) to SVG markup with palette C.
export function render(parts, C) {
  const L = { plume: [], under: [], wings: [], pods: [], body: [], detail: [], top: [] };
  const edge = `stroke="${C.edge}" stroke-width="1.3" stroke-linejoin="round"`;
  const bevel = (pts) => `<polygon points="${P(pts)}" fill="none" stroke="${C.bevel}" stroke-width="0.45" stroke-linejoin="round" opacity="0.5"/>`;
  for (const p of parts) {
    switch (p.t) {
      case 'hull': {
        if (p.m === false) {
          const lit = p.pts.reduce((a, q) => a + q[1], 0) < 0;
          L.body.push(`<polygon points="${P(p.pts)}" fill="${lit ? C.top : C.base}" ${edge}/>`);
          L.body.push(bevel(p.pts));
          break;
        }
        const up = p.pts[0][1] === 0 ? p.pts : [[p.pts[0][0], 0], ...p.pts];
        const full = [...up, ...mir(up.slice().reverse())];
        const topHalf = [...up, [up[up.length - 1][0], 0]];
        L.body.push(`<polygon points="${P(full)}" fill="${C.base}" ${edge}/>`);
        L.body.push(`<polygon points="${P(topHalf)}" fill="${C.top}"/>`);
        L.body.push(bevel(full));
        if (p.spine !== false) L.body.push(`<line x1="${f(up[0][0] - 2)}" y1="${Y0}" x2="${f(up[up.length - 1][0] + 1)}" y2="${Y0}" stroke="${C.plate}" stroke-width="0.7" opacity="0.8"/>`);
        break;
      }
      case 'wing': {
        const pts = p.pts;
        L.wings.push(`<polygon points="${P(pts)}" fill="${C.plate2}" ${edge}/>`);
        L.wings.push(bevel(pts));
        if (isMirrored(p)) { L.wings.push(`<polygon points="${P(mir(pts))}" fill="${C.plate}" ${edge}/>`); }
        break;
      }
      case 'pod': {
        const one = (y, lit) => `<rect x="${f(p.x - p.w / 2)}" y="${f(Y0 + y - p.h / 2)}" width="${f(p.w)}" height="${f(p.h)}" rx="${f(p.r)}" fill="${lit ? C.plate2 : C.plate}" ${edge}/><rect x="${f(p.x - p.w / 2 + 0.8)}" y="${f(Y0 + y - p.h / 2 + 0.7)}" width="${f(Math.max(0.5, p.w - 1.6))}" height="${f(Math.max(0.5, p.h * 0.35))}" rx="${f(p.r * 0.6)}" fill="${C.top}" opacity="0.55"/>`;
        const tg = p.layer === 'top' ? L.detail : L.pods;
        if (!isMirrored(p)) tg.push(one(p.y, p.y <= 0));
        else { tg.push(one(-Math.abs(p.y), true)); if (p.y !== 0) tg.push(one(Math.abs(p.y), false)); }
        break;
      }
      case 'poly': {
        const col = C[p.role] || p.role;
        const st = p.role === 'plate' || p.role === 'plate2' || p.role === 'dark' ? `stroke="${C.edge}" stroke-width="0.6" stroke-linejoin="round"` : '';
        const tgt = p.layer === 'under' ? L.under : p.layer === 'wings' ? L.wings : p.layer === 'top' ? L.top : L.detail;
        tgt.push(`<polygon points="${P(p.pts)}" fill="${col}" ${st} ${p.op ? `opacity="${p.op}"` : ''}/>`);
        if (isMirrored(p) && p.pts.some(([, y]) => Math.abs(y) > 0.01)) tgt.push(`<polygon points="${P(mir(p.pts))}" fill="${col}" ${st} ${p.op ? `opacity="${p.op}"` : ''}/>`);
        break;
      }
      case 'ring': {
        const tgt = p.layer === 'top' ? L.detail : L.under;
        tgt.push(`<ellipse cx="${f(p.cx)}" cy="${f(Y0 + p.cy)}" rx="${f(p.rx)}" ry="${f(p.ry)}" fill="none" stroke="${C.edge}" stroke-width="${f(p.w + 1.6)}"/>`);
        tgt.push(`<ellipse cx="${f(p.cx)}" cy="${f(Y0 + p.cy)}" rx="${f(p.rx)}" ry="${f(p.ry)}" fill="none" stroke="${C.base}" stroke-width="${f(p.w)}"/>`);
        tgt.push(`<path d="M${f(p.cx - p.rx)} ${f(Y0 + p.cy)} A${f(p.rx)} ${f(p.ry)} 0 0 1 ${f(p.cx + p.rx)} ${f(Y0 + p.cy)}" fill="none" stroke="${C.top}" stroke-width="${f(p.w * 0.55)}" opacity="0.85"/>`);
        if (p.dash !== false) tgt.push(`<ellipse cx="${f(p.cx)}" cy="${f(Y0 + p.cy)}" rx="${f(p.rx)}" ry="${f(p.ry)}" fill="none" stroke="${C.liv}" stroke-width="0.9" stroke-dasharray="2.2 2.6"/>`);
        break;
      }
      case 'disc': {
        const tgt = p.layer === 'under' ? L.under : p.layer === 'top' ? L.top : L.body;
        tgt.push(`<circle cx="${f(p.cx)}" cy="${f(Y0 + p.cy)}" r="${f(p.r)}" fill="${C.base}" ${edge}/>`);
        tgt.push(`<path d="M${f(p.cx - p.r)} ${f(Y0 + p.cy)} A${f(p.r)} ${f(p.r)} 0 0 1 ${f(p.cx + p.r)} ${f(Y0 + p.cy)} Z" fill="${C.top}"/>`);
        tgt.push(`<circle cx="${f(p.cx)}" cy="${f(Y0 + p.cy)}" r="${f(p.r)}" fill="none" stroke="${C.bevel}" stroke-width="0.45" opacity="0.5"/>`);
        if (p.core) tgt.push(`<circle cx="${f(p.cx)}" cy="${f(Y0 + p.cy)}" r="${f(p.r * 0.38)}" fill="${C.glow}"/><circle cx="${f(p.cx)}" cy="${f(Y0 + p.cy)}" r="${f(p.r * 0.18)}" fill="#fff"/>`);
        break;
      }
      case 'line': {
        const col = C[p.role] || p.role;
        const d = (pts) => 'M' + pts.map(([x, y]) => `${f(x)} ${f(Y0 + y)}`).join(' L');
        const tgt = p.layer === 'under' ? L.under : p.layer === 'wings' ? L.wings : L.detail;
        tgt.push(`<path d="${d(p.pts)}" fill="none" stroke="${col}" stroke-width="${p.w}" stroke-linecap="round" stroke-linejoin="round"/>`);
        if (isMirrored(p) && p.pts.some(([, y]) => Math.abs(y) > 0.01)) tgt.push(`<path d="${d(mir(p.pts))}" fill="none" stroke="${col}" stroke-width="${p.w}" stroke-linecap="round" stroke-linejoin="round"/>`);
        break;
      }
      case 'glass': {
        L.top.push(`<polygon points="${P(p.pts)}" fill="${C.glass}" stroke="${C.edge}" stroke-width="0.5"/>`);
        if (p.m === true) L.top.push(`<polygon points="${P(mir(p.pts))}" fill="${C.glass}" stroke="${C.edge}" stroke-width="0.5" opacity="0.8"/>`);
        break;
      }
      case 'drive': {
        const one = (y) => {
          L.plume.push(`<ellipse cx="${f(p.x - p.r * 1.9)}" cy="${f(Y0 + y)}" rx="${f(p.r * 2.8)}" ry="${f(p.r * 0.9)}" fill="${C.glow}" opacity="0.28"/><ellipse cx="${f(p.x - p.r * 0.9)}" cy="${f(Y0 + y)}" rx="${f(p.r * 1.5)}" ry="${f(p.r * 0.6)}" fill="${C.glow}" opacity="0.7"/>`);
          L.top.push(`<rect x="${f(p.x - 0.6)}" y="${f(Y0 + y - p.r * 0.95)}" width="${f(p.r * 0.9)}" height="${f(p.r * 1.9)}" rx="0.6" fill="${C.plate}" stroke="${C.edge}" stroke-width="0.6"/><ellipse cx="${f(p.x - 0.2)}" cy="${f(Y0 + y)}" rx="${f(p.r * 0.45)}" ry="${f(p.r * 0.62)}" fill="#fff"/>`);
        };
        if (!isMirrored(p)) one(p.y); else { one(-Math.abs(p.y)); if (p.y !== 0) one(Math.abs(p.y)); }
        break;
      }
      case 'gun': {
        const one = (y) => L.under.push(`<rect x="${f(p.x)}" y="${f(Y0 + y - p.w / 2)}" width="${f(p.len)}" height="${f(p.w)}" rx="${f(p.w * 0.3)}" fill="${C.plate}" stroke="${C.edge}" stroke-width="0.5"/>`);
        if (!isMirrored(p)) one(p.y); else { one(-Math.abs(p.y)); if (p.y !== 0) one(Math.abs(p.y)); }
        break;
      }
      case 'turret': {
        const one = (y) => L.top.push(`<rect x="${f(p.x)}" y="${f(Y0 + y - 0.45)}" width="${f(p.r * 2.1)}" height="0.9" fill="${C.plate}" stroke="${C.edge}" stroke-width="0.35"/><circle cx="${f(p.x)}" cy="${f(Y0 + y)}" r="${f(p.r)}" fill="${C.plate2}" stroke="${C.edge}" stroke-width="0.6"/><circle cx="${f(p.x - p.r * 0.25)}" cy="${f(Y0 + y - p.r * 0.25)}" r="${f(p.r * 0.45)}" fill="${C.top}" opacity="0.7"/>`);
        if (!isMirrored(p)) one(p.y); else { one(-Math.abs(p.y)); if (p.y !== 0) one(Math.abs(p.y)); }
        break;
      }
    }
  }
  return [...L.plume, ...L.under, ...L.wings, ...L.pods, ...L.body, ...L.detail, ...L.top].join('');
}

export function svg(parts, C, size, extra = '') {
  return `<svg width="${size}" height="${size}" viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" ${extra}>${render(parts, C)}</svg>`;
}
