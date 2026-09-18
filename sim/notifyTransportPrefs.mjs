// ============================================================
// PER-TRANSPORT NOTIFICATION PREFERENCES — the phone and the DM are
// allowed to disagree, and neither may quietly answer for the other.
//
// The risk this pins is asymmetric and invisible. If a phone write
// touched `enabled`, a player turning OFF a lock-screen alert would
// silently stop their Discord DMs too. If a Discord write cleared
// push_enabled, the reverse. Both failures look like nothing at all —
// the player simply stops hearing about something and has no way to
// know a switch they never touched moved.
//
// Drives the real worker/notify.js against a real migrated database.
//
// Run: node sim/notifyTransportPrefs.mjs
// ============================================================

import { SimD1 } from './d1.mjs';
import { MIGRATIONS } from '../worker/_migrations_bundle.js';

let bad = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !detail ? '' : `\n        ${detail}`}`);
  if (!ok) bad++;
}

const DB = new SimD1(':memory:');
DB.applyMigrations(MIGRATIONS);
const env = { DB };
await DB.prepare(
  `INSERT INTO users (id,email,display_name,password_hash,created_at)
   VALUES ('u1','a@t','A','x',0), ('u2','b@t','B','x',0)`,
).run();

const notify = await import('../worker/notify.js');
const on = (user, cat, transport) => notify.categoryEnabled(env, user, cat, transport);

// ---- 1. Untouched accounts hear everything, on both transports -----
check('default: phone on', await on('u1', 'senate', 'push') === true);
check('default: discord on', await on('u1', 'senate', 'discord') === true);

// ---- 2. A shared mute still means everywhere ------------------------
// The old behaviour, and the one people expect from a single switch.
// NULL push_enabled must read as "follow enabled", not as "off".
await notify.setPref(env, 'u1', 'senate', false, 'discord');
check('discord mute silences discord', await on('u1', 'senate', 'discord') === false);
check('discord mute ALSO silences the phone while untouched',
  await on('u1', 'senate', 'push') === false);

// ---- 3. Until the player says otherwise -----------------------------
await notify.setPref(env, 'u1', 'senate', true, 'push');
check('phone can be turned back on independently', await on('u1', 'senate', 'push') === true);
check('...without un-muting discord', await on('u1', 'senate', 'discord') === false);

// ---- 4. The dangerous direction: a phone write on a fresh category --
// No row exists for 'dm' yet. Writing the phone side must INSERT with
// enabled = 1 rather than defaulting Discord to off.
check('precondition: no dm row yet', await on('u2', 'dm', 'discord') === true);
await notify.setPref(env, 'u2', 'dm', false, 'push');
check('phone-off on a fresh category silences the phone',
  await on('u2', 'dm', 'push') === false);
check('...and leaves discord alone', await on('u2', 'dm', 'discord') === true);

// ---- 5. ...and the reverse ------------------------------------------
await notify.setPref(env, 'u2', 'market', false, 'discord');
check('discord-off then phone-on keeps them independent',
  await on('u2', 'market', 'discord') === false);
await notify.setPref(env, 'u2', 'market', true, 'push');
check('phone survives a later discord write', await on('u2', 'market', 'push') === true);
await notify.setPref(env, 'u2', 'market', true, 'discord');
check('discord write does not clobber an explicit phone answer',
  await on('u2', 'market', 'push') === true);

// ---- 6. getPrefs reports per transport ------------------------------
const dm = await notify.getPrefs(env, 'u1');
const ph = await notify.getPrefs(env, 'u1', 'push');
check('getPrefs default arg is the discord view', dm.senate === false);
check('getPrefs push view differs', ph.senate === true);
check('getPrefs covers every declared category',
  Object.keys(ph).length === Object.keys(notify.CATEGORIES).length);

// ---- 7. setAllPrefs is transport-scoped -----------------------------
await notify.setAllPrefs(env, 'u1', false, 'push');
const ph2 = await notify.getPrefs(env, 'u1', 'push');
const dm2 = await notify.getPrefs(env, 'u1');
check('mute-all on the phone silences every phone category',
  Object.values(ph2).every(v => v === false));
check('...and does not touch discord categories that were on',
  dm2.dm === true && dm2.market === true);

// ---- 8. Every category that can be SENT can also be MUTED -----------
// The failure this catches shipped once already: 'trade' had a producer
// and no CATEGORIES entry, so it reached players through a switch that
// did not exist in any settings surface.
check('trade is declared', 'trade' in notify.CATEGORIES,
  'a category with a producer and no entry cannot be turned off');
check('unknown categories are rejected',
  await notify.setPref(env, 'u1', 'not_a_category', false, 'push') === false);

// ---- 9. The revived categories land on the phone, not in the DMs -----
// combat and inbound were removed for over-firing as Discord DMs. They
// come back defaulted the other way round, and a player who has said
// nothing must see exactly that.
for (const cat of ['combat', 'inbound']) {
  check(`${cat} defaults ON for the phone`, await on('u2', cat, 'push') === true);
  check(`${cat} defaults OFF for discord`, await on('u2', cat, 'discord') === false);
}
const fresh = await notify.getPrefs(env, 'u2');
const freshPush = await notify.getPrefs(env, 'u2', 'push');
check('getPrefs reports the discord default, not a blanket true',
  fresh.combat === false && fresh.inbound === false);
check('...and the phone default', freshPush.combat === true && freshPush.inbound === true);

// ---- 10. A phone write must not switch Discord ON by the back door ---
// setPref inserts a row when none exists, and that insert has to seed
// `enabled` from the category default. Seeding it to 1 would turn combat
// DMs on for someone who only ever touched a phone switch.
await notify.setPref(env, 'u2', 'combat', false, 'push');
check('phone-off on a defaulted-off category leaves discord off',
  await on('u2', 'combat', 'discord') === false);
check('...and the phone is genuinely off', await on('u2', 'combat', 'push') === false);

// A player who explicitly wants combat in Discord still can.
await notify.setPref(env, 'u2', 'combat', true, 'discord');
check('discord can be opted INTO for a defaulted-off category',
  await on('u2', 'combat', 'discord') === true);
check('...without disturbing the explicit phone answer',
  await on('u2', 'combat', 'push') === false);

console.log(bad ? `\n${bad} FAILED` : '\nall checks passed');
process.exit(bad ? 1 : 0);
