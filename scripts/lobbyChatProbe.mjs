// ============================================================================
// lobbyChatProbe.mjs — does a pre-game lobby chat line reach the other
// player, and does it survive a reconnect?
//
// Player reports had two symptoms tangled together ("messages vanish on
// refresh" AND "nobody answers, like they never sent"), which have very
// different causes: the first is missing persistence, the second would be
// broken delivery. Reading the code says delivery is fine, but "the code
// looks right" is not evidence, so this connects two REAL sessions to the
// live room and watches what actually arrives.
//
//   node scripts/lobbyChatProbe.mjs <roomId> <handleA> <handleB>
//
// Reads .agent.session directly and never prints a token.
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// `ws` is CommonJS and sets module.exports = WebSocket, so the DEFAULT
// import is the constructor itself — there is no named export to destructure.
import WebSocket from 'ws';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.ORBITAL_BASE || 'orbital-empire.com';
const [roomId, handleA, handleB] = process.argv.slice(2);
if (!roomId || !handleA || !handleB) {
  console.error('usage: node scripts/lobbyChatProbe.mjs <roomId> <handleA> <handleB>');
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
  ws.received = [];
  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw.toString()); } catch { return; }
    if (m.type === 'chat') {
      ws.received.push(m);
      console.log(`  [${label}] RECEIVED chat from ${m.from?.displayName}: "${m.text}"`);
    }
  });
  ws.on('open', () => resolve(ws));
  ws.on('error', (e) => reject(new Error(`${label}: ${e.message}`)));
  ws.on('unexpected-response', (_q, res) => reject(new Error(`${label}: HTTP ${res.statusCode}`)));
});

const wait = (ms) => new Promise(r => setTimeout(r, ms));

console.log(`room ${roomId} — connecting both players`);
const a = await open(handleA, handleA);
const b = await open(handleB, handleB);
console.log('both sockets open\n');

// --- 1. LIVE DELIVERY: B speaks while A is listening.
const text = `probe-${Date.now()}`;
console.log(`1. LIVE DELIVERY — ${handleB} sends "${text}"`);
b.send(JSON.stringify({ type: 'chat', text }));
await wait(2500);
const gotA = a.received.some(m => m.text === text);
const gotB = b.received.some(m => m.text === text);
console.log(`   -> listener (${handleA}) saw it: ${gotA}`);
console.log(`   -> sender   (${handleB}) saw its own echo: ${gotB}\n`);

// --- 2. PERSISTENCE: a FRESH socket joins after the fact. If the server
//     kept any history it would replay here.
console.log(`2. PERSISTENCE — ${handleA} reconnects (simulates a refresh)`);
a.close();
await wait(1200);
const a2 = await open(handleA, `${handleA}#2`);
await wait(3000);
const replayed = a2.received.length;
console.log(`   -> chat lines replayed to the reconnected client: ${replayed}\n`);

console.log('RESULT');
console.log(`  live delivery to other player : ${gotA ? 'WORKS' : 'BROKEN'}`);
console.log(`  history after reconnect       : ${replayed > 0 ? 'PERSISTED' : 'NOTHING — all history lost'}`);

a2.close(); b.close();
process.exit(0);
