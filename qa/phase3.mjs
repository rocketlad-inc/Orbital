// QA phase 3: run the sim forward to completion + combat, watch for breakage.
import fs from 'fs';
const BASE = 'https://orbital.lcfeeser.workers.dev';
const users = JSON.parse(fs.readFileSync(new URL('./qa_users.json', import.meta.url)));
const { roomId: GID } = JSON.parse(fs.readFileSync(new URL('./qa_game.json', import.meta.url)));
const bugs = [];
const log = (...a) => console.log(...a);
function bug(sev, sys, msg, d) { bugs.push({ sev, sys, msg, d }); log(`  ${sev==='high'?'🔴':sev==='med'?'🟡':'🔵'} [${sys}] ${msg}${d?' — '+d:''}`); }
async function api(u, m, p, b) {
  const res = await fetch(BASE + p, { method: m, headers: { 'Cookie': `orbital_session=${u.token}`, ...(b?{'Content-Type':'application/json'}:{}) }, body: b?JSON.stringify(b):undefined });
  const t = await res.text(); let j=null; try{j=t?JSON.parse(t):null;}catch{j={_raw:t.slice(0,120)};}
  return { status: res.status, ok: res.ok, json: j };
}
const me = async (u) => (await api(u, 'GET', `/api/games/${GID}/state`)).json;

async function main() {
  const before = await me(users[0]);
  log(`start tick ${before.game.current_tick}`);
  // Force ~30 ticks so transfers (arrival ~t30) land and builds finish.
  let last = before.game.current_tick;
  for (let i = 0; i < 34; i++) {
    const r = await api(users[0], 'POST', `/api/lobby/rooms/${GID}/force-tick`, {});
    if (r.status >= 500) { bug('high','tick',`force-tick 500 at iter ${i}`, JSON.stringify(r.json).slice(0,120)); break; }
  }
  const after = await me(users[0]);
  log(`end tick ${after.game.current_tick} (advanced ${after.game.current_tick - last})`);

  // Per-faction: ships, builds done, combat, deaths.
  log('\n--- Per-faction after run ---');
  for (let i=0;i<4;i++){
    const st = await me(users[i]);
    const fid = st.me.faction_id;
    const myShips = (st.ships||[]).filter(s=>s.owner_faction_id===fid);
    const visibleEnemies = (st.ships||[]).filter(s=>s.owner_faction_id!==fid);
    const combatShips = myShips.filter(s=>s.last_combat_tick!=null && after.game.current_tick - s.last_combat_tick < 6);
    const res = st.me.resources||{};
    log(`  ${st.me.name}: ships=${myShips.length} (visibleEnemies=${visibleEnemies.length}) inCombat=${combatShips.length} metal=${res.metal} gold=${res.gold} sci=${Math.round(res.science)} rp=${st.me.research?.tech_id||'idle'}`);
    for (const k of ['metal','fuel','gold','science']) { const v=res[k]; if(typeof v==='number'&&(v<0||Number.isNaN(v))) bug('high','economy',`${st.me.name} ${k}=${v}`); }
    for (const s of myShips) { if (s.hp!=null && (s.hp<0||Number.isNaN(s.hp))) bug('high','combat',`${s.id} hp=${s.hp}`); }
  }

  // Combat / chronicle events in the run window.
  const ev = after.events || [];
  const combatEv = ev.filter(e=>/combat|destroy|hit|attack|engage/i.test(JSON.stringify(e)));
  log(`\n--- Events: ${ev.length} total, ${combatEv.length} combat-ish ---`);
  for (const e of combatEv.slice(0,5)) log('   ', JSON.stringify(e).slice(0,140));

  log(`\n=== phase3: ${bugs.length} issue(s) ===`);
  fs.writeFileSync(new URL('./qa_bugs3.json', import.meta.url), JSON.stringify(bugs,null,2));
}
await main();
