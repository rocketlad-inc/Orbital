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

console.log(bad ? `\n${bad} FAILED` : '\nall checks passed');
process.exit(bad ? 1 : 0);
