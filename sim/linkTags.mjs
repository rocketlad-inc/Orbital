// ============================================================
// THE ADMIN LINK GENERATOR makes links the server reads back as the
// same tag (src/multiplayer/AdminLinkGenerator.tsx).
//
//   - the client's tag cleaning is the server's cleanTag(), input for input;
//   - the Stellaris Discord link, followed by a browser, lands as the
//     source "discord-stellaris" (and its campaign) in the visit table.
//
// Run: npm run sim:link-tags
// ============================================================

import worker from '../worker/index.js';
import { cleanTag as serverClean, readAttribution } from '../worker/attribution.js';
import { cleanTag as clientClean, buildLink } from '../src/multiplayer/AdminLinkGenerator.tsx';
import { SimD1 } from './d1.mjs';
import { MIGRATIONS } from '../worker/_migrations_bundle.js';

let failures = 0;
function check(label, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) { failures++; if (detail !== undefined) console.log(`        ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`); }
}

const inputs = ['Stellaris', 'discord-stellaris', '  r/Space  ', 'a b c', '--x--', 'Ünï cödé', 'a'.repeat(80), 'launch week!', '...', 'UPPER_case.9', ''];
const same = inputs.filter(i => clientClean(i) !== (serverClean(i) ?? ''));
check('the client cleans a tag exactly as the server does', same.length === 0, same);
check('...and the 40 / 60 character limits match', clientClean('a'.repeat(80), 60) === serverClean('a'.repeat(80), 60));

const link = buildLink('discord-stellaris', '');
check('the Stellaris Discord link is built as expected', link === 'https://orbital-empire.com/?from=discord-stellaris', link);
const withCampaign = buildLink('discord-stellaris', 'Launch Week');
check('a campaign rides along as utm_campaign', withCampaign === 'https://orbital-empire.com/?from=discord-stellaris&utm_campaign=launch-week', withCampaign);
check('no tag, no link', buildLink('', 'x') === null);

// What the landing page sends the server for that link, and what it stores.
const url = new URL(withCampaign);
const attr = readAttribution({ from: url.searchParams.get('from'), utm_campaign: url.searchParams.get('utm_campaign'), referrer: 'discord.com', landing: '/' });
check('the server reads it as source discord-stellaris, even from a discord.com referrer', attr?.source === 'discord-stellaris' && attr?.campaign === 'launch-week', attr);

const DB = new SimD1(':memory:');
DB.applyMigrations(MIGRATIONS);
DB.db.exec('CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
for (const m of MIGRATIONS) DB.db.prepare('INSERT OR IGNORE INTO _migrations (name, applied_at) VALUES (?, 0)').run(m.name);
const env = { DB, ROOM: { idFromName: n => n, get: () => ({ fetch: async () => Response.json({}) }) }, EMAIL_LINK_SECRET: 'sim' };
const res = await worker.fetch(new Request('https://orbital-empire.com/api/visit', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'user-agent': 'Mozilla/5.0 (sim browser)', 'cf-connecting-ip': '9.9.9.9' },
  body: JSON.stringify({ anon: 'simAnonStellaris1', step: 'land', a: { from: url.searchParams.get('from'), utm_campaign: url.searchParams.get('utm_campaign'), landing: '/' } }),
}), env, { waitUntil() {}, passThroughOnException() {} });
const row = await DB.prepare('SELECT source, campaign FROM campaign_visits WHERE anon_id = ?').bind('simAnonStellaris1').first();
check('a visit through the link is stored under discord-stellaris', res.status < 300 && row?.source === 'discord-stellaris' && row?.campaign === 'launch-week', { status: res.status, row });

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
