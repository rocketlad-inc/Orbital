#!/usr/bin/env node
// ============================================================
// THE CRUCIBLE: computer empires alone, on staging, at a fast tick
// (Lorne, 2026-10-24: "the crucible in which we test these AIs").
//
// Starts a solo game for an agent account, turns the agent's own seat
// into a computer empire too, switches on the turn log (games.ai_log,
// table ai_turn_log) and sets the tick. Nobody plays; everybody fights.
//
//   node scripts/crucible.mjs [--tick=7] [--difficulty=normal]
//        [--seats=snake,ally,warlord,snake,warlord,ally]
//
// The first seat is the agent's own. Needs ~/.orbital-staging-agent-key
// and wrangler logged in to the staging account. Read the result with
// scripts/crucible-report.mjs <gameId>.
// ============================================================

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const HOST = 'https://orbital-staging.lcfeeser.workers.dev';
const arg = (k, d) => process.argv.find(a => a.startsWith(`--${k}=`))?.split('=')[1] ?? d;
const tickS = Number(arg('tick', '7'));
const difficulty = arg('difficulty', 'normal');
const seats = arg('seats', 'snake,ally,warlord,snake,warlord,ally').split(',');
if (seats.length < 2 || seats.length > 6) throw new Error('2-6 seats');

const key = readFileSync(join(homedir(), '.orbital-staging-agent-key'), 'utf8').trim();
const sess = await (await fetch(`${HOST}/api/agent/session`, {
  method: 'POST', headers: { 'X-Agent-Key': key, 'content-type': 'application/json' },
  body: JSON.stringify({ handle: 'crucible' }),
})).json();
const auth = { authorization: `Bearer ${sess.token}`, 'content-type': 'application/json' };

const made = await (await fetch(`${HOST}/api/solo`, {
  method: 'POST', headers: auth,
  body: JSON.stringify({ rivals: seats.length - 1, difficulty, speed_ms: 30000, personalities: seats.slice(1) }),
})).json();
if (!made.ok) throw new Error(JSON.stringify(made));
const G = made.game_id;

const doctrine = { warlord: 'rusher', snake: 'schemer', ally: 'expander' }[seats[0]];
const sql = [
  `UPDATE game_factions SET ai_doctrine = '${doctrine}', ai_personality = '${seats[0]}', ai_personality_shown = 1
    WHERE game_id = '${G}' AND user_id = '${sess.user.id}'`,
  `UPDATE games SET ai_log = 1, tick_interval_ms = ${Math.round(tickS * 1000)} WHERE id = '${G}'`,
].join('; ');
execFileSync(process.execPath, [
  join(process.cwd(), 'node_modules/wrangler/bin/wrangler.js'),
  'd1', 'execute', 'orbital-staging', '--env', 'staging', '--remote', '--command', sql,
], { stdio: 'inherit' });

// Resume arms the room's alarm at the new tick.
const r = await (await fetch(`${HOST}/api/games/${G}/solo/resume`, { method: 'POST', headers: auth })).json();
console.log(JSON.stringify({ game_id: G, seats, difficulty, tick_s: tickS, resumed: r }, null, 2));
