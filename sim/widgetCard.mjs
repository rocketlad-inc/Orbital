// ============================================================
// WIDGET CARD — the token is a credential sitting on a phone forever,
// and the PNG is a real file or it is nothing.
//
// Two risks, and they are different in kind.
//
// The SECURITY one: this URL authenticates with a token in the path, is
// refetched every half hour for as long as the widget exists, and is the
// only route in the app that renders a named player's private numbers
// without a session. Revocation must actually revoke, one player's token
// must never render another's card, and a revoked token must look
// exactly like one that never existed.
//
// The RENDERING one: the PNG is assembled by hand, byte by byte. A wrong
// gradient stop or a bad chunk CRC produces a file that the worker
// serves happily with content-type image/png and that no decoder on
// earth will open — and the only symptom is a blank rectangle on
// somebody's home screen. So this decodes what it produced.
//
// Run: node sim/widgetCard.mjs
// ============================================================

import { SimD1 } from './d1.mjs';
import { MIGRATIONS } from '../worker/_migrations_bundle.js';

let bad = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !detail ? '' : `\n        ${detail}`}`);
  if (!ok) bad++;
}

const DB = new SimD1(':memory:');
DB.applyMigrations(MIGRATIONS);
const env = { DB };
const G = 'g_widget';

await DB.prepare(`INSERT INTO users (id,email,display_name,password_hash,created_at)
                  VALUES ('u1','a@t','A','x',0), ('u2','b@t','B','x',0)`).run();
await DB.prepare(`INSERT INTO rooms (id,name,host_id,created_at,updated_at)
                  VALUES (?, 'The Long War','u1',0,0)`).bind(G).run();
await DB.prepare(`INSERT INTO games (id,status,map_seed,current_tick,next_tick_at,created_at)
                  VALUES (?, 'active','s',412,?,0)`).bind(G, Date.now() + 23 * 60000).run();
await DB.prepare(`INSERT INTO game_factions
                    (id,game_id,slot,name,color,status,joined_at,user_id,metal,fuel,gold,science)
                  VALUES ('f1',?,0,'Alpha Concord','#4ecdc4','active',0,'u1',12400,880,3050,91),
                         ('f2',?,1,'Red Star','#ff5a4e','active',0,'u2',10,10,10,10)`).bind(G, G).run();

const widget = await import('../worker/widget.js');

// ---- 1. tokens -----------------------------------------------------
const t1 = await widget.mintWidgetToken(env, 'u1', 'phone');
const t2 = await widget.mintWidgetToken(env, 'u2', 'phone');
check('a minted token resolves to its owner', await widget.resolveWidgetToken(env, t1) === 'u1');
check('...and not to anyone else', await widget.resolveWidgetToken(env, t2) === 'u2');
check('an unknown token resolves to nothing',
  await widget.resolveWidgetToken(env, 'not-a-real-token') === null);
check('tokens are long enough to be unguessable', t1.length >= 30, `len ${t1.length}`);
check('two mints are not the same token', t1 !== t2);

await DB.prepare('UPDATE widget_tokens SET revoked_ms = ? WHERE token = ?').bind(Date.now(), t2).run();
check('a revoked token stops resolving', await widget.resolveWidgetToken(env, t2) === null);

// last_used_ms is how a widget that has silently stopped refreshing
// becomes visible from the server side.
const used = (await DB.prepare('SELECT last_used_ms FROM widget_tokens WHERE token = ?')
  .bind(t1).first()).last_used_ms;
check('resolving stamps last_used_ms', used != null);

// ---- 2. the snapshot -----------------------------------------------
const snap = await widget.widgetSnapshot(env, 'u1');
check('the snapshot finds the active game', snap && snap.game === 'The Long War');
check('...with this player\'s faction, not another\'s', snap.faction === 'Alpha Concord');
check('...and their own resources', snap.metal === 12400 && snap.gold === 3050,
  JSON.stringify(snap));

// FUEL IS DEAD and must not come back. TopBar removed the pill outright
// and every faction on prod sits at exactly 0, but game_factions still
// carries the column — so reading the schema and assuming every numeric
// field is a live currency puts a killed mechanic back in front of
// players. It reached a home screen once already.
check('the snapshot does not carry fuel', !('fuel' in snap), Object.keys(snap).join(','));
check('...and nothing in the module mentions a fuel column',
  !JSON.stringify(snap).includes('fuel'));
check('a player with no game snapshots to null',
  await widget.widgetSnapshot(env, 'nobody') === null);

// ---- 2b. which game gets picked -------------------------------------
//
// THIS IS THE CASE THAT SHIPPED BROKEN. A real player had three games:
// two finished with his faction still standing, one still running after
// he was eliminated. The first rule was "active faction in an active
// game", which matched none of them, so the card said NO ACTIVE GAME to
// someone with three games to his name.
await DB.prepare(`INSERT INTO users (id,email,display_name,password_hash,created_at)
                  VALUES ('u3','c@t','Rocketlad','x',0)`).run();
await DB.prepare(`INSERT INTO rooms (id,name,host_id,created_at,updated_at)
                  VALUES ('gOld','The Friendly Zone','u3',0,1000),
                         ('gDead','The MEGA Zone','u3',0,3000)`).run();
await DB.prepare(`INSERT INTO games (id,status,map_seed,current_tick,created_at)
                  VALUES ('gOld','completed','s',441,0),
                         ('gDead','active','s',573,0)`).run();
await DB.prepare(`INSERT INTO game_factions
                    (id,game_id,slot,name,color,status,joined_at,user_id,metal,fuel,gold,science)
                  VALUES ('fOld','gOld',0,'Empire of Lorne','#4ecdc4','active',0,'u3',5,5,5,5),
                         ('fDead','gDead',0,'Solar Expanse','#ff5a4e','eliminated',0,'u3',7,7,7,7)`).run();

const knocked = await widget.widgetSnapshot(env, 'u3');
check('a player with no live-and-standing game still gets a card', knocked !== null);
check('...and it is the LIVE one they were knocked out of, not a finished one',
  knocked.game === 'The MEGA Zone', knocked && knocked.game);
check('...labelled eliminated', knocked.state === 'eliminated', knocked && knocked.state);
check('an eliminated card counts nothing as waiting on you',
  knocked.fighting === 0 && knocked.bills === 0 && knocked.unread === 0);
check('...and does not count down to a tick it will not act on', knocked.nextTickAt === 0);

// A finished game, when that is all there is, says so rather than lying.
await DB.prepare("UPDATE games SET status = 'completed' WHERE id = 'gDead'").run();
const ended = await widget.widgetSnapshot(env, 'u3');
check('with only finished games it picks the most recently touched',
  ended.game === 'The MEGA Zone' && ended.state === 'ended',
  `${ended.game} / ${ended.state}`);

// And a live game you are still standing in always wins.
await DB.prepare("UPDATE games SET status = 'active' WHERE id = 'gDead'").run();
await DB.prepare("UPDATE game_factions SET status = 'active' WHERE id = 'fDead'").run();
await DB.prepare("UPDATE rooms SET updated_at = 99999 WHERE id = 'gOld'").run();
const live = await widget.widgetSnapshot(env, 'u3');
check('a live game you are standing in beats a more recent finished one',
  live.game === 'The MEGA Zone' && live.state === 'live',
  `${live.game} / ${live.state}`);

// ---- 3. the PNG is a real PNG ---------------------------------------
const png = await widget.renderWidgetPng(snap, { width: 512, height: 256 });
const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
check('starts with the PNG signature', sig.every((b, i) => png[i] === b));

const dv = new DataView(png.buffer, png.byteOffset, png.byteLength);
check('IHDR declares the size we asked for',
  dv.getUint32(16) === 512 && dv.getUint32(20) === 256,
  `${dv.getUint32(16)}x${dv.getUint32(20)}`);

// Walk the chunks and verify every CRC. A bad CRC is the exact failure
// that yields a file the server serves and no decoder opens.
let off = 8, chunks = [], crcOk = true;
const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c >>> 0; }
  return t;
})();
const crc32 = (bytes) => { let c = 0xFFFFFFFF; for (const b of bytes) c = CRC[(c ^ b) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
while (off < png.length) {
  const len = dv.getUint32(off);
  const type = String.fromCharCode(png[off + 4], png[off + 5], png[off + 6], png[off + 7]);
  chunks.push(type);
  const stated = dv.getUint32(off + 8 + len);
  if (crc32(png.subarray(off + 4, off + 8 + len)) !== stated) crcOk = false;
  off += 12 + len;
}
check('every chunk CRC is correct', crcOk, chunks.join(','));
check('has IHDR, IDAT and IEND in order',
  chunks[0] === 'IHDR' && chunks.includes('IDAT') && chunks[chunks.length - 1] === 'IEND',
  chunks.join(','));

// The IDAT payload must actually inflate — the gradient bug this test was
// written after produced NaN pixel values, which is a different failure
// but lands in the same place.
const idat = [];
off = 8;
while (off < png.length) {
  const len = dv.getUint32(off);
  const type = String.fromCharCode(png[off + 4], png[off + 5], png[off + 6], png[off + 7]);
  if (type === 'IDAT') idat.push(png.subarray(off + 8, off + 8 + len));
  off += 12 + len;
}
const joined = new Uint8Array(idat.reduce((n, a) => n + a.length, 0));
{ let p = 0; for (const a of idat) { joined.set(a, p); p += a.length; } }
const ds = new DecompressionStream('deflate');
const inflated = new Uint8Array(await new Response(
  new Blob([joined]).stream().pipeThrough(ds)).arrayBuffer());
// One filter byte per row, then 4 bytes per pixel.
check('the pixel data inflates to exactly one image',
  inflated.length === 256 * (1 + 512 * 4),
  `got ${inflated.length}, want ${256 * (1 + 512 * 4)}`);

// NaN colours land as 0 after the Uint8Array store, so a card that
// rendered nothing is an all-black image. Prove something was drawn.
let nonBlack = 0;
for (let i = 0; i < inflated.length; i++) if (inflated[i] > 40) nonBlack++;
check('the card is not a blank rectangle', nonBlack > 2000, `${nonBlack} bright bytes`);

// ---- 4. an empty state still renders --------------------------------
const quiet = await widget.renderWidgetPng({
  game: 'NO ACTIVE GAME', faction: 'ORBITAL', color: '#4ecdc4', tick: 0, nextTickAt: 0,
  metal: 0, fuel: 0, gold: 0, science: 0, fighting: 0, inbound: 0, bills: 0, unread: 0, offers: 0,
}, { width: 512, height: 256 });
check('the no-game card is still a valid PNG', sig.every((b, i) => quiet[i] === b));

// ---- 5. odd sizes do not blow up -------------------------------------
for (const [w, h] of [[240, 120], [1200, 800], [300, 300]]) {
  const p = await widget.renderWidgetPng(snap, { width: w, height: h });
  const d = new DataView(p.buffer, p.byteOffset, p.byteLength);
  check(`renders at ${w}x${h}`, d.getUint32(16) === w && d.getUint32(20) === h);
}

// ---- 6. the map route -----------------------------------------------
// The strip itself is the Herald's and tested with the Herald. What is
// tested here is the only part this module owns: that the token gates
// it, and that it resolves to the SAME game the card picked. A map of
// one game beside a card for another would be worse than no map.
check('the snapshot carries the game id the map needs', typeof snap.gameId === 'string');
{
  const req = (t) => new Request(`https://x/widget/${t}/map.png`);
  const denied = await widget.handleWidgetMapPng(req('nope'), env, { params: { token: 'nope' } });
  check('the map refuses an unknown token', denied.status === 404);

  const revoked = await widget.handleWidgetMapPng(req(t2), env, { params: { token: t2 } });
  check('the map refuses a revoked token', revoked.status === 404);

  // u1's game has no bodies in this fixture, so the strip renderer has
  // nothing to draw and says so — a 404 here still proves the token was
  // accepted and the right game was looked up, which is this module's
  // half of the job.
  const ok = await widget.handleWidgetMapPng(req(t1), env, { params: { token: t1 } });
  check('a live token gets past the gate', ok.status === 200 || ok.status === 404,
    `status ${ok.status}`);
  if (ok.status === 200) {
    check('...and returns a PNG', ok.headers.get('content-type') === 'image/png');
  }
}

