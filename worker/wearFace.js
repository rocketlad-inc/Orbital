// ============================================================
// GET /wear/<token>/face/<px>.png -- the Orbital watch face's map.
//
// The face (Watch Face Format) cannot fetch anything, so the watch app
// hands it the map as a PHOTO_IMAGE complication (MapComplication.kt).
// The app used to DRAW that map itself, in flat dots, which meant the
// face never got the game's art and every change to it was an app
// release. It now fetches this picture and keeps its own drawing only as
// the fallback for when the server cannot be reached.
//
// Same layout the app drew, so the face does not jump when it switches:
//   BANDS   one per system, spanning its worlds' distances from the Sun,
//           in the controller's colour; dashed when contested
//   ORBITS  a hairline per world
//   WORLDS  where they are this tick, each drawn FROM ITS GLOBE (the
//           48 px copies scripts/globe-pngs.mjs makes) lit from the Sun,
//           a plain shaded disc where a world has no globe; yours ringed
//           in your colour, a battlefield ringed red
//   SUN     the game's own Sol globe in its glow
// The scale is logarithmic in distance (Mercury to the Far Reach is a
// factor of thirty) and the centre is dimmed, where the face draws time.
// ============================================================

import { authorizeWear } from './wear.js';
import { wearWorldsData } from './wearWorlds.js';
import { parseSpriteKey, globeNameOf, ringed } from './planetSvg.js';
import { rasterSvgPng } from './planetSprite.js';

export const WEAR_FACE_RE = /^\/wear\/([A-Za-z0-9_-]{8,64})\/face\/(\d{3})\.png$/;

const GROUND = '#080c13';
const TROUGH = '#16202c';
const INK = '#e2ecf5';
const ALARM = '#ff6a60';
const CONTESTED = '#6b7280';

const CACHE = new Map();
const CACHE_MAX = 64;

