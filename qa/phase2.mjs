// QA phase 2: drive every system as 4 real factions, force ticks, re-verify.
import fs from 'fs';
const BASE = 'https://orbital.lcfeeser.workers.dev';
const users = JSON.parse(fs.readFileSync(new URL('./qa_users.json', import.meta.url)));
const { roomId: GID } = JSON.parse(fs.readFileSync(new URL('./qa_game.json', import.meta.url)));

const bugs = [];
const log = (...a) => console.log(...a);
function bug(sev, sys, msg, detail) { bugs.push({ sev, sys, msg, detail }); log(`  ${sev==='high'?'🔴':sev==='med'?'🟡':'🔵'} [${sys}] ${msg}${detail?' — '+detail:''}`); }

async function api(u, method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Cookie': `orbital_session=${u.token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch { json = { _raw: text.slice(0,120) }; }
  return { status: res.status, ok: res.ok, json };
}
// A 5xx is always a bug. A 4xx MAY be legit validation — record as low unless we expected success.
async function act(u, method, path, body, { sys, expect = 'ok', label }) {
  const r = await api(u, method, path, body);
  const tag = label || `${method} ${path}`;
  if (r.status >= 500) bug('high', sys, `${tag} → server error ${r.status}`, JSON.stringify(r.json).slice(0,140));
  else if (expect === 'ok' && !r.ok) bug('med', sys, `${tag} rejected ${r.status}`, JSON.stringify(r.json?.error ?? r.json).slice(0,140));
  else if (expect === 'reject' && r.ok) bug('med', sys, `${tag} unexpectedly ALLOWED`, 'expected a validation rejection');
  return r;
}
const me = async (u) => (await api(u, 'GET', `/api/games/${GID}/state`)).json;

