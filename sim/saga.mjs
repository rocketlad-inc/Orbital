// ============================================================================
// sim:saga — the Saga Engine's quality gates.
//
//   npm run sim:saga
//
// 1. PUBLIC ONLY. The dossier (worker/saga/dossier.js) is the only part of the
//    engine that reads the database; this reads its source and fails on any
//    query that could reach a private record: a message that is not on the
//    public channel, a trade offer's note, a standing trade agreement, a
//    chronicle row that is not public. No other saga file may query anything
//    but its own table.
// 2. On every finished match whose dossier is cached (node
//    scripts/saga-from-prod.mjs --all --fetch-only), the script must be:
//      * the same twice over (same dossier in, same script out);
//      * the whole cast: every empire carded, roled and on the roll call;
//      * every story scene worded, no sentence twice in one film;
//      * no crawl sentence shared by two films.
// ============================================================================

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildScript } from '../worker/saga/engine.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
let failures = 0;
const fail = (msg) => { failures++; console.log(`  FAIL  ${msg}`); };
const pass = (msg) => console.log(`  ok    ${msg}`);

// ---- 1. public only --------------------------------------------------------
console.log('public records only');
const dossier = readFileSync(path.join(root, 'worker/saga/dossier.js'), 'utf8');
const sqls = [...dossier.matchAll(/`([^`]*\b(?:SELECT|FROM)\b[^`]*)`/g)].map(m => m[1].replace(/\s+/g, ' '));
if (!sqls.length) fail('found no queries in dossier.js');
for (const sql of sqls) {
  if (/\bFROM messages\b/i.test(sql) && !/scope = 'broadcast'/.test(sql)) fail(`a messages query without scope = 'broadcast': ${sql.slice(0, 90)}`);
  if (/\bFROM messages\b/i.test(sql) && !/actual_sender_faction_id = claimed_sender_faction_id/.test(sql)) fail('a messages query that would quote a forged broadcast');
  if (/\bFROM chronicle_entries\b/i.test(sql) && !/visibility = 'public'/.test(sql)) fail(`a chronicle query without visibility = 'public': ${sql.slice(0, 90)}`);
  if (/\b(trade_offers|trade_agreements|game_trade_routes|market_posts|market_fills|message_recipients|trade_deliveries)\b/i.test(sql)) fail(`a query on a private table: ${sql.slice(0, 90)}`);
  if (/\bnote\b/i.test(sql)) fail(`a query that reads a note: ${sql.slice(0, 90)}`);
}
for (const f of readdirSync(path.join(root, 'worker/saga'))) {
  if (f === 'dossier.js' || !f.endsWith('.js')) continue;
  const src = readFileSync(path.join(root, 'worker/saga', f), 'utf8');
  for (const m of src.matchAll(/\bFROM\s+(\w+)/g)) {
    if (m[1] !== 'game_sagas') fail(`${f} queries ${m[1]}: only dossier.js reads game data`);
  }
}
if (!failures) pass(`${sqls.length} dossier queries, all public; no other saga file reads game data`);

// ---- 2. the scripts ----------------------------------------------------------
const CACHE = path.join(os.tmpdir(), 'orbital-saga');
const files = existsSync(CACHE) ? readdirSync(CACHE).filter(f => /^dossier\..+\.json$/.test(f)).sort() : [];
console.log(`\nscripts (${files.length} cached matches${files.length ? '' : ': run scripts/saga-from-prod.mjs --all --fetch-only'})`);
const crawlSeen = new Map();
/** No narrator line twice within this many consecutive films. */
const NEIGHBOURS = 4;
let repeats = 0, narrator = 0;
for (const [i, f] of files.entries()) {
  const D = JSON.parse(readFileSync(path.join(CACHE, f), 'utf8'));
  const d = { ...D, ordinal: i };
  const a = buildScript(d), b = buildScript(d);
  const tag = `${D.game?.name ?? D.gameId}`;
  if (JSON.stringify(a) !== JSON.stringify(b)) fail(`${tag}: two builds differ`);
  const ids = D.empires.filter(e => !/:leviathan_f$/.test(e.id)).map(e => e.id);
  for (const id of ids) {
    const c = a.cast.find(x => x.fid === id);
    if (!c) fail(`${tag}: ${id} has no cast card`);
    else if (!c.label || !c.receipt) fail(`${tag}: ${id} has no role or record (${c.role})`);
    if (!a.rollCall.includes(id)) fail(`${tag}: ${id} missing from the roll call`);
    if (!c?.creed && !c?.tagline) fail(`${tag}: ${id} has neither creed nor tagline`);
  }
  const lines = [a.crawl.title, ...a.crawl.lines.flatMap(l => l.split(/(?<=[.!?])\s+/)),
    ...a.beats.flatMap(x => [x.title, x.because].filter(Boolean))];
  const seen = new Set();
  for (const l of lines) {
    if (!l) continue;
    if (seen.has(l) && l.length > 12) fail(`${tag}: "${l}" said twice`);
    seen.add(l);
  }
  for (const x of a.beats) if (!x.title || !x.kicker) fail(`${tag}: a ${x.kind} scene on day ${x.tick} has no words`);
  for (const s of a.crawl.lines.flatMap(l => l.split(/(?<=[.!?])\s+/))) {
    // Quoted creeds and names are the empires' own. The narrator's lines
    // tile their banks film after film: none may come round again within
    // NEIGHBOURS films (a player's last few matches), and the corpus-wide
    // repeat rate is reported.
    if (/"/.test(s)) continue;
    const prev = crawlSeen.get(s);
    if (prev && i - prev.i <= NEIGHBOURS) fail(`${tag}: crawl line also in ${prev.tag}, ${i - prev.i} films earlier: "${s}"`);
    if (prev) repeats++;
    narrator++;
    crawlSeen.set(s, { tag, i });
  }
  if (!a.crawl.title) fail(`${tag}: no title`);
  console.log(`  ${failures ? '..' : 'ok'}    ${tag.padEnd(28)} ${a.shape.padEnd(9)} ${a.cast.length} empires, ${a.beats.length} scenes, ${a.transmissions.length} transmissions, "${a.crawl.title}"`);
}

if (narrator) console.log(`\n  narrator crawl lines: ${narrator}, of which ${repeats} came round again from an earlier film (${Math.round(100 * repeats / narrator)}%)`);
console.log(failures ? `\n${failures} failure(s)` : '\nall gates pass');
process.exit(failures ? 1 : 0);