const esc = (s) => String(s).replace(/[^#0-9a-zA-Z]/g, '');

/** The watch's own lift of a faction colour (Theme.kt factionColor):
 *  the same hex, so the face and the app agree. */
function colour(hex, fallback = '#4ecdc4') {
  return /^#[0-9a-fA-F]{6}$/.test(hex || '') ? hex : fallback;
}

/** A small globe from the static assets, as base64, or null. */
async function smallGlobe(req, env, name, memo) {
  if (memo.has(name)) return memo.get(name);
  let b64 = null;
  try {
    const res = await env.ASSETS.fetch(new Request(new URL(`/globes-png/s/${name}.png`, req.url)));
    if (res.ok && (res.headers.get('content-type') || '').includes('png')) {
      const bytes = new Uint8Array(await res.arrayBuffer());
      let bin = '';
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      b64 = btoa(bin);
    }
  } catch (e) {
    console.error('wear face: globe fetch failed', name, e);
  }
  memo.set(name, b64);
  return b64;
}

/** World disc radius on a 320 px face, by type (the app's dot sizes,
 *  enlarged a little: a globe needs a few pixels to read as one). */
function discR(type) {
  switch (type) {
    case 'gas-giant': case 'gas_giant': return 5.6;
    case 'ice-giant': case 'ice_giant': return 5.0;
    case 'terrestrial': return 4.2;
    default: return 2.6;
  }
}

/**
 * The face map as SVG, `size` px square. `globes` maps a globe name to
 * base64 PNG (missing = draw the plain disc). Pure, for the sim.
 */
export function faceSvg(data, size, globes = new Map()) {
  const S = size / 320;
  const c = size / 2;
  const me = data.me;
  const fc = (id) => colour(data.factions?.[id]?.color);
  const systems = (data.systems ?? []).filter(s => (s.bodies ?? []).length);
  const all = systems.flatMap(s => s.bodies);
  const dist = (b) => Math.hypot(b.hx || 0, b.hy || 0);
  const far = Math.max(1, ...all.map(dist)) * 1.04;
  const outer = c * 0.96;
  const k = far / 60;
  const rOf = (d) => outer * Math.log(1 + d / k) / Math.log(1 + far / k);
  const n = (v) => Math.round(v * 100) / 100;

  const defs = [];
  const out = [];
  out.push(`<rect width="${size}" height="${size}" fill="${GROUND}"/>`);

  // Bands, outermost first so an inner band paints over a wide outer one.
  for (const sys of [...systems].sort((a, b) => Math.max(...b.bodies.map(dist)) - Math.max(...a.bodies.map(dist)))) {
    const lo = Math.min(...sys.bodies.map(dist));
    const hi = Math.max(...sys.bodies.map(dist));
    const r0 = rOf(lo) - 5 * S;
    const r1 = rOf(hi) + 5 * S;
    const w = Math.max(6 * S, r1 - r0);
    const mid = (r0 + r1) / 2;
    const [col, a] = sys.controller ? [fc(sys.controller), 0.62]
      : sys.contested ? [CONTESTED, 0.45] : [TROUGH, 0.85];
    out.push(`<circle cx="${c}" cy="${c}" r="${n(mid)}" fill="none" stroke="${esc(col)}" stroke-opacity="${a}" stroke-width="${n(w)}"/>`);
    if (sys.contested) {
      out.push(`<circle cx="${c}" cy="${c}" r="${n(mid)}" fill="none" stroke="${INK}" stroke-opacity="0.35" stroke-width="${n(1.2 * S)}" stroke-dasharray="${n(4 * S)} ${n(4 * S)}"/>`);
    }
  }

  // Orbits.
  for (const b of all) {
    out.push(`<circle cx="${c}" cy="${c}" r="${n(rOf(dist(b)))}" fill="none" stroke="${INK}" stroke-opacity="0.18" stroke-width="${n(0.8 * S)}"/>`);
  }

  // The Sun: its glow, then the game's own Sol globe.
  const sunR = 11 * S;
  defs.push(`<radialGradient id="sunglow"><stop offset="0" stop-color="#fff1b0" stop-opacity="1"/><stop offset="0.45" stop-color="#ffb347" stop-opacity="0.55"/><stop offset="1" stop-color="#ff8a00" stop-opacity="0"/></radialGradient>`);
  out.push(`<circle cx="${c}" cy="${c}" r="${n(sunR * 2.1)}" fill="url(#sunglow)"/>`);
  const sol = globes.get('sol');
  if (sol) {
    defs.push(`<clipPath id="sunclip"><circle cx="${c}" cy="${c}" r="${n(sunR)}"/></clipPath>`);
    out.push(`<image href="data:image/png;base64,${sol}" x="${n(c - sunR)}" y="${n(c - sunR)}" width="${n(sunR * 2)}" height="${n(sunR * 2)}" clip-path="url(#sunclip)"/>`);
  } else {
    out.push(`<circle cx="${c}" cy="${c}" r="${n(sunR)}" fill="#ffd27a"/>`);
  }

  // Worlds.
  let i = 0;
  for (const b of all) {
    const a = Math.atan2(b.hy || 0, b.hx || 0);
    const rr = rOf(dist(b));
    const x = c + Math.cos(a) * rr;
    const y = c + Math.sin(a) * rr;
    const r = discR(b.type) * S;
    const id = `w${i++}`;
    const key = b.sp ? parseSpriteKey(b.sp) : null;
    const gname = key ? globeNameOf(key) : null;
    const g = gname ? globes.get(gname) : null;
    if (key && ringed(key.id)) {
      out.push(`<ellipse cx="${n(x)}" cy="${n(y)}" rx="${n(r * 2.1)}" ry="${n(r * 0.7)}" fill="none" stroke="#d8c8a0" stroke-opacity="0.75" stroke-width="${n(0.9 * S)}" transform="rotate(-18 ${n(x)} ${n(y)})"/>`);
    }
    if (g) {
      defs.push(`<clipPath id="${id}c"><circle cx="${n(x)}" cy="${n(y)}" r="${n(r)}"/></clipPath>`);
      out.push(`<image href="data:image/png;base64,${g}" x="${n(x - r)}" y="${n(y - r)}" width="${n(r * 2)}" height="${n(r * 2)}" clip-path="url(#${id}c)"/>`);
    } else {
      const col = colour(b.color, '#8899aa');
      defs.push(`<radialGradient id="${id}f" cx="0.35" cy="0.35" r="0.85"><stop offset="0" stop-color="#ffffff" stop-opacity="0.35"/><stop offset="0.5" stop-color="${esc(col)}" stop-opacity="0"/></radialGradient>`);
      out.push(`<circle cx="${n(x)}" cy="${n(y)}" r="${n(r)}" fill="${esc(col)}"/>`);
      out.push(`<circle cx="${n(x)}" cy="${n(y)}" r="${n(r)}" fill="url(#${id}f)"/>`);
    }
    // Lit from the Sun: the far side falls into shadow.
    const ux = -Math.cos(a), uy = -Math.sin(a);
    defs.push(`<linearGradient id="${id}t" gradientUnits="userSpaceOnUse" x1="${n(x + ux * r)}" y1="${n(y + uy * r)}" x2="${n(x - ux * r)}" y2="${n(y - uy * r)}"><stop offset="0.35" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.6"/></linearGradient>`);
    out.push(`<circle cx="${n(x)}" cy="${n(y)}" r="${n(r)}" fill="url(#${id}t)"/>`);
    if (b.mine > 0) {
      out.push(`<circle cx="${n(x)}" cy="${n(y)}" r="${n(r + 2.4 * S)}" fill="none" stroke="${esc(fc(me))}" stroke-width="${n(1.4 * S)}"/>`);
    }
    if (b.battle) {
      out.push(`<circle cx="${n(x)}" cy="${n(y)}" r="${n(r + 4.8 * S)}" fill="none" stroke="${ALARM}" stroke-width="${n(1.6 * S)}"/>`);
    }
  }

  // Quiet the middle, where the face draws the time.
  defs.push(`<radialGradient id="quiet"><stop offset="0" stop-color="${GROUND}" stop-opacity="0.78"/><stop offset="1" stop-color="${GROUND}" stop-opacity="0"/></radialGradient>`);
  out.push(`<circle cx="${c}" cy="${c}" r="${n(c * 0.42)}" fill="url(#quiet)"/>`);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"><defs>${defs.join('')}</defs>${out.join('')}</svg>`;
}

/** The globe names a face needs: Sol and every world that has one. */
export function faceGlobeNames(data) {
  const names = new Set(['sol']);
  for (const s of data.systems ?? []) {
    for (const b of s.bodies ?? []) {
      const key = b.sp ? parseSpriteKey(b.sp) : null;
      const g = key ? globeNameOf(key) : null;
      if (g) names.add(g);
    }
  }
  return [...names];
}

export async function handleWearFace(req, env, { params }) {
  const auth = await authorizeWear(env, params.token);
  if (auth.error) return auth.error;
  const px = Math.max(200, Math.min(480, Number(params.px) || 320));
  const data = await wearWorldsData(env, auth.userId);
  if (!data?.systems?.length) return new Response('no map', { status: 404 });

  // A tick changes the picture; nothing else between ticks does that the
  // face can show at this size, so one render per token, tick and size.
  const ck = `${params.token}|${data.tick}|${px}|${data.art}`;
  let png = CACHE.get(ck);
  if (!png) {
    const memo = new Map();
    const globes = new Map();
    await Promise.all(faceGlobeNames(data).map(async (name) => {
      const g = await smallGlobe(req, env, name, memo);
      if (g) globes.set(name, g);
    }));
    png = await rasterSvgPng(faceSvg(data, px, globes), px);
    if (!png) return new Response('face unavailable', { status: 503 });
    if (CACHE.size >= CACHE_MAX) CACHE.delete(CACHE.keys().next().value);
    CACHE.set(ck, png);
  }
  return new Response(png, {
    headers: {
      'content-type': 'image/png',
      'cache-control': 'private, max-age=60',
      'referrer-policy': 'no-referrer',
    },
  });
}
