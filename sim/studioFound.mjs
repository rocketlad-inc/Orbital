// ============================================================
// A megastructure built on camera (2026-10-23, the construction clip).
//
// Lorne: "Show starting the build, running freighters back and forth to
// deliver the materials, completion." The studio could only stand a site
// up at some progress and hand it one load. Two mid-take orders now do it
// the player's way:
//
//   found   the parked colony ship lays the foundation (actions.js
//           handlePlaceFramework), at `orbit` units from its world and a
//           `bearing` from the world's heading;
//   supply  freighters on a standing supply run from the dock to the site
//           (tradeRoutesV2.js handleCreateFull), loading from the treasury.
//
// Drives the REAL studio (applyScenario, handleOrder) and room.js
// resolveTick in SimD1, with Earth and Luna at production's size and
// orbit, so the timeline printed here is the one a production take gets:
//   1. found: the site stands where it was asked, named '<Kind> Site',
//      the colony hull spent, the reply naming the site
//   2. found refuses a point outside the world's sphere of influence
//   3. supply: three freighters laid one tick apart deliver; the meter
//      rises at each delivery; the site completes, is renamed, and the
//      completion is chronicled on the tick it happens
//   4. a scene `supply` order lays the same route at apply time
//   5. reset retires a founded site (it is not studio-marked)
//
// Run: npm run sim:studio-found
// ============================================================

import { SimD1 } from './d1.mjs';
import { MIGRATIONS } from '../worker/_migrations_bundle.js';

let bad = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !detail ? '' : `\n        ${detail}`}`);
  if (!ok) bad++;
}

function makeState() {
  const kv = new Map();
  return {
    storage: {
      get: async (k) => kv.get(k), put: async (k, v) => { kv.set(k, v); }, delete: async (k) => kv.delete(k),
      setAlarm: async () => {}, getAlarm: async () => null,
    },
    id: { toString: () => 'sim-room' }, acceptWebSocket: () => {}, getWebSockets: () => [],
  };
}

const KEY = 'sim-agent-key';
const DB = new SimD1(':memory:');
DB.applyMigrations(MIGRATIONS);
let room = null;
const env = {
  DB, AGENT_KEY: KEY,
  // The DO: route dispatch reaches the sim's own room, as it does on prod.
  ROOM: { idFromName: () => 'x', get: () => ({ fetch: async (url, init) => (room ? room.fetch(new Request(url, init)) : new Response('{}')) }) },
};
await DB.prepare(`INSERT INTO users (id,email,display_name,password_hash,created_at) VALUES ('admin','a@t','Admin','x',0)`).run();

const { applyScenario, routes } = await import('../worker/studio.js');
const { expandScenario } = await import('../worker/studioScene.js');
const { Room } = await import('../worker/room.js');
const { bodyPositionAt } = await import('../worker/megastructures.js');

const scene = (extra = {}) => ({
  name: 'A warp gate built on camera',
  factions: [
    { key: 'terra', name: 'Terran Directorate', home: 'earth', metal: 20000, gold: 20000 },
    { key: 'mars', name: 'Martian Combine', home: 'mars' },
  ],
  viewer: 'terra',
  research: [
    { faction: 'terra', track: 'construction', level: 4 },
    { faction: 'terra', track: 'propulsion', level: 6 },
  ],
  ships: [
    { key: 'cs', owner: 'terra', at: 'earth', class: 'colony', count: 1, loadout: ['construction'] },
    { key: 'fr', owner: 'terra', at: 'earth', class: 'freighter', count: 3, loadout: 'default' },
  ],
  ...extra,
});

const out = await applyScenario(env, expandScenario(scene()), { session: { user_id: 'admin' } });
const G = out.game_id;
room = new Room(makeState(), env);
room.broadcast = () => {};

// Production's Earth and Luna (read off a production studio game,
// 2026-10-23): the leg times below depend on them.
await DB.prepare(`UPDATE game_bodies SET radius = 6, soi = 184, orbit_radius = 1488, orbit_period = 580 WHERE id = ?`).bind(`${G}:earth`).run();
await DB.prepare(`UPDATE game_bodies SET radius = 3, soi = 16, orbit_radius = 160, orbit_period = 1271.6272980219012 WHERE id = ?`).bind(`${G}:luna`).run();

const order = async (o) => {
  const r = routes.find(x => x.pattern instanceof RegExp && x.pattern.source.endsWith('\\/order$'));
  const url = new URL(`https://x/api/admin/studio/games/${G}/order`);
  const res = await r.handle(new Request(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-agent-key': KEY }, body: JSON.stringify(o) }),
    env, { url, session: null, params: { gameId: G } });
  return { status: res.status, body: await res.json() };
};
const now = async () => Number((await DB.prepare('SELECT current_tick FROM games WHERE id = ?').bind(G).first()).current_tick);
const tick = async () => {
  const t = (await now()) + 1;
  await room.resolveTick(G, t);
  await DB.prepare('UPDATE games SET current_tick = ? WHERE id = ?').bind(t, G).run();
  return t;
};

// ---- 2 first: a refused point changes nothing ----
{
  const r = await order({ type: 'found', ship: 'st_cs_0', kind: 'warp_gate', orbit: 400 });
  check('2. found refuses a point outside the sphere of influence', r.status === 400 && /sphere of influence/.test(r.body?.error?.message ?? ''),
    JSON.stringify(r));
}

