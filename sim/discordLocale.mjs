// ============================================================
// Portuguese for everything the worker says outside email: the Discord
// bot, DMs, a game's feed, the OAuth result pages, the situation report.
//
// Drives the REAL code (signed Discord interactions into
// discord.handleInteractions, notify.sendDm, the feed routes, the OAuth
// callback) over SimD1, with fetch stubbed at Discord. What it pins:
//
//   * the two catalogs agree (same keys, same {placeholders}) and every
//     key the source asks for exists;
//   * a slash command answers in the linked account's language, else
//     Discord's interaction.locale, else English -- and the account WINS;
//   * /link saves the Discord client's language for an account that has
//     none (and never overwrites one that does);
//   * a DM is written in the recipient's users.locale, from the one
//     users read sendDm already made (no extra round trip);
//   * a game's feed speaks feed_locale, falling back to the host's own
//     language, then English;
//   * the OAuth pages follow Accept-Language, then the player's language;
//   * every slash command, option and choice carries a pt-BR localization
//     inside Discord's limits;
//   * English output did not change.
//
// Run: npm run sim:discordloc   (from the repo root)
// ============================================================

import fs from 'node:fs';
import { SimD1 } from './d1.mjs';
import { MIGRATIONS } from '../worker/_migrations_bundle.js';
import { catalogs, tr, trn, normalizeLocale } from '../worker/i18n.js';
import { WEIGHT_RULE } from '../worker/systems.js';
import * as discord from '../worker/discord.js';
import * as gameFeed from '../worker/gameFeed.js';
import * as oauth from '../worker/discordOauth.js';
import * as notify from '../worker/notify.js';
import { buildSituationReport } from '../worker/situationReport.js';

let bad = 0;
function check(label, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) { bad++; if (detail !== undefined) console.log(`        ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`); }
}

