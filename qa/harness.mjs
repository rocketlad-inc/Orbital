// QA harness: drives a 4-player MP game through the real REST API.
// Each faction acts via its own session cookie, exactly as a browser would.
import fs from 'fs';

const BASE = 'https://orbital.lcfeeser.workers.dev';
const users = JSON.parse(fs.readFileSync(new URL('./qa_users.json', import.meta.url)));

const log = (...a) => console.log(...a);
const bugs = [];
function bug(sev, system, msg, detail) {
  bugs.push({ sev, system, msg, detail });
  log(`  ${sev === 'high' ? '🔴' : sev === 'med' ? '🟡' : '🔵'} [${system}] ${msg}${detail ? ' — ' + detail : ''}`);
}

async function api(user, method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'Cookie': `orbital_session=${user.token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  const text = await res.text();
  try { json = text ? JSON.parse(text) : null; } catch { json = { _raw: text }; }
  return { status: res.status, ok: res.ok, json };
}

// Expect a call to succeed; record a bug if it doesn't.
async function expectOk(user, method, path, body, ctx) {
  const r = await api(user, method, path, body);
  if (!r.ok) bug('high', ctx.system, `${method} ${path} failed (${r.status})`, JSON.stringify(r.json?.error ?? r.json).slice(0, 160));
  return r;
}

async function main() {
  const [host, p2, p3, p4] = users;
  log('=== Phase 0: lobby ===');

  // Host creates the room.
  const create = await expectOk(host, 'POST', '/api/rooms', { name: 'QA Regression', max_players: 4 }, { system: 'lobby' });
  const roomId = create.json?.room?.id;
  const code = create.json?.room?.invite_code;
  log('room', roomId, 'code', code);
  if (!roomId) { log('FATAL: no room id'); return; }
  fs.writeFileSync(new URL('./qa_game.json', import.meta.url), JSON.stringify({ roomId, code }, null, 2));

  // Others join by code.
  for (const u of [p2, p3, p4]) {
    const j = await expectOk(u, 'POST', '/api/rooms/join-by-code', { code }, { system: 'lobby' });
    log(`  ${u.name} join:`, j.status, j.json?.room?.id ?? j.json?.error?.code ?? '');
  }

  // Roster check via the DO-backed snapshot.
  const snap = await api(host, 'GET', `/api/rooms/${roomId}`);
  const members = snap.json?.members ?? snap.json?.room?.members ?? [];
  log('  roster size:', Array.isArray(members) ? members.length : Object.keys(members || {}).length);

  // Host starts the game (seeds world, flips to active).
  log('=== Phase 1: start ===');
  const start = await expectOk(host, 'POST', `/api/lobby/rooms/${roomId}/start`, {}, { system: 'lobby' });
  log('  start:', start.status, JSON.stringify(start.json).slice(0, 120));

  // Confirm each player sees active state with their faction.
  for (const u of users) {
    const st = await api(u, 'GET', `/api/games/${roomId}/state`);
    const g = st.json?.game;
    const mine = (st.json?.factions ?? []).find(f => f.is_me || f.user_id === u.id);
    log(`  ${u.name}: state ${st.status}, game.status=${g?.status}, tick=${g?.current_tick}, myFaction=${mine?.name ?? '?'}`);
    if (st.status !== 200) bug('high', 'state', `${u.name} cannot read game state`, `${st.status}`);
    if (g && g.status !== 'active') bug('high', 'start', `game not active after start`, g.status);
  }

  log('\n=== SUMMARY ===');
  log(`${bugs.length} issue(s) in phases 0-1`);
}
await main();
