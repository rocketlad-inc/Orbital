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

  // Bodies with live fighting. Ships stamp last_combat_tick when they
  // FIRE and settlements when they take or return fire, so the union of
  // the two is "something shot here". A 3-tick window, not just the
  // current tick: combat resolves during the tick, so an exact match
  // would only ever catch a fight in the instant it was resolved and
  // the Herald would almost always show a peaceful map.
  const COMBAT_WINDOW_TICKS = 3;
  const combatRows = (await env.DB
    .prepare(
      `SELECT x.bid AS body_id, MAX(x.lct) AS last_tick
         FROM (
           SELECT parent_body_id AS bid, last_combat_tick AS lct
             FROM game_ships
            WHERE game_id = ?1 AND last_combat_tick IS NOT NULL
           UNION ALL
           SELECT body_id AS bid, last_combat_tick AS lct
             FROM game_settlements
            WHERE game_id = ?1 AND last_combat_tick IS NOT NULL
         ) x
        WHERE x.bid IS NOT NULL AND x.lct >= ?2
        GROUP BY x.bid`,
    )
    .bind(gameId, (game.current_tick ?? 0) - COMBAT_WINDOW_TICKS)
    .all()).results ?? [];
  const combatBodies = new Set(combatRows.map(r => r.body_id));

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
      .map(m => ({ name: m.name, owner: ownerOf(m), combat: combatBodies.has(m.id) }));

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
      combat: combatBodies.has(b.id),
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
    starCombat: star ? combatBodies.has(star.id) : false,
    bodyCount: bodyRows.length,
    combatCount: combatBodies.size,
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
  // Discord renders embed images at roughly 550 CSS px. A chart laid out
  // for 1200 and scaled down halves every font - 9px type became ~4px,
  // and the first live post was unreadable. Below this width the chart
  // switches to a two-row layout with larger type, and the caller renders
  // AT that size (device-pixel-ratio buys crispness, never more room).
  const compact = W < 760;
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
const W = ${W}, H = ${H}, COMPACT = ${compact};