// ---- 1. the catalogs ------------------------------------------------------
{
  const { en, 'pt-BR': pt } = catalogs();
  const ph = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort().join(',');
  const worker = (k) => /^(dc|feed|alert|sitrep)\./.test(k);
  const enKeys = Object.keys(en).filter(worker);
  const ptKeys = Object.keys(pt).filter(worker);
  const missingPt = enKeys.filter(k => !(k in pt));
  const orphanPt = ptKeys.filter(k => !(k in en));
  const mismatched = ptKeys.filter(k => k in en && ph(en[k]) !== ph(pt[k]));
  check(`the catalogs carry ${enKeys.length} worker-side keys, every one translated`, enKeys.length > 300 && !missingPt.length, missingPt.slice(0, 8));
  check('no Portuguese key without an English source', !orphanPt.length, orphanPt.slice(0, 8));
  check('every translation keeps its {placeholders}', !mismatched.length, mismatched.slice(0, 8).map(k => `${k}: ${ph(en[k])} vs ${ph(pt[k])}`));
  const dup = enKeys.filter(k => /_one$/.test(k) && !(k.replace(/_one$/, '_other') in en));
  check('every _one has its _other', !dup.length, dup);

  // Every literal key the source asks for exists (plural pairs by base).
  const files = ['discord', 'commands', 'situationReport', 'notify', 'gameFeed', 'push', 'discordOauth', 'alerts', 'turnDigest',
    'messages', 'market', 'trades', 'senate', 'tradeAgreements', 'tradeRoutesV2', 'room', 'actions', 'wearRequests',
    'wars', 'battleCard', 'sunGates', 'alertText'];
  const asked = new Set();
  for (const f of files) {
    const src = fs.readFileSync(`worker/${f}.js`, 'utf8');
    for (const m of src.matchAll(/['"`]((?:dc|feed|alert|sitrep)\.[A-Za-z0-9_.]*[A-Za-z0-9_])['"`]/g)) {
      if (!m[1].endsWith('.')) asked.add(m[1]);
    }
  }
  const unknown = [...asked].filter(k => !(k in en) && !(`${k}_one` in en));
  check(`all ${asked.size} keys named in the worker source exist`, !unknown.length, unknown);
}

// ---- 2. English did not change ----------------------------------------------
check('the English weight rule is systems.js\'s own sentence', tr('en', 'dc.weightRule') === WEIGHT_RULE);
{
  const e = discord.dmConsentEmbed();
  check('the consent ask reads as it always did',
    e.title === '✅ Linked — do you want direct messages?'
    && e.description.includes('**📬 Yes, DM me** — the daily situation report at 6pm Eastern, a nudge when a vote is about to close without you, and messages other factions send you in-game.')
    && e.description.endsWith('_You can change this any time with_ `/notify` _or in-game under Notifications._'));
  check('and its buttons', discord.dmConsentButtons()[0].components.map(c => c.label).join('|') === 'Yes, DM me|Server only');
  check('plurals in English', trn('en', 'dc.votes', 1) === '1 vote' && trn('en', 'dc.votes', 3) === '3 votes'
    && trn('pt-BR', 'dc.votes', 0) === '0 voto' && trn('pt-BR', 'dc.votes', 2) === '2 votos');
}

// ---- 3. registration: Discord's limits ---------------------------------------
{
  const cmds = discord.SLASH_COMMANDS;
  const problems = [];
  const lim = (what, s) => { if (typeof s !== 'string' || s.length < 1 || s.length > 100) problems.push(`${what}: ${JSON.stringify(s)}`); };
  const walkOpt = (path, o) => {
    lim(`${path} description`, o.description);
    lim(`${path} pt-BR description`, o.description_localizations?.['pt-BR']);
    if (!/^[-_a-z0-9]{1,32}$/.test(o.name)) problems.push(`${path} name ${o.name}`);
    for (const c of o.choices ?? []) {
      lim(`${path}/${c.value} name`, c.name);
      lim(`${path}/${c.value} pt-BR name`, c.name_localizations?.['pt-BR']);
    }
  };
  for (const c of cmds) {
    walkOpt(`/${c.name}`, c);
    for (const o of c.options ?? []) walkOpt(`/${c.name} ${o.name}`, o);
  }
  check(`all ${cmds.length} commands, their options and choices carry pt-BR text within 1-100 characters`, !problems.length, problems);
  check('names stay English', cmds.map(c => c.name).join(',') === 'link,msg,status,fleet,research,bills,map,notify');
  const keys = new Set();
  for (const c of cmds) for (const o of c.options ?? []) for (const ch of o.choices ?? []) keys.add(Object.keys(ch.name_localizations ?? {}).join());
  check('the only localization language is pt-BR', [...keys].every(k => k === 'pt-BR'));
}

// ---- the world --------------------------------------------------------------
const DB = new SimD1(':memory:');
DB.applyMigrations(MIGRATIONS);
const prepared = [];
const realPrepare = DB.prepare.bind(DB);
DB.prepare = (sql) => { prepared.push(String(sql)); return realPrepare(sql); };

const kp = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
const pubHex = [...new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey))].map(b => b.toString(16).padStart(2, '0')).join('');
const env = { DB, DISCORD_PUBLIC_KEY: pubHex, DISCORD_BOT_TOKEN: 'sim-token' };

