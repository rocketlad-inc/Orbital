// ============================================================================
// presenceProbe.mjs — what does the room DO actually put in a `presence`
// frame, and does it change when a second player connects/disconnects?
//
// The faction-panel online dot reads `m.type === 'presence'` and
// `m.connected` (an array of user ids). Those field names came from
// reading room.js, and a dot that silently never lights up is exactly the
// kind of bug that ships unnoticed — it looks identical to "nobody is
// online". So confirm the shape against the live server before trusting
// it, and confirm the ids match the user_id the faction rows carry.
//
//   node scripts/presenceProbe.mjs <roomId> <handleA> <handleB>
//
// Reads .agent.session directly; never prints a token.
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';   // CJS: default export IS the constructor

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.ORBITAL_BASE || 'orbital-empire.com';
const [roomId, handleA, handleB] = process.argv.slice(2);
if (!roomId || !handleA || !handleB) {
  console.error('usage: node scripts/presenceProbe.mjs <roomId> <handleA> <handleB>');
  process.exit(1);
}

const sessions = JSON.parse(fs.readFileSync(path.join(ROOT, '.agent.session'), 'utf8'));
const tokenFor = (h) => {
  const t = sessions[h]?.token;
  if (!t) { console.error(`no cached session for "${h}"`); process.exit(1); }
  return t;
};

const open = (handle, label) => new Promise((resolve, reject) => {
  const ws = new WebSocket(`wss://${BASE}/api/rooms/${roomId}/ws`, {
    headers: { authorization: `Bearer ${tokenFor(handle)}` },
  });
  ws.frames = [];
  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw.toString()); } catch { return; }
    if (m.type === 'presence') {
      ws.frames.push(m);
      console.log(`  [${label}] presence -> connected=${JSON.stringify(m.connected)}`);
    }
  });
  ws.on('open', () => resolve(ws));
  ws.on('error', (e) => reject(new Error(`${label}: ${e.message}`)));
  ws.on('unexpected-response', (_q, r) => reject(new Error(`${label}: HTTP ${r.statusCode}`)));
});
const wait = (ms) => new Promise(r => setTimeout(r, ms));

console.log(`room ${roomId}\n`);
console.log(`1. ${handleA} connects alone`);
const a = await open(handleA, handleA);
await wait(1500);

console.log(`\n2. ${handleB} joins — both sockets should see a 2-id list`);
const b = await open(handleB, handleB);
await wait(2000);

console.log(`\n3. ${handleB} disconnects — ${handleA} should drop back to 1`);
b.close();
await wait(2500);

const last = a.frames[a.frames.length - 1];
const peak = Math.max(...a.frames.map(f => (f.connected || []).length));
console.log('\nRESULT');
console.log(`  frames received      : ${a.frames.length}`);
console.log(`  field shape          : ${last && Array.isArray(last.connected) ? 'type=presence, connected=string[]  OK' : 'UNEXPECTED'}`);
console.log(`  peak connected count : ${peak}`);
console.log(`  final connected      : ${JSON.stringify(last?.connected)}`);
console.log(`  reacts to join/leave : ${peak >= 2 && (last?.connected || []).length < peak ? 'YES' : 'NO'}`);

a.close();
process.exit(0);
