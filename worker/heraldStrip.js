// ============================================================================
// heraldStrip.js — the Herald's territory chart.
//
// A horizontal ownership strip: Sol at the left edge, sectors running
// left to right, each sector washed in its controlling empire's colour
// with the holder named underneath, and moons hanging in a column below
// their parent. Designed for Discord's wide embed, where the circular
// game map is illegible at thumbnail size (everything crushes into the
// centre).
//
// WHY AN HTML PAGE AND NOT A SERVER-SIDE RASTER:
//   Workers have no canvas and no font engine. Shapes I could rasterise
//   by hand and PNG-encode via CompressionStream, but the design calls
//   for TEXT — sector names, empire names — and hand-rolling a font is
//   where that approach turns ugly. So the chart is a real HTML page
//   drawing to a real canvas, and the PNG comes from screenshotting it.
//
// THE PAGE IS USEFUL ON ITS OWN. Even with no screenshot binding
// configured, /herald/:gameId/strip is a shareable live view of who
// holds what — so this ships value before any plan change, and the
// image path lights up the moment a BROWSER binding appears.
//
// Fog: deliberately NONE. The Herald is published to a shared channel,
// so it shows the public board. Never render a single player's fogged
// view here — that would leak their private intel to everyone.
// ============================================================================

/** Mirrors src/game/systemGrouping.ts CORE_MEMBER_IDS. Two lists that
 *  disagree about what "The Core" contains is worse than not grouping,
 *  so this is a deliberate, commented duplicate rather than an accident. */
const CORE_TEMPLATES = new Set(['sol', 'mercury', 'venus']);
const CORE_LABEL = 'The Core';

/** Rocks with no meaningful individual identity get pooled by orbit
 *  band rather than each claiming a sector column of its own. */
function beltLabelFor(orbitRadius) {
  if (orbitRadius < 900) return 'Asteroid Belt';
  return 'Kuiper Reach';
}

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

/**
 * Everything the chart needs, in one shape. Ownership prefers an explicit
 * body owner and falls back to whoever has a settlement there — the same
 * two sources the in-game map reconciles.
 */