// Discord, stubbed: DM channels open, messages are recorded.
const posted = [];
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  const body = init.body ? JSON.parse(init.body) : null;
  if (u.endsWith('/users/@me/channels')) return Response.json({ id: `dm-${body.recipient_id}` });
  if (/\/channels\/[^/]+\/messages$/.test(u) && init.method === 'POST') {
    posted.push({ channel: u.match(/channels\/([^/]+)\//)[1], body });
    return Response.json({ id: `m${posted.length}` });
  }
  if (/\/webhooks\//.test(u) && init.method === 'POST') {
    posted.push({ channel: 'webhook', body });
    return Response.json({});
  }
  return Response.json({});
};

const user = (id, o = {}) => DB.prepare(
  `INSERT INTO users (id,email,display_name,password_hash,created_at,discord_id,locale,dm_consent)
   VALUES (?,?,?,?,0,?,?,?)`,
).bind(id, `${id}@t`, id, 'x', o.discord ?? null, o.locale ?? null, o.consent ?? null).run();

await user('uPt', { discord: 'D_PT', consent: 1 });                  // linked, no saved language
await user('uEn', { discord: 'D_EN', locale: 'en', consent: 1 });    // linked, chose English
await user('uBr', { discord: 'D_BR', locale: 'pt-BR', consent: 1 }); // linked, chose Portuguese
await user('uAsk', { discord: 'D_ASK' });                            // linked, never answered the DM question
await user('uHost', { locale: 'pt-BR' });                            // a host who speaks Portuguese
await user('uHostNone');                                             // a host with no language saved
await user('uGuest');

const interact = async (body) => {
  const raw = JSON.stringify(body);
  const ts = String(Date.now());
  const sig = [...new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, kp.privateKey, new TextEncoder().encode(ts + raw)))]
    .map(b => b.toString(16).padStart(2, '0')).join('');
  const res = await discord.handleInteractions(new Request('https://orbital-empire.com/api/discord/interactions', {
    method: 'POST', headers: { 'x-signature-ed25519': sig, 'x-signature-timestamp': ts }, body: raw,
  }), env);
  return res.json();
};
const slash = (name, discordId, locale, options) => interact({
  type: 2, locale, application_id: 'app', token: 'tok',
  member: { user: { id: discordId, username: discordId } },
  data: { name, options },
});
const text = (r) => `${r.data?.content ?? ''} ${(r.data?.embeds ?? []).map(e => `${e.title ?? ''} ${e.description ?? ''} ${(e.fields ?? []).map(f => f.name).join(' ')}`).join(' ')}`;