function hexA(hex,a){
  const h=String(hex||"#888").replace("#","");
  const r=parseInt(h.slice(0,2),16)||136,g=parseInt(h.slice(2,4),16)||136,b=parseInt(h.slice(4,6),16)||136;
  return "rgba("+r+","+g+","+b+","+a+")";
}
function shortName(n){
  return String(n||"").replace(/[^\w\s'-]/g," ").replace(/\s+/g," ").trim()
          .replace(/^(the|a)\s+/i,"").toUpperCase();
}
function fitText(c,text,maxW){
  var t=String(text);
  if(c.measureText(t).width<=maxW) return t;
  var words=t.split(" "), out="";
  for(var i=0;i<words.length;i++){
    var next=out?out+" "+words[i]:words[i];
    if(c.measureText(next+"…").width>maxW) break;
    out=next;
  }
  if(!out){ out=t; while(out.length>1&&c.measureText(out+"…").width>maxW) out=out.slice(0,-1); }
  return out+"…";
}
function dominant(sec){
  var tally={}, all=sec.bodies.map(function(b){return b.owner;})
    .concat((sec.moons||[]).map(function(m){return m.owner;}));
  if(sec.starOwner) all.push(sec.starOwner);
  all.forEach(function(o){ if(o) tally[o]=(tally[o]||0)+1; });
  var best=null,n=0,tie=false;
  for(var k in tally){ if(tally[k]>n){best=k;n=tally[k];tie=false;} else if(tally[k]===n) tie=true; }
  return {owner:best,contested:tie&&!!best};
}
// Two hulls trading fire: prows facing each other with a bolt between.
// Drawn as pure geometry (no glyph) so it renders identically wherever
// the page is screenshotted, and stays legible down to ~13px wide where
// an emoji would turn to mush.
function drawCombatIcon(x, y, size){
  var h = size*0.42, gap = size*0.20;
  c.save();
  c.translate(x,y);
  // soft heat behind, so the mark reads before the eye resolves it
  var glow=c.createRadialGradient(0,0,0,0,0,size*0.85);
  glow.addColorStop(0,"rgba(255,110,70,.55)");
  glow.addColorStop(1,"rgba(255,110,70,0)");
  c.fillStyle=glow; c.beginPath(); c.arc(0,0,size*0.85,0,Math.PI*2); c.fill();
  // left hull, prow right
  c.fillStyle="#FFE6C2";
  c.beginPath(); c.moveTo(-gap,0); c.lineTo(-size*0.5,-h*0.5); c.lineTo(-size*0.5,h*0.5);
  c.closePath(); c.fill();
  // right hull, prow left
  c.beginPath(); c.moveTo(gap,0); c.lineTo(size*0.5,-h*0.5); c.lineTo(size*0.5,h*0.5);
  c.closePath(); c.fill();
  // the exchange
  c.strokeStyle="#FF5A3C"; c.lineWidth=Math.max(1,size*0.10); c.lineCap="round";
  c.beginPath(); c.moveTo(-gap*0.55,0); c.lineTo(gap*0.55,0); c.stroke();
  c.fillStyle="#FFF1D0";
  c.beginPath(); c.arc(0,0,Math.max(.9,size*0.10),0,Math.PI*2); c.fill();
  c.restore();
}

function colOf(k){ return (D.factions[k]||{}).color || "#888"; }
function nameOf(k){ return (D.factions[k]||{}).name || ""; }

var cv=document.getElementById("strip");
var dpr = COMPACT ? 3 : 2;
cv.width=W*dpr; cv.height=H*dpr;
var c=cv.getContext("2d");
c.setTransform(dpr,0,0,dpr,0,0);

c.fillStyle="#06090F"; c.fillRect(0,0,W,H);
c.strokeStyle="rgba(78,205,196,.05)"; c.lineWidth=1;
var grid = COMPACT ? 28 : 44;
for(var gx=0;gx<W;gx+=grid){c.beginPath();c.moveTo(gx+.5,0);c.lineTo(gx+.5,H);c.stroke();}
for(var gy=0;gy<H;gy+=grid){c.beginPath();c.moveTo(0,gy+.5);c.lineTo(W,gy+.5);c.stroke();}

// Type scale in DISPLAY pixels - sized for legibility first, with the
// layout fitted around it. The reverse of the first attempt.
var FS = COMPACT
  ? { title:11, holder:10, body:10, moon:8.5, foot:9, sun:12 }
  : { title:10, holder:9,  body:9.5, moon:8.5, foot:9, sun:11 };

function drawSun(x, cy, r){
  var sunCol = colOf(D.starOwner);
  var sg=c.createRadialGradient(x,cy,3,x,cy,r);
  sg.addColorStop(0,"rgba(255,236,180,.95)");
  sg.addColorStop(.45,hexA(sunCol,.42));
  sg.addColorStop(1,"rgba(255,194,74,0)");
  c.fillStyle=sg; c.beginPath(); c.arc(x,cy,r,0,Math.PI*2); c.fill();
  c.strokeStyle=hexA(sunCol,.85); c.lineWidth=2;
  c.beginPath(); c.arc(x,cy,r*0.42,0,Math.PI*2); c.stroke();
  if(D.starCombat) drawCombatIcon(x+r*0.30, cy-r*0.34, COMPACT?15:13);
  c.textAlign="left"; c.textBaseline="alphabetic";
  c.font='700 '+FS.sun+'px ui-monospace, Menlo, Consolas, monospace';
  c.fillStyle="#FFD98A"; c.fillText("SOL", x+8, cy+4);
  if(D.starOwner){
    c.font='600 '+(FS.sun-2)+'px ui-monospace, Menlo, Consolas, monospace';
    c.fillStyle=hexA(sunCol,.95);
    c.fillText(fitText(c, shortName(nameOf(D.starOwner)), 78), x+8, cy+16);
  }
}

// One sector cell, CLIPPED to its own band so a long name can never
// bleed into a neighbour - the failure that wrecked the first version.
function drawSector(s, x0, x1, yTop, yBot){
  var cx=(x0+x1)/2, bandW=(x1-x0)-10, d=dominant(s);
  var cy = yTop + (yBot-yTop)*0.46;

  if(d.owner){
    var col=colOf(d.owner);
    var g=c.createLinearGradient(0,yTop,0,yBot);
    g.addColorStop(0,hexA(col,0));
    g.addColorStop(.40,hexA(col,d.contested?.13:.22));
    g.addColorStop(.62,hexA(col,d.contested?.13:.22));
    g.addColorStop(1,hexA(col,0));
    c.fillStyle=g;
    c.fillRect(x0+4,yTop,Math.max(2,(x1-x0)-8),yBot-yTop);
    if(d.contested){
      c.save(); c.beginPath(); c.rect(x0+4,yTop,Math.max(2,(x1-x0)-8),yBot-yTop); c.clip();
      c.strokeStyle=hexA(col,.16); c.lineWidth=2;
      for(var hx=x0-(yBot-yTop);hx<x1+(yBot-yTop);hx+=11){
        c.beginPath(); c.moveTo(hx,yBot); c.lineTo(hx+(yBot-yTop),yTop); c.stroke(); }
      c.restore();
    }
  }

  c.save();
  c.beginPath(); c.rect(x0,yTop,x1-x0,yBot-yTop); c.clip();
  c.textAlign="center"; c.textBaseline="alphabetic";

  // Sector name. NO letter-spacing: the split("").join(" ") trick that
  // read well at 1200px made every title ~2x wider and was the single
  // biggest cause of collisions at embed width.
  c.font='700 '+FS.title+'px ui-monospace, Menlo, Consolas, monospace';
  c.fillStyle=d.owner?hexA(colOf(d.owner),.95):"rgba(147,163,184,.75)";
  c.fillText(fitText(c,s.label.toUpperCase(),bandW), cx, yTop+15);

  c.font='700 '+FS.holder+'px ui-monospace, Menlo, Consolas, monospace';
  if(d.contested){ c.fillStyle="rgba(255,194,74,.95)"; c.fillText("CONTESTED",cx,yTop+29); }
  else if(d.owner){
    c.fillStyle=hexA(colOf(d.owner),.95);
    c.fillText(fitText(c,shortName(nameOf(d.owner)),bandW),cx,yTop+29);
  } else { c.fillStyle="rgba(95,113,134,.85)"; c.fillText("UNCLAIMED",cx,yTop+29); }

  var many=s.bodies.length>1;
  if(many){
    // Pooled band: a grid of pips. Individual rock names carry no
    // decision value at this size, so they become a count.
    var per=Math.min(4,Math.max(2,Math.floor(bandW/16)));
    var rws=Math.ceil(s.bodies.length/per);
    s.bodies.forEach(function(b,i){
      var rr=Math.floor(i/per), cc=i%per;
      var n=Math.min(per,s.bodies.length-rr*per);
      var bx=cx+(cc-(n-1)/2)*15;
      var by=cy-((rws-1)/2)*15+rr*15;
      c.fillStyle=b.owner?colOf(b.owner):"#2A3745";
      c.beginPath(); c.arc(bx,by,5,0,Math.PI*2); c.fill();
      c.strokeStyle=b.owner?hexA(colOf(b.owner),.9):"rgba(147,163,184,.4)";
      c.lineWidth=1.2; c.beginPath(); c.arc(bx,by,5,0,Math.PI*2); c.stroke();
      if(b.combat) drawCombatIcon(bx+8,by-7,11);
    });
    c.font='600 '+FS.moon+'px ui-monospace, Menlo, Consolas, monospace';
    c.fillStyle="rgba(147,163,184,.8)";
    c.fillText(s.bodies.length+" BODIES", cx, yBot-10);
  } else {
    var b=s.bodies[0];
    var r=b.kind==="g"?15:b.kind==="p"?11:7;
    var bcol=b.owner?colOf(b.owner):"#4A5A6B";
    if(b.owner){ c.fillStyle=hexA(bcol,.18); c.beginPath(); c.arc(cx,cy,r+6,0,Math.PI*2); c.fill(); }
    c.fillStyle=b.owner?bcol:"#26333F";
    c.beginPath(); c.arc(cx,cy,r,0,Math.PI*2); c.fill();
    c.strokeStyle=b.owner?hexA(bcol,.9):"rgba(147,163,184,.45)"; c.lineWidth=1.5;
    c.beginPath(); c.arc(cx,cy,r,0,Math.PI*2); c.stroke();
    if(b.kind==="g"){
      c.strokeStyle=b.owner?hexA(bcol,.5):"rgba(147,163,184,.3)"; c.lineWidth=1.5;
      c.beginPath(); c.ellipse(cx,cy,r*1.8,r*0.4,-0.32,0,Math.PI*2); c.stroke();
    }
    if(b.combat) drawCombatIcon(cx+r+3, cy-r-2, COMPACT?15:13);
    // Moons as a pip cluster, NOT a labelled list. Those labels were
    // unbounded text running clean across neighbouring sectors.
    var moons=s.moons||[];
    if(moons.length){
      var mper=Math.min(5,Math.max(3,Math.floor(bandW/13)));
      moons.forEach(function(m,i){
        var rr=Math.floor(i/mper), cc=i%mper;
        var n=Math.min(mper,moons.length-rr*mper);
        var mx=cx+(cc-(n-1)/2)*12;
        var my=cy+r+16+rr*12;
        c.fillStyle=m.owner?colOf(m.owner):"#39485A";
        c.beginPath(); c.arc(mx,my,4,0,Math.PI*2); c.fill();
        c.strokeStyle="rgba(6,9,15,.9)"; c.lineWidth=1;
        c.beginPath(); c.arc(mx,my,4,0,Math.PI*2); c.stroke();
        if(m.combat) drawCombatIcon(mx+6,my-6,10);
      });
      c.font='600 '+FS.moon+'px ui-monospace, Menlo, Consolas, monospace';
      c.fillStyle="rgba(147,163,184,.75)";
      c.fillText(moons.length+(moons.length===1?" MOON":" MOONS"), cx, yBot-10);
    }
  }
  c.restore();
}

// Ten sectors across 550px is ~55px each - not enough for a name, a
// holder and a planet. Two rows doubles the width per sector, which is
// what makes the embed legible at all.
var secs = D.sectors.slice();
var rows = COMPACT
  ? [secs.slice(0,Math.ceil(secs.length/2)), secs.slice(Math.ceil(secs.length/2))]
  : [secs];
var footH = 22;
var rowH = (H-footH)/rows.length;

rows.forEach(function(rowSecs, ri){
  var yTop = ri*rowH, yBot = yTop + rowH;
  var x0 = 8;
  if(ri===0){
    drawSun(COMPACT?10:6, yTop+rowH*0.46, Math.min(rowH*0.46, COMPACT?54:96));
    x0 = COMPACT ? 78 : 100;
  }
  var total = rowSecs.reduce(function(a,s){return a+s.weight;},0)||1;
  var cur = x0;
  var avail = (W-8) - x0;
  rowSecs.forEach(function(s){
    var w = avail*(s.weight/total);
    drawSector(s, cur, cur+w, yTop, yBot);
    cur += w;
  });
  if(ri<rows.length-1){
    c.strokeStyle="rgba(78,205,196,.12)"; c.lineWidth=1;
    c.beginPath(); c.moveTo(8,yBot+.5); c.lineTo(W-8,yBot+.5); c.stroke();
  }
});

c.font='600 '+FS.foot+'px ui-monospace, Menlo, Consolas, monospace';
c.fillStyle="rgba(95,113,134,.95)"; c.textAlign="left"; c.textBaseline="alphabetic";
c.fillText((D.game.name+" · TICK "+D.game.tick).toUpperCase(), 10, H-8);
c.textAlign="right";
if(D.combatCount>0){
  drawCombatIcon(W-10-c.measureText(D.combatCount+" UNDER FIRE").width-9, H-11, 11);
  c.fillStyle="rgba(255,140,100,.95)";
  c.fillText(D.combatCount+" UNDER FIRE", W-10, H-8);
} else {
  c.fillText(D.bodyCount+" BODIES", W-10, H-8);
}

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