// ---- 1. found ----
const ORBIT = Number(process.env.ORBIT ?? 18);
const T0 = await now();
const f = await order({ type: 'found', ship: 'st_cs_0', kind: 'warp_gate', orbit: ORBIT, bearing: Number(process.env.BEARING ?? 90) });
check('1a. found answers with the site', f.status === 200 && f.body.ok && /:mega_/.test(f.body.site ?? ''), JSON.stringify(f));
const siteId = f.body.site;
const all = (await DB.prepare('SELECT * FROM game_bodies WHERE game_id = ?').bind(G).all()).results;
const byId = new Map(all.map(b => [b.id, b]));
const sb = byId.get(siteId);
check("1b. it is named 'Warp Gate Site', orbiting Earth", sb?.name === 'Warp Gate Site' && sb?.parent_body_id === `${G}:earth`, JSON.stringify(sb));
if (sb) {
  const sp = bodyPositionAt(sb, byId, T0), ep = bodyPositionAt(byId.get(`${G}:earth`), byId, T0);
  const r = Math.hypot(sp.x - ep.x, sp.y - ep.y);
  check(`1c. ${ORBIT} units from Earth on the tick it was laid`, Math.abs(r - ORBIT) < 1e-6, String(r));
}
const cs = await DB.prepare('SELECT status FROM game_ships WHERE id = ?').bind(`${G}:st_cs_0`).first();
check('1d. the colony hull is spent', cs?.status === 'destroyed', JSON.stringify(cs));

// ---- 3. supply, three freighters a tick apart ----
const meter = async () => DB.prepare('SELECT acc_metal, acc_credits, status, completed_at_tick FROM game_megastructures WHERE body_id = ?').bind(siteId).first();
const where = async (id) => {
  const s = await DB.prepare('SELECT parent_body_id FROM game_ships WHERE id = ?').bind(`${G}:${id}`).first();
  const n = await DB.prepare(`SELECT target_body_id, arrival_at_tick FROM game_ship_nodes WHERE ship_id = ? AND status IN ('committed','in_transit') ORDER BY sequence DESC LIMIT 1`).bind(`${G}:${id}`).first();
  const short = (b) => (b === siteId ? 'SITE' : String(b ?? '').replace(/^[^:]+:/, ''));
  return n ? `->${short(n.target_body_id)}@${n.arrival_at_tick}` : `@${short(s?.parent_body_id)}`;
};
const timeline = [];
const snap = async (label) => {
  const m = await meter();
  const p = Math.min(m.acc_metal / 1250, m.acc_credits / 1750);
  timeline.push(`  tick ${await now()} ${label.padEnd(10)} ${String(Math.round(p * 100)).padStart(3)}%  ${m.status.padEnd(8)}  fr0 ${await where('st_fr_0')}  fr1 ${await where('st_fr_1')}  fr2 ${await where('st_fr_2')}`);
  return m;
};
await snap('founded');
const legs = [];
for (let i = 0; i < 3; i++) {
  const s = await order({ type: 'supply', ships: [`st_fr_${i}`], from: 'earth', site: 'last' });
  check(`3a. supply run ${i} is laid and dispatched`, s.status === 200 && s.body.ok && s.body.dispatched, JSON.stringify(s));
  legs.push(s.body.legs?.[0]?.arrive);
  await snap(`supply ${i}`);
  if (i < 2) { await tick(); await snap('tick'); }
}
let done = null;
const seen = [];
for (let k = 0; k < 30 && !done; k++) {
  await tick();
  const m = await snap('tick');
  seen.push(Math.min(m.acc_metal / 1250, m.acc_credits / 1750));
  if (m.status === 'complete') done = m;
}
console.log(timeline.join('\n'));
console.log(`  founded at tick ${T0}; first legs land at ${legs.join(', ')}`);
check('3b. the meter only rises', seen.every((p, i) => i === 0 || p >= seen[i - 1]), seen.join(','));
check('3c. the site completes', !!done, JSON.stringify(await meter()));
if (done) {
  console.log(`  complete at tick ${done.completed_at_tick} (${done.completed_at_tick - T0} ticks after founding)`);
  const nm = await DB.prepare('SELECT name FROM game_bodies WHERE id = ?').bind(siteId).first();
  check("3d. finished, it drops 'Site'", nm?.name === 'Warp Gate', JSON.stringify(nm));
  const ch = await DB.prepare(`SELECT tick_number FROM chronicle_entries WHERE game_id = ? AND body_id = ? AND kind = 'megastructure_complete'`).bind(G, siteId).first();
  check('3e. the completion is chronicled on the tick it happens (the burst plays with it)', Number(ch?.tick_number) === Number(done.completed_at_tick), JSON.stringify(ch));
}

// ---- 4. a scene supply order ----
{
  const sc = scene({
    game_id: G,
    megastructures: [{ key: 'yard', kind: 'warp_gate', at: 'earth', owner: 'terra', progress: 0, orbit: 20, angle: 0 }],
    ships: [{ key: 'fr', owner: 'terra', at: 'earth', class: 'freighter', count: 2, loadout: 'default' }],
    orders: [{ type: 'supply', ships: 'fr', from: 'earth', to: 'yard' }],
  });
  const o2 = await applyScenario(env, expandScenario(sc), { session: { user_id: 'admin' } });
  const sup = o2.orders.find(x => x.type === 'supply');
  check('4. a scene supply order lays the route', !!sup?.route_id && sup.legs.length === 2, JSON.stringify(sup));
  // ---- 5. that apply reset the game: the founded site is retired ----
  const gone = await DB.prepare('SELECT destroyed_at_tick FROM game_bodies WHERE id = ?').bind(siteId).first();
  const row = await DB.prepare('SELECT 1 AS x FROM game_megastructures WHERE body_id = ?').bind(siteId).first();
  check('5. reset retires the site the last take founded', gone?.destroyed_at_tick != null && !row, JSON.stringify({ gone, row }));
}

console.log(bad ? `\n${bad} FAILED` : '\nall passed');
process.exit(bad ? 1 : 0);