async function main() {
  log(`=== Driving game ${GID} ===`);
  const S0 = await me(users[0]);
  const facs = users.map((u, i) => ({ u, i, fid: S0.factions[i].id, cap: S0.factions[i].capital_body_id, name: S0.factions[i].name }));
  for (const f of facs) log(`  ${f.name} = ${f.fid} @ ${f.cap}`);

  // ---- Research: each faction commits to a different track ----
  log('\n--- Research ---');
  const tracks = ['industry', 'weapons', 'armor', 'sensors'];
  for (const f of facs) await act(f.u, 'POST', `/api/games/${GID}/research`, { tech_id: tracks[f.i] }, { sys: 'research', label: `commit ${tracks[f.i]}` });
  await act(facs[0].u, 'POST', `/api/games/${GID}/research`, { tech_id: 'not_a_real_tech' }, { sys: 'research', expect: 'reject', label: 'commit bogus tech' });

  // ---- Ship design: create a custom design; reject an invalid one ----
  log('\n--- Ship designer ---');
  await act(facs[0].u, 'POST', `/api/games/${GID}/designs`, { name: 'QA Gunboat', ship_class: 'frigate', parts: [{ type: 'kinetic' }] }, { sys: 'designer', label: 'create frigate design' });
  await act(facs[0].u, 'POST', `/api/games/${GID}/designs`, { name: 'X', ship_class: 'not_a_class', parts: [] }, { sys: 'designer', expect: 'reject', label: 'bad ship_class' });

  // ---- Construction: build a ship at each capital ----
  log('\n--- Construction ---');
  for (const f of facs) await act(f.u, 'POST', `/api/games/${GID}/bodies/${f.cap}/build`, { ship_class: 'corvette', ship_name: `${f.name} Scout` }, { sys: 'build', label: 'build corvette' });
  // Try to build on someone else's capital (should be rejected).
  await act(facs[0].u, 'POST', `/api/games/${GID}/bodies/${facs[1].cap}/build`, { ship_class: 'corvette' }, { sys: 'build', expect: 'reject', label: 'build on enemy body' });
  // Deploy a station (may legitimately fail if no freighter present — note either way).
  const stn = await api(facs[0].u, 'POST', `/api/games/${GID}/bodies/${facs[0].cap}/settlement`, { type: 'station' });
  log(`  deploy station: ${stn.status} ${JSON.stringify(stn.json?.error?.code ?? stn.json?.settlement?.type ?? '')}`);
  if (stn.status >= 500) bug('high', 'build', 'station deploy 500', JSON.stringify(stn.json).slice(0,120));

  // ---- Orders: set stance + retreat on the starter fleet (bulk) ----
  log('\n--- Orders ---');
  for (const f of facs) {
    const st = await me(f.u);
    const myShips = (st.ships||[]).filter(s => s.owner_faction_id === f.fid).map(s => s.id);
    if (myShips.length) await act(f.u, 'PATCH', `/api/games/${GID}/ships/orders`, { ship_ids: myShips, stance: 'defensive', retreat_hp_pct: 25 }, { sys: 'orders', label: 'set defensive+retreat' });
    f.ships = myShips;
  }

  // ---- Movement: transfer a ship toward a neighbor's capital ----
  log('\n--- Movement ---');
  for (const f of facs) {
    if (!f.ships?.length) { bug('med','movement',`${f.name} has no ships to move`); continue; }
    const dest = facs[(f.i+1)%4].cap;
    await act(f.u, 'POST', `/api/games/${GID}/ships/${f.ships[0]}/transfer`, { target_body_id: dest, scheduled_t: S0.game.current_tick, arrival_t: S0.game.current_tick + 30, dv_prograde: 0 }, { sys: 'movement', label: 'transfer to neighbor' });
  }

  // ---- Senate: propose a slider law + everyone votes ----
  log('\n--- Senate ---');
  const sliders = await api(facs[0].u, 'GET', `/api/games/${GID}/senate/sliders`);
  const sliderId = (sliders.json?.sliders ?? sliders.json ?? [])[0]?.id;
  log(`  first slider: ${sliderId ?? '(none found)'}`);
  if (sliderId) {
    const prop = await act(facs[0].u, 'POST', `/api/games/${GID}/senate/proposals`, { kind: 'slider_law', slider_id: sliderId, target_value: 1 }, { sys: 'senate', label: 'propose slider_law' });
    const propId = prop.json?.proposal?.id ?? prop.json?.id;
    if (propId) for (const f of facs) await act(f.u, 'POST', `/api/games/${GID}/senate/proposals/${propId}/vote`, { choice: f.i % 2 ? 'nay' : 'yea' }, { sys: 'senate', label: `${f.name} votes` });
    else bug('med','senate','proposal created but no id returned', JSON.stringify(prop.json).slice(0,120));
  } else bug('med','senate','no sliders returned from /senate/sliders');

  // ---- Trade: f0 offers metal to f1, f1 accepts ----
  log('\n--- Trade ---');
  const trade = await act(facs[0].u, 'POST', `/api/games/${GID}/trades`, { responder_faction_id: facs[1].fid, offer: { metal: 10 }, request: { gold: 5 } }, { sys: 'trade', label: 'propose trade f0→f1' });
  const tid = trade.json?.trade?.id ?? trade.json?.id;
  if (tid) await act(facs[1].u, 'POST', `/api/games/${GID}/trades/${tid}/accept`, {}, { sys: 'trade', label: 'f1 accepts' });
  else if (trade.ok) bug('med','trade','trade created but no id returned', JSON.stringify(trade.json).slice(0,120));

  // ---- Advance the sim: force several ticks, watch for 500s ----
  log('\n--- Ticks ---');
  for (let t = 0; t < 8; t++) {
    const r = await api(users[0], 'POST', `/api/lobby/rooms/${GID}/force-tick`, {});
    if (r.status >= 500) { bug('high','tick',`force-tick ${t} → 500`, JSON.stringify(r.json).slice(0,120)); break; }
    if (!r.ok && r.status !== 409) bug('med','tick',`force-tick ${t} rejected ${r.status}`, JSON.stringify(r.json?.error??r.json).slice(0,100));
  }
  const after = await me(users[0]);
  log(`  tick after 8 forces: ${after.game.current_tick}`);
  if (after.game.current_tick <= S0.game.current_tick) bug('high','tick','ticks did not advance', `${S0.game.current_tick} → ${after.game.current_tick}`);

  // ---- Post-tick verification ----
  log('\n--- Post-tick state ---');
  for (const f of facs) {
    const st = await me(f.u);
    const res = st.me?.resources ?? {};
    const rp = st.me?.research;
    log(`  ${f.name}: metal=${res.metal} gold=${res.gold} sci=${res.science} research=${rp?.tech_id}@${rp?.progress ?? rp?.research_progress ?? '?'} ships=${(st.ships||[]).filter(s=>s.owner_faction_id===f.fid).length} buildq=${(st.build_queue||[]).length}`);
    for (const k of ['metal','fuel','gold','science']) if (typeof res[k]==='number' && (res[k]<0 || Number.isNaN(res[k]))) bug('high','economy',`${f.name} ${k} invalid`, `${res[k]}`);
  }

  log(`\n=== ${bugs.length} issue(s) found ===`);
  fs.writeFileSync(new URL('./qa_bugs.json', import.meta.url), JSON.stringify(bugs, null, 2));
}
await main();