// ---- 4. slash commands ------------------------------------------------------
{
  let r = await slash('status', 'D_NOBODY', 'pt-BR');
  check('an unlinked Brazilian client gets Portuguese', /^Vincule sua conta primeiro/.test(r.data.content), r.data.content);
  r = await slash('status', 'D_NOBODY');
  check('no locale at all: English', /^Link your account first/.test(r.data.content), r.data.content);
  r = await slash('status', 'D_NOBODY', 'fr');
  check('a language we do not write: English', /^Link your account first/.test(r.data.content));
  r = await slash('status', 'D_NOBODY', 'pt');
  check('plain "pt" is Portuguese too', /^Vincule sua conta/.test(r.data.content));

  r = await slash('status', 'D_PT', 'pt-BR');
  check('a linked account with no saved language follows Discord (pt-BR)', /Você não tem um império ativo/.test(r.data.content), r.data.content);
  r = await slash('status', 'D_PT', 'en-US');
  check('...and Discord saying English gives English', /You have no active empire/.test(r.data.content));
  r = await slash('status', 'D_EN', 'pt-BR');
  check('an account that chose English keeps English though Discord says pt-BR', /You have no active empire/.test(r.data.content), r.data.content);
  r = await slash('status', 'D_BR', 'en-US');
  check('an account that chose Portuguese keeps it though Discord says en-US', /Você não tem um império ativo/.test(r.data.content));

  // A real empire, so the embeds are exercised.
  await DB.prepare(`INSERT INTO rooms (id,name,host_id,created_at,updated_at) VALUES ('gloc','Loc','uHost',0,0)`).run();
  await DB.prepare(`INSERT INTO games (id,status,map_seed,current_tick,created_at,tick_interval_ms) VALUES ('gloc','active','s',100,0,3600000)`).run();
  await DB.prepare(`INSERT INTO game_factions (id,game_id,user_id,slot,name,color,status,capital_body_id,reputation,senate_weight,metal,fuel,gold,science,research_progress,joined_at)
                    VALUES ('fBr','gloc','uBr',0,'Brasa','#ff7043','active',NULL,0,1,10,0,20,30,0,0),
                           ('fEn','gloc','uEn',1,'Embers','#4ecdc4','active',NULL,0,1,10,0,20,30,0,0)`).run();
  r = await slash('status', 'D_BR');
  const t = text(r);
  check('/status in Portuguese: fields and footer', /Recursos/.test(t) && /Domínios/.test(t) && /Construção/.test(t) && /próximo turno|T\+100/.test(r.data.embeds[0].footer.text), t);
  r = await slash('status', 'D_EN');
  check('/status in English is the original wording', /Resources/.test(text(r)) && /Holdings/.test(text(r)) && /Building/.test(text(r)));
  r = await slash('fleet', 'D_BR');
  check('/fleet with no ships', /Você não tem naves/.test(r.data.content));
  r = await slash('bills', 'D_BR');
  check('/bills with an empty floor', /Nada em pauta no Senado/.test(r.data.content));
  r = await slash('research', 'D_BR');
  check('/research with none', /Nenhuma pesquisa ainda/.test(r.data.content));
  r = await slash('msg', 'D_BR', undefined, [{ name: 'to', value: 'embers' }, { name: 'text', value: '' }]);
  check('/msg usage line in Portuguese', /Uso: `\/msg/.test(r.data.content), r.data.content);
  r = await slash('msg', 'D_BR', undefined, [{ name: 'to', value: 'nobody' }, { name: 'text', value: 'oi' }]);
  check('/msg to nobody: a Portuguese sentence', /Nenhuma facção corresponde a "nobody"/.test(r.data.content), r.data.content);
  r = await slash('nosuch', 'D_BR', 'pt-BR');
  check('an unknown command', /Comando desconhecido/.test(r.data.content));

  r = await slash('notify', 'D_ASK', 'pt-BR');
  check('/notify before the DM question: the consent ask, in Portuguese, with Portuguese buttons',
    /Conta vinculada/.test(r.data.embeds[0].title) && r.data.components[0].components[0].label === 'Sim, me mande DMs', JSON.stringify(r.data.embeds?.[0]?.title));
  r = await slash('notify', 'D_BR', undefined, [{ name: 'category', value: 'senate' }, { name: 'state', value: 'off' }]);
  check('/notify lists categories in Portuguese', /Suas notificações do Orbital/.test(r.data.content) && /Projetos do Senado/.test(r.data.content), r.data.content);
  r = await slash('notify', 'D_EN', 'pt-BR');
  check('...and in English for the account that chose English', /Your Orbital notifications/.test(r.data.content));
}

// ---- 5. /link adopts the Discord client's language ---------------------------
{
  const code = (c, uid) => DB.prepare('INSERT INTO discord_link_codes (code,user_id,created_at,expires_at) VALUES (?,?,0,?)').bind(c, uid, Date.now() + 600000).run();
  const locOf = async (id) => (await DB.prepare('SELECT locale FROM users WHERE id = ?').bind(id).first()).locale;

  await code('AAAAAA', 'uGuest');
  let r = await slash('link', 'D_G1', 'pt-BR', [{ name: 'code', value: 'aaaaaa' }]);
  check('/link from a Portuguese client answers in Portuguese', /Conta vinculada/.test(r.data.embeds[0].title), JSON.stringify(r.data));
  check('...and saves pt-BR on an account that had no language', (await locOf('uGuest')) === 'pt-BR');

  await DB.prepare('INSERT INTO users (id,email,display_name,password_hash,created_at,locale) VALUES (?,?,?,?,0,?)').bind('uChose', 'c@t', 'c', 'x', 'en').run();
  await code('BBBBBB', 'uChose');
  r = await slash('link', 'D_G2', 'pt-BR', [{ name: 'code', value: 'BBBBBB' }]);
  check('an account that chose English is not overwritten, and the reply is English',
    (await locOf('uChose')) === 'en' && /Linked/.test(r.data.embeds[0].title), `${await locOf('uChose')} ${r.data.embeds?.[0]?.title}`);

  await DB.prepare('INSERT INTO users (id,email,display_name,password_hash,created_at) VALUES (?,?,?,?,0)').bind('uFr', 'f@t', 'f', 'x').run();
  await code('CCCCCC', 'uFr');
  r = await slash('link', 'D_G3', 'fr', [{ name: 'code', value: 'CCCCCC' }]);
  check('a language we do not write saves nothing', (await locOf('uFr')) === null && /Linked/.test(r.data.embeds[0].title));

  r = await slash('link', 'D_G4', 'pt-BR', [{ name: 'code', value: 'ZZZZZZ' }]);
  check('a bad code, in Portuguese', /inválido ou expirou/.test(r.data.content));
  r = await slash('link', 'D_G4', 'pt-BR', []);
  check('no code: the usage line, in Portuguese', /^Uso: `\/link/.test(r.data.content));
}