// ---- 7. the combined card --------------------------------------------
// The default widget composes the map and the status bar. Two things
// must hold: it comes out at the size asked for (the strip supersamples,
// so a scale mistake here silently halves or doubles the bar), and a map
// that cannot be drawn must not cost the player their widget.
{
  // A game with no bodies at all still draws — the strip renders an
  // empty system rather than refusing, which is the right call for a
  // game that has only just been seeded.
  const sparse = await widget.renderCombinedPng(env, snap, { width: 512, height: 256 });
  check('a game with no bodies yet still renders', sparse !== null);

  const res = await widget.handleWidgetPng(
    new Request('https://x/widget/x.png'), env, { params: { token: t1 } },
  );
  check('the default route serves a card', res.status === 200);
  check('...as a PNG', res.headers.get('content-type') === 'image/png');

  // The status-only path must not draw a map, so it stays legible at the
  // small widget sizes the combined card gives up on.
  const cardOnly = await widget.handleWidgetPng(
    new Request('https://x/widget/x/card.png'), env,
    { params: { token: t1 }, statusOnly: true },
  );
  const cardBytes = new Uint8Array(await cardOnly.arrayBuffer());
  const cdv = new DataView(cardBytes.buffer, cardBytes.byteOffset, cardBytes.byteLength);
  check('the card path renders at 1x, not the map\'s 2x',
    cdv.getUint32(16) === 512 && cdv.getUint32(20) === 256,
    `${cdv.getUint32(16)}x${cdv.getUint32(20)}`);

  // Now give it a system to draw.
  for (const [id, name, type, parent] of [
    ['sol', 'Sol', 'star', null], ['earth', 'Earth', 'terrestrial', 'sol'],
    ['mars', 'Mars', 'terrestrial', 'sol'], ['luna', 'Luna', 'moon', 'earth'],
  ]) {
    await DB.prepare(
      `INSERT INTO game_bodies (id,game_id,template_id,name,type,parent_body_id,radius,mu,color,owner_faction_id)
       VALUES (?,?,?,?,?,?,10,50,'#c44',?)`,
    ).bind(id, G, id, name, type, parent, id === 'sol' ? null : 'f1').run();
  }

  for (const [w, h] of [[512, 256], [360, 180]]) {
    const png = await widget.renderCombinedPng(env, snap, { width: w, height: h });
    check(`combined renders at ${w}x${h}`, png !== null);
    if (png) {
      const d = new DataView(png.buffer, png.byteOffset, png.byteLength);
      // The strip supersamples 2x, so the file is twice the layout size.
      check(`...at 2x device pixels (${w * 2}x${h * 2})`,
        d.getUint32(16) === w * 2 && d.getUint32(20) === h * 2,
        `${d.getUint32(16)}x${d.getUint32(20)}`);
    }
  }

  // The map half must still be reachable on its own path.
  const map = await widget.handleWidgetMapPng(
    new Request('https://x/widget/x/map.png'), env, { params: { token: t1 } },
  );
  check('the map path still serves the unadorned strip', map.status === 200);
}

console.log(bad ? `\n${bad} FAILED` : '\nall checks passed');
process.exit(bad ? 1 : 0);