export async function buildTerritoryData(env, gameId) {
  const game = await env.DB
    .prepare(
      `SELECT g.id, g.current_tick, g.status, r.name
         FROM games g JOIN rooms r ON r.id = g.id
        WHERE g.id = ?`,
    )
    .bind(gameId)
    .first();
  if (!game) return null;

  const factionRows = (await env.DB
    .prepare(
      `SELECT id, name, color, color2, status
         FROM game_factions WHERE game_id = ? ORDER BY slot`,
    )
    .bind(gameId)
    .all()).results ?? [];

  const bodyRows = (await env.DB
    .prepare(
      `SELECT b.id, b.template_id, b.name, b.type, b.parent_body_id,
              b.orbit_radius, b.owner_faction_id,
              (SELECT s.owner_faction_id FROM game_settlements s
                WHERE s.body_id = b.id LIMIT 1) AS settle_owner
         FROM game_bodies b
        WHERE b.game_id = ?
        ORDER BY b.orbit_radius`,
    )
    .bind(gameId)
    .all()).results ?? [];

  const factions = {};
  for (const f of factionRows) {
    factions[f.id] = { name: f.name, color: f.color, color2: f.color2 || f.color };
  }

  const byId = new Map(bodyRows.map(b => [b.id, b]));
  const ownerOf = (b) => b.owner_faction_id || b.settle_owner || null;

  // Star + heliocentric bodies + their moons.
  const star = bodyRows.find(b => b.type === 'star' || !b.parent_body_id);
  const heliocentric = bodyRows.filter(
    b => b.parent_body_id && b.parent_body_id === star?.id);
  const moonsOf = (parentId) =>
    bodyRows.filter(b => b.parent_body_id === parentId)
      .sort((a, b) => (a.orbit_radius ?? 0) - (b.orbit_radius ?? 0))
      .map(m => ({ name: m.name, owner: ownerOf(m) }));

  // ---- sector assembly --------------------------------------------------
  // A "sector" is a planet and its moons, EXCEPT: the inner three collapse
  // into The Core (matching the game's own grouping), and small rocks pool
  // into belt bands so 20 dwarf planets don't each claim a column.
  const sectors = [];
  const coreBodies = [];
  const belts = new Map();

  for (const b of heliocentric) {
    const owner = ownerOf(b);
    const entry = {
      name: b.name,
      owner,
      orbitRadius: b.orbit_radius ?? 0,
      kind: b.type === 'gas-giant' || b.type === 'ice-giant' ? 'g'
        : b.type === 'terrestrial' ? 'p' : 'd',
    };
    if (CORE_TEMPLATES.has(b.template_id)) { coreBodies.push(entry); continue; }

    const moons = moonsOf(b.id);
    const isRock = entry.kind === 'd' && moons.length === 0;
    if (isRock) {
      const label = beltLabelFor(entry.orbitRadius);
      if (!belts.has(label)) belts.set(label, []);
      belts.get(label).push(entry);
      continue;
    }
    sectors.push({
      label: b.name,
      order: entry.orbitRadius,
      weight: moons.length >= 4 ? 1.15 : 1.0,
      bodies: [entry],
      moons,
    });
  }

  if (coreBodies.length) {
    const starOwner = star ? ownerOf(star) : null;
    sectors.push({
      label: CORE_LABEL,
      order: -1,
      weight: 1.4,
      bodies: coreBodies,
      moons: [],
      starOwner,
    });
  }
  for (const [label, bodies] of belts) {
    // Order a pooled band by its MEDIAN radius, not its innermost rock.
    // Kuiper's nearest object (Black Sky, 2200) sits inside Neptune's
    // orbit, so min() sorted the whole outer reach in front of Neptune.
    const radii = bodies.map(b => b.orbitRadius).sort((x, y) => x - y);
    sectors.push({
      label,
      order: radii[Math.floor(radii.length / 2)],
      weight: Math.min(1.9, 0.9 + bodies.length * 0.09),
      bodies,
      moons: [],
    });
  }
  sectors.sort((a, b) => a.order - b.order);

  return {
    game: { id: game.id, name: game.name, tick: game.current_tick, status: game.status },
    factions,
    sectors,
    starOwner: star ? ownerOf(star) : null,
    bodyCount: bodyRows.length,
  };
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

/**
 * Self-contained HTML that draws the chart. No external requests — the
 * screenshotter must never wait on a CDN, and the page has to render
 * identically whether a human or headless Chrome loads it.
 *
 * `#strip` carries a data-ready attribute once drawing finishes, so the
 * screenshot step waits for a real frame instead of guessing a delay.
 */
export function renderStripPage(data, opts = {}) {
  const W = opts.width ?? 1200;
  const H = opts.height ?? 420;
  const payload = JSON.stringify(data).replace(/</g, '\\u003c');
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${escapeHtml(data.game.name)} — Territory</title>
<style>
  html,body{margin:0;padding:0;background:#06090F;}
  #strip{display:block;width:${W}px;height:${H}px;}
  body{width:${W}px;}
</style></head>
<body>
<canvas id="strip"></canvas>
<script>
const D = ${payload};
const W = ${W}, H = ${H};

function hexA(hex,a){
  const h=String(hex||"#888").replace("#","");
  const r=parseInt(h.slice(0,2),16)||136,g=parseInt(h.slice(2,4),16)||136,b=parseInt(h.slice(4,6),16)||136;
  return "rgba("+r+","+g+","+b+","+a+")";
}
function shortName(n){
  return String(n||"").replace(/[^\\w\\s'-]/g," ").replace(/\\s+/g," ").trim()
          .replace(/^(the|a)\\s+/i,"").toUpperCase();
}
function fitText(c,text,maxW){
  if(c.measureText(text).width<=maxW) return text;
  const words=text.split(" "); let out="";
  for(const w of words){
    const next=out?out+" "+w:w;
    if(c.measureText(next+"\\u2026").width>maxW) break;
    out=next;
  }
  if(!out){ out=text; while(out.length>1&&c.measureText(out+"\\u2026").width>maxW) out=out.slice(0,-1); }
  return out+"\\u2026";
}
function dominant(sec){
  const tally={};
  const all=[...sec.bodies.map(b=>b.owner),...(sec.moons||[]).map(m=>m.owner)];
  if(sec.starOwner) all.push(sec.starOwner);
  for(const o of all) if(o) tally[o]=(tally[o]||0)+1;
  let best=null,n=0,tie=false;
  for(const k in tally){ if(tally[k]>n){best=k;n=tally[k];tie=false;} else if(tally[k]===n) tie=true; }
  return {owner:best,contested:tie&&!!best};
}

const cv=document.getElementById("strip");
const dpr=2;
cv.width=W*dpr; cv.height=H*dpr;
const c=cv.getContext("2d");
c.setTransform(dpr,0,0,dpr,0,0);

c.fillStyle="#06090F"; c.fillRect(0,0,W,H);
c.strokeStyle="rgba(78,205,196,.05)"; c.lineWidth=1;
for(let x=0;x<W;x+=44){c.beginPath();c.moveTo(x+.5,0);c.lineTo(x+.5,H);c.stroke();}
for(let y=0;y<H;y+=44){c.beginPath();c.moveTo(0,y+.5);c.lineTo(W,y+.5);c.stroke();}

const padL=100,padR=28,axisY=H*0.52,span=W-padL-padR;
const totalW=D.sectors.reduce((a,s)=>a+s.weight,0)||1;
let cursor=padL; const bands=[];
for(const s of D.sectors){ const w=span*(s.weight/totalW); bands.push({s,x0:cursor,x1:cursor+w}); cursor+=w; }

// sector wash
for(const {s,x0,x1} of bands){
  const d=dominant(s); if(!d.owner) continue;
  const col=(D.factions[d.owner]||{}).color||"#888";
  const g=c.createLinearGradient(0,axisY-H*0.42,0,axisY+H*0.42);
  g.addColorStop(0,hexA(col,0));
  g.addColorStop(.42,hexA(col,d.contested?.13:.22));
  g.addColorStop(.58,hexA(col,d.contested?.13:.22));
  g.addColorStop(1,hexA(col,0));
  c.fillStyle=g;
  const pad=5, bw=Math.max(2,(x1-x0)-pad*2);
  c.fillRect(x0+pad,0,bw,H);
  if(d.contested){
    c.save(); c.beginPath(); c.rect(x0+pad,0,bw,H); c.clip();
    c.strokeStyle=hexA(col,.16); c.lineWidth=2;
    for(let x=x0-H;x<x1+H;x+=11){c.beginPath();c.moveTo(x,H);c.lineTo(x+H,0);c.stroke();}
    c.restore();
  }
}

// the star
const sunOwner=D.starOwner, sunCol=(D.factions[sunOwner]||{}).color||"#FFC24A";
const sunR=H*0.46;
const sg=c.createRadialGradient(6,axisY,4,6,axisY,sunR);
sg.addColorStop(0,"rgba(255,236,180,.95)");
sg.addColorStop(.45,hexA(sunCol,.42));
sg.addColorStop(1,"rgba(255,194,74,0)");
c.fillStyle=sg; c.beginPath(); c.arc(6,axisY,sunR,0,Math.PI*2); c.fill();
c.strokeStyle=hexA(sunCol,.85); c.lineWidth=2;
c.beginPath(); c.arc(6,axisY,sunR*0.42,0,Math.PI*2); c.stroke();
c.font='700 11px ui-monospace, Menlo, Consolas, monospace';
c.fillStyle="#FFD98A"; c.textAlign="left"; c.textBaseline="alphabetic";
c.fillText("SOL",20,axisY+4);
if(sunOwner){
  c.font='600 9px ui-monospace, Menlo, Consolas, monospace';
  c.fillStyle=hexA(sunCol,.95);
  c.fillText(fitText(c,shortName((D.factions[sunOwner]||{}).name),74),20,axisY+17);
}

// sectors
for(const {s,x0,x1} of bands){
  const cx=(x0+x1)/2, d=dominant(s), bandW=(x1-x0)-8;

  c.textAlign="center"; c.textBaseline="alphabetic";
  c.font='700 10px ui-monospace, Menlo, Consolas, monospace';
  c.fillStyle=d.owner?hexA((D.factions[d.owner]||{}).color,.92):"rgba(147,163,184,.7)";
  c.fillText(fitText(c,s.label.toUpperCase().split("").join(" "),bandW),cx,22);

  // who holds it — the line that turns a colour into a claim
  c.font='700 9px ui-monospace, Menlo, Consolas, monospace';
  if(d.contested){
    c.fillStyle="rgba(255,194,74,.92)";
    c.fillText("CONTESTED",cx,35);
  } else if(d.owner){
    c.fillStyle=hexA((D.factions[d.owner]||{}).color,.95);
    c.fillText(fitText(c,shortName((D.factions[d.owner]||{}).name),bandW),cx,35);
  } else {
    c.fillStyle="rgba(95,113,134,.8)";
    c.fillText("UNCLAIMED",cx,35);
  }

  const many=s.bodies.length>1;
  s.bodies.forEach((b,i)=>{
    let bx=cx,by=axisY;
    if(many){
      const cols=Math.ceil(s.bodies.length/3), col=Math.floor(i/3), row=i%3;
      const gapX=Math.min(26,(x1-x0)/(cols+1));
      bx=cx+(col-(cols-1)/2)*gapX; by=axisY+(row-1)*22;
    }
    const r=b.kind==="g"?15:b.kind==="p"?10:4.5;
    const col=b.owner?((D.factions[b.owner]||{}).color||"#888"):"#4A5A6B";
    if(b.owner){ c.fillStyle=hexA(col,.18); c.beginPath(); c.arc(bx,by,r+5,0,Math.PI*2); c.fill(); }
    c.fillStyle=b.owner?col:"#26333F";
    c.beginPath(); c.arc(bx,by,r,0,Math.PI*2); c.fill();
    c.strokeStyle=b.owner?hexA(col,.9):"rgba(147,163,184,.45)"; c.lineWidth=1.5;
    c.beginPath(); c.arc(bx,by,r,0,Math.PI*2); c.stroke();
    if(b.kind==="g"){
      c.strokeStyle=b.owner?hexA(col,.5):"rgba(147,163,184,.3)"; c.lineWidth=1.5;
      c.beginPath(); c.ellipse(bx,by,r*1.85,r*0.42,-0.32,0,Math.PI*2); c.stroke();
    }
    if(!many){
      c.font='600 9.5px ui-monospace, Menlo, Consolas, monospace';
      c.fillStyle="rgba(231,238,246,.82)"; c.textAlign="center";
      c.fillText(fitText(c,b.name.toUpperCase(),bandW),bx,by-r-9);
    }
  });
  if(many){
    c.font='600 9px ui-monospace, Menlo, Consolas, monospace';
    c.fillStyle="rgba(147,163,184,.75)"; c.textAlign="center";
    c.fillText(s.bodies.length+" BODIES",cx,axisY-46);
  }

  if(s.moons&&s.moons.length){
    s.moons.forEach((m,i)=>{
      const my=axisY+40+i*17;
      const col=m.owner?((D.factions[m.owner]||{}).color||"#888"):"#39485A";
      c.fillStyle=col; c.beginPath(); c.arc(cx,my,3.6,0,Math.PI*2); c.fill();
      c.strokeStyle="rgba(6,9,15,.9)"; c.lineWidth=1;
      c.beginPath(); c.arc(cx,my,3.6,0,Math.PI*2); c.stroke();
      c.font='500 8.5px ui-monospace, Menlo, Consolas, monospace';
      c.fillStyle="rgba(147,163,184,.7)"; c.textAlign="left";
      c.fillText(m.name.toUpperCase(),cx+8,my+3);
    });
    c.strokeStyle="rgba(147,163,184,.18)"; c.lineWidth=1;
    c.beginPath(); c.moveTo(cx,axisY+18); c.lineTo(cx,axisY+23+s.moons.length*17-17); c.stroke();
  }
}

c.strokeStyle="rgba(78,205,196,.18)"; c.lineWidth=1;
c.beginPath(); c.moveTo(padL,H-26); c.lineTo(W-padR,H-26); c.stroke();
c.font='600 9px ui-monospace, Menlo, Consolas, monospace';
c.fillStyle="rgba(95,113,134,.95)"; c.textAlign="left";
c.fillText((D.game.name+" \\u00b7 TICK "+D.game.tick+" \\u00b7 "+D.bodyCount+" BODIES").toUpperCase(),padL,H-12);
c.textAlign="right";
c.fillText("ORBITAL HERALD",W-padR,H-12);

// Signals the screenshotter that a real frame exists — waiting on this
// beats guessing a sleep duration.
cv.setAttribute("data-ready","1");
</script>
</body></html>`;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, ch => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

// ---------------------------------------------------------------------------
// PNG (optional — needs a Browser Rendering binding)
// ---------------------------------------------------------------------------

/**
 * Screenshot the strip page. Returns an ArrayBuffer, or null when no
 * BROWSER binding is configured — callers fall back to linking the page.
 * Never throws: the Herald must publish even if imaging fails.
 */
export async function renderStripPng(env, gameId, opts = {}) {
  if (!env.BROWSER) return null;
  let browser = null;
  try {
    const puppeteer = await import('@cloudflare/puppeteer');
    browser = await puppeteer.launch(env.BROWSER);
    const page = await browser.newPage();
    const W = opts.width ?? 1200;
    const H = opts.height ?? 420;
    await page.setViewport({ width: W, height: H, deviceScaleFactor: 2 });
    const data = await buildTerritoryData(env, gameId);
    if (!data) return null;
    await page.setContent(renderStripPage(data, { width: W, height: H }),
      { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#strip[data-ready="1"]', { timeout: 8000 });
    const el = await page.$('#strip');
    const shot = await el.screenshot({ type: 'png' });
    return shot;
  } catch (e) {
    console.error('herald strip screenshot failed', e);
    return null;
  } finally {
    try { if (browser) await browser.close(); } catch { /* best effort */ }
  }
}

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

export async function handleStripPage(req, env, { params }) {
  const data = await buildTerritoryData(env, params.gameId);
  if (!data) {
    return new Response('no such game', { status: 404 });
  }
  const url = new URL(req.url);
  const width = Math.max(600, Math.min(2400, Number(url.searchParams.get('w')) || 1200));
  const height = Math.max(260, Math.min(1200, Number(url.searchParams.get('h')) || 420));
  return new Response(renderStripPage(data, { width, height }), {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      // Short cache: the board moves once a tick, and a stale territory
      // chart is misleading in a way a stale marketing page is not.
      'cache-control': 'public, max-age=60',
    },
  });
}

// NOTE: deliberately NOT registered in FEATURE_MODULES. Feature routes
// only dispatch under /api/*, and this page is meant to be shared with
// people — "/herald/<game>/strip" reads like a link, "/api/herald/..."
// reads like plumbing. index.js matches it directly, ahead of the /api
// gate. See STRIP_PATH there.
export const STRIP_RE = /^\/herald\/([^/]+)\/strip$/;