// ---- 6. the consent button sends the welcome DM in the same language ----------
{
  posted.length = 0;
  const r = await interact({
    type: 3, locale: 'pt-BR', data: { custom_id: 'dmconsent:yes' },
    member: { user: { id: 'D_ASK' } },
  });
  const dm = posted.find(p => p.channel === 'dm-D_ASK');
  check('"Yes, DM me" in a Portuguese client: the welcome DM is Portuguese', dm?.body.embeds[0].title === '📬 Tudo pronto', dm?.body.embeds?.[0]?.title);
  check('...and so is the reply to the click', /DMs ativadas/.test(r.data.content), r.data.content);
}

// ---- 6b. a vote click: the clicker's confirmation vs the shared card -------------
{
  await DB.prepare(`INSERT INTO senate_proposals (id,game_id,proposer_faction_id,kind,title,summary,payload,status,proposed_at_tick,vote_opens_at_tick,vote_closes_at_tick)
                    VALUES ('prop1','gloc','fBr','trade_embargo','No trade at all','','{}','voting',90,90,120)`).run();
  const click = (did, locale) => interact({
    type: 3, locale, application_id: 'app', token: 'tok', data: { custom_id: 'orb:v:prop1:yea' }, member: { user: { id: did } },
  });
  posted.length = 0;
  let r = await click('D_BR', 'en-US');
  await new Promise(res => setTimeout(res, 20));
  let conf = posted.find(p => p.channel === 'webhook');
  check('a Portuguese account\'s vote confirmation is Portuguese (even from an English client)', /Seu voto foi registrado como \*\*✅ Sim\*\*/.test(conf?.body.content), conf?.body);
  check('the shared card follows the GAME\'s feed language (host: Portuguese)',
    r.type === 7 && /Votação no Senado — No trade at all/.test(r.data.embeds[0].title) && r.data.components[0].components[0].label === 'Sim', r.data?.embeds?.[0]?.title);
  posted.length = 0;
  r = await click('D_EN', 'pt-BR');
  await new Promise(res => setTimeout(res, 20));
  conf = posted.find(p => p.channel === 'webhook');
  check('an English account\'s confirmation is English, though the card everyone shares is Portuguese',
    /Your vote is recorded as \*\*✅ Yea\*\*/.test(conf?.body.content) && /Votação no Senado/.test(r.data.embeds[0].title), conf?.body);
  check('the tally line counts in the card\'s language', /Sim \*\*\d+\*\* _\(2 votos\)_/.test(r.data.embeds[0].fields[0].value), r.data.embeds[0].fields[0].value);
  r = await slash('bills', 'D_BR');
  check('/bills lists the bill and how you voted, in Portuguese',
    /Em pauta/.test(r.data.embeds[0].title) && /você votou \*\*sim\*\*/.test(r.data.embeds[0].description)
    && /fecha em T\+120 \(20\)/.test(r.data.embeds[0].description), r.data.embeds?.[0]?.description);
  r = await slash('bills', 'D_EN');
  check('...and in English, as before', /On the floor/.test(r.data.embeds[0].title) && /you voted \*\*yea\*\*/.test(r.data.embeds[0].description)
    && /closes T\+120 \(20\)/.test(r.data.embeds[0].description));
}

// ---- 7. DMs follow users.locale, from the read sendDm already makes -------------
{
  const mk = (title) => (L) => ({ title: `${title}:${L}`, description: tr(L, 'alert.vote.how') });
  posted.length = 0; prepared.length = 0;
  await notify.sendDm(env, { userId: 'uBr', category: 'dm', dedupeKey: 'k1', embed: mk('x') });
  const reads = prepared.filter(s => /FROM users WHERE id = \?/.test(s) && /discord_id/.test(s));
  const extra = prepared.filter(s => /SELECT locale FROM users/.test(s));
  const dmPt = posted.find(p => p.channel === 'dm-D_BR');
  check('a DM to a Portuguese account is written in Portuguese', dmPt?.body.embeds[0].title === 'x:pt-BR'
    && /Você pode votar/.test(dmPt.body.embeds[0].description), dmPt?.body);
  check('the language rode on the one users read sendDm makes (no extra round trip)', reads.length === 1 && reads[0].includes('locale') && !extra.length, { reads, extra });

  await notify.sendDm(env, { userId: 'uEn', category: 'dm', dedupeKey: 'k2', embed: mk('x') });
  check('an English account gets English', posted.find(p => p.channel === 'dm-D_EN')?.body.embeds[0].title === 'x:en');
  await notify.sendDm(env, { userId: 'uPt', category: 'dm', dedupeKey: 'k3', embed: mk('x') });
  check('an account with no language gets English (the Discord client\'s language only speaks to slash commands)',
    posted.find(p => p.channel === 'dm-D_PT')?.body.embeds[0].title === 'x:en');
  await notify.sendDm(env, { userId: 'uBr', category: 'dm', dedupeKey: 'k4', embed: { title: 'plain', description: 'object' } });
  check('a plain embed object still goes out untouched', posted.filter(p => p.channel === 'dm-D_BR').pop()?.body.embeds[0].title === 'plain');

  // Buttons built per recipient.
  await notify.sendDm(env, {
    userId: 'uBr', category: 'dm', dedupeKey: 'k5',
    embed: (L) => ({ title: 'b', description: 'b' }),
    components: (L) => [{ type: 1, components: [{ type: 2, style: 3, label: tr(L, 'alert.market.take'), custom_id: 'x' }] }],
  });
  check('component rows are built in the recipient\'s language too',
    posted.filter(p => p.channel === 'dm-D_BR').pop()?.body.components[0].components[0].label === 'Aceitar');

  // A real producer: the upkeep-arrears alert, one recipient per language.
  await DB.prepare(`UPDATE game_factions SET arrears_gold = 40, arrears_metal = 5 WHERE id IN ('fBr','fEn')`).run();
  posted.length = 0;
  const alerts = await import('../worker/alerts.js');
  await alerts.runTickAlerts(env, 'gloc', 100);
  const arrBr = posted.find(p => p.channel === 'dm-D_BR')?.body.embeds[0];
  const arrEn = posted.find(p => p.channel === 'dm-D_EN')?.body.embeds[0];
  check('the arrears alert reaches a Portuguese account in Portuguese',
    arrBr?.title === '💸 Manutenção da frota em atraso' && /Devendo: \*\*40\*\*C · \*\*5\*\*M/.test(arrBr.description), arrBr);
  check('...and an English account in the original English',
    arrEn?.title === '💸 Fleet upkeep unpaid' && arrEn.description === 'Owed: **40**C · **5**M\nUnpaid fleets fight at reduced damage until settled.'
    && arrEn.footer.text === 'Orbital · Loc · T+100', arrEn);

  check('category labels follow the language', notify.categoryLabel('pt-BR', 'senate') === 'Projetos do Senado e votações prestes a fechar'
    && notify.categoryLabel('en', 'senate') === notify.CATEGORIES.senate);
  check('every category has a label in both languages',
    Object.keys(notify.CATEGORIES).every(k => tr('en', `alert.cat.${k}`) === notify.CATEGORIES[k] && tr('pt-BR', `alert.cat.${k}`) !== tr('en', `alert.cat.${k}`)));
}

// ---- 8. the situation report --------------------------------------------------
{
  const pt = await buildSituationReport(env, 'gloc', 'uBr', 'pt-BR');
  const en = await buildSituationReport(env, 'gloc', 'uEn');
  check('the daily report: a Portuguese title and footer', /Relatório de situação — Tudo calmo/.test(pt.embed.title) && /para mudar o que chega/.test(pt.embed.footer.text), pt.embed.title);
  check('...with its fields in Portuguese', pt.embed.fields.some(f => f.name === '📊 Seu império'), pt.embed.fields.map(f => f.name));
  check('and the English one unchanged', en.embed.title === '🛰️ Situation Report — All quiet' && en.embed.footer.text === 'Orbital · /notify to change what reaches you'
    && en.embed.fields.some(f => f.name === '📊 Your empire'));
}

// ---- 9. a game's feed -----------------------------------------------------------
{
  const session = (id) => ({ session: { user_id: id }, params: { gameId: 'gfeed1' } });
  const put = async (uid, body) => {
    const route = gameFeed.routes.find(r => r.method === 'PUT' && String(r.pattern).includes('feed$'));
    const res = await route.handle(new Request('https://x/', { method: 'PUT', body: JSON.stringify(body) }), env, session(uid));
    return { status: res.status, body: await res.json() };
  };
  const get = async (uid) => {
    const route = gameFeed.routes.find(r => r.method === 'GET' && String(r.pattern).includes('feed$'));
    const res = await route.handle(new Request('https://x/'), env, session(uid));
    return res.json();
  };
  await DB.prepare(`INSERT INTO rooms (id,name,host_id,created_at,updated_at) VALUES ('gfeed1','Feedgame','uHost',0,0)`).run();
  await DB.prepare(`INSERT INTO room_members (room_id,user_id,joined_at) VALUES ('gfeed1','uHost',0)`).run().catch(() => {});

  check('a feed with nothing chosen follows the host\'s language', (await gameFeed.feedLocale(env, 'gfeed1')) === 'pt-BR');
  let r = await put('uHost', { level: 'all' });
  check('setting the level alone works and shows no language pick', r.status === 200 && r.body.level === 'all' && r.body.feed_locale === null, r);
  r = await put('uHost', { feed_locale: 'en' });
  check('the host can pick a language for the game', r.status === 200 && r.body.feed_locale === 'en' && r.body.level === 'all', r);
  check('...and it beats the host\'s own', (await gameFeed.feedLocale(env, 'gfeed1')) === 'en');
  r = await put('uHost', { feed_locale: 'pt_BR' });
  check('pt_BR is understood', r.status === 200 && r.body.feed_locale === 'pt-BR');
  r = await put('uHost', { feed_locale: 'xx' });
  check('an unsupported language is refused', r.status === 400);
  r = await put('uHost', { feed_locale: 'en' });
  r = await put('uHost', { feed_locale: null });
  check('null returns to "same as the host\'s"', r.status === 200 && r.body.feed_locale === null && (await gameFeed.feedLocale(env, 'gfeed1')) === 'pt-BR');
  r = await put('uGuest', { feed_locale: 'en' });
  check('only the host may choose', r.status === 403 || r.status === 404, r.status);
  r = await put('uHost', {});
  check('an empty body is still refused as before', r.status === 400);
  check('GET shows the pick', (await get('uHost')).feed_locale === null);

  // The host has no language: English.
  await DB.prepare(`INSERT INTO rooms (id,name,host_id,created_at,updated_at) VALUES ('gnone1','None','uHostNone',0,0)`).run();
  check('no pick and a host with no language: English', (await gameFeed.feedLocale(env, 'gnone1')) === 'en');
  check('a game that does not exist: English', (await gameFeed.feedLocale(env, 'gghost')) === 'en');

  // A real post, end to end.
  await DB.prepare(`UPDATE game_feeds SET level = 'all', thread_id = 'thread1' WHERE game_id = 'gfeed1'`).run();
  posted.length = 0;
  let out = await discord.publishLawExpired(env, 'gfeed1', { title: 'Cheap ships', kind: 'slider_law', ticksInForce: 24 });
  let p = posted.find(x => x.channel === 'thread1');
  check('a law-lapsed card is posted in the host\'s Portuguese', out.posted && p?.body.embeds[0].title === '⌛  Expirou — Cheap ships'
    && /Lei de regra/.test(p.body.embeds[0].description) && /24\*\* turnos/.test(p.body.embeds[0].description), p?.body.embeds[0]);
  await put('uHost', { feed_locale: 'en' });
  posted.length = 0;
  await discord.publishLawExpired(env, 'gfeed1', { title: 'Cheap ships', kind: 'slider_law', ticksInForce: 24 });
  p = posted.find(x => x.channel === 'thread1');
  check('the same card, once the host picks English, is the original English',
    p?.body.embeds[0].title === '⌛  Lapsed — Cheap ships'
    && p.body.embeds[0].description === '**Bill:** Slider Law\n\nIts window has closed. Whatever it changed is back to normal after **24** ticks in force.\n\n_The chamber may pass it again._',
    p?.body.embeds[0]);
  await put('uHost', { feed_locale: 'pt-BR' });
  posted.length = 0;
  await discord.postChannelEmbed(env, (L) => ({ title: `post:${L}` }), 'gfeed1', { headline: true });
  check('postChannelEmbed hands a builder the feed\'s language', posted.find(x => x.channel === 'thread1')?.body.embeds[0].title === 'post:pt-BR');
  posted.length = 0;
  await discord.publishSenateResolved(env, 'gfeed1', { id: 'p1', kind: 'trade_embargo', title: 'No trade', payload: '{}' },
    { passed: false, quorumMet: false, cast: 1, required: 3, eligible: 4, yea: 1, nay: 0, abstain: 0, tick: 5 });
  p = posted.find(x => x.channel === 'thread1');
  check('a Senate result with no quorum, in Portuguese',
    /Sem quórum — No trade/.test(p?.body.embeds[0].title) && /Só \*\*1\*\* de \*\*4\*\*/.test(p.body.embeds[0].description)
    && p.body.embeds[0].fields.some(f => f.name === 'Quórum' && /NÃO atingido/.test(f.value)), p?.body.embeds[0]);
  check('the weight rule rides along in Portuguese', /Peso do voto = 1 \+ 1 por sistema/.test(p.body.embeds[0].description));
}

// ---- 10. the OAuth pages ---------------------------------------------------------
{
  const call = async (headers, userId) => {
    const url = new URL('https://orbital-empire.com/api/discord/oauth/callback');
    const res = await oauth.handleOauthCallback(new Request(url, { headers }), env, { url });
    return { status: res.status, html: await res.text() };
  };
  let r = await call({ 'accept-language': 'pt-BR,pt;q=0.9,en;q=0.8' });
  check('the cancelled-sign-in page follows Accept-Language', r.status === 400 && /<title>Login cancelado<\/title>/.test(r.html) && /lang="pt-BR"/.test(r.html) && /Voltar ao Orbital/.test(r.html), r.html.slice(0, 200));
  r = await call({});
  check('with no header: English, and the page is byte-for-byte the old shape',
    /<html><head>/.test(r.html) && /<title>Sign-in cancelled<\/title>/.test(r.html) && /Return to Orbital/.test(r.html));
  r = await call({ 'accept-language': 'fr-FR,fr;q=0.9' });
  check('a language we do not write: English', /Sign-in cancelled/.test(r.html));

  const bare = new Request('https://orbital-empire.com/x');
  check('without a header the signed-in player\'s language is used', (await oauth.pageLocale(env, bare, 'uBr')) === 'pt-BR');
  check('...a header outranks it', (await oauth.pageLocale(env, new Request('https://x/', { headers: { 'accept-language': 'en-GB' } }), 'uBr')) === 'en');
  check('...and an unknown player is English', (await oauth.pageLocale(env, bare, 'nobody')) === 'en');

  const failing = await oauth.tokenFailurePage(new Response('{"error":"invalid_client"}', { status: 401 }), 'connection', 'sim', 'pt-BR');
  check('the credentials-refused page, in Portuguese', /não conseguiu concluir a conexão/.test(await failing.text()));
  const stale = await oauth.tokenFailurePage(new Response('nope', { status: 400 }), 'sign-in', 'sim');
  const staleHtml = await stale.text();
  check('and in English by default, exactly as before', /<title>Discord refused the sign-in<\/title>/.test(staleHtml) && /The link from Discord had expired\. Start again from the game\./.test(staleHtml));
  const consent = await oauth.page('A', 'B', true, 'pt-BR');
  check('page() sets the document language for a translated page', /<html lang="pt-BR">/.test(await consent.text()));
}

console.log(bad ? `\n${bad} check(s) FAILED` : '\nall passed');
if (bad) process.exit(1);
