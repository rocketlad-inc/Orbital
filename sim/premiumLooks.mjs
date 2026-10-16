// ============================================================
// premiumLooks — every new design sits behind the Commission.
//
//   node sim/premiumLooks.mjs
//
// The visual overhaul added hull letters T-Y (T plus the U-Y homage
// line) and a sixth Mega Destroyer look (F, the Planet Killer). All of
// them are Commander's Commission designs. The pickers show them locked,
// but the lock is decoration: these validators are what refuse a save,
// so they are what this checks — against a stand-in entitlement table.
// ============================================================

import { validateIconVariant, validateStructureVariant } from '../worker/store.js';

let failed = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  (${detail})`}`);
  if (!ok) failed++;
}

// A D1 stand-in that answers the two questions store.js asks: does this
// player hold the Commission, and do they keep this look from before
// (user_look_grants, 0166)?
const entitled = new Set(['paid']);
const grants = new Set(['kept:corvette:G']);
const env = {
  DB: {
    prepare: (sql) => ({
      bind: (...a) => ({
        first: async () => (sql.includes('user_look_grants')
          ? (grants.has(a.join(':')) ? { x: 1 } : null)
          : (entitled.has(a[0]) ? { x: 1 } : null)),
      }),
    }),
  },
};

// Since 2026-10-15 only A and B are free (they hold every class default);
// C-I joined the Commission then. Z = the Medieval Series.
const FREE = 'AB'.split('');
const PREMIUM = 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('');

for (const v of FREE) {
  check(`hull ${v} is free`, (await validateIconVariant(env, 'free', v)) === null);
}
for (const v of PREMIUM) {
  const r = await validateIconVariant(env, 'free', v);
  check(`hull ${v} is refused without the Commission`, r?.code === 'premium_required', JSON.stringify(r));
  check(`hull ${v} is allowed with it`, (await validateIconVariant(env, 'paid', v)) === null);
}
// Grandfathered: a look built with before it was paid stays, for that class only.
check('a kept look saves on its own hull class', (await validateIconVariant(env, 'kept', 'G', 'corvette')) === null);
check('...but not on another class', (await validateIconVariant(env, 'kept', 'G', 'frigate'))?.code === 'premium_required');
check('...and not some other paid look', (await validateIconVariant(env, 'kept', 'D', 'corvette'))?.code === 'premium_required');
check('...and not without a class to check it against', (await validateIconVariant(env, 'kept', 'G'))?.code === 'premium_required');
check('a free look needs no grant on any class', (await validateIconVariant(env, 'kept', 'B', 'frigate')) === null);
for (const bad of ['a', 'z', 'AA', '[']) {
  check(`${bad} is not a hull letter`, (await validateIconVariant(env, 'paid', bad))?.code === 'bad_request');
}

// One look per megastructure is free (the default, A); every other look
// on every kind needs the Commission (2026-10-05).
const KINDS = ['warp_gate', 'weapons_station', 'gravity_sink', 'deep_array', 'null_field', 'mega_destroyer', 'mobile_foundry'];
for (const kind of KINDS) {
  check(`${kind}: the default look stays free`, (await validateStructureVariant(env, 'free', kind, 'A')) === null);
  const looks = kind === 'mega_destroyer' ? 'BCDEF' : 'BC';
  for (const v of looks) {
    const r = await validateStructureVariant(env, 'free', kind, v);
    check(`${kind} ${v} is refused without the Commission`, r?.code === 'premium_required', JSON.stringify(r));
    check(`${kind} ${v} is allowed with it`, (await validateStructureVariant(env, 'paid', kind, v)) === null);
  }
}
check('no look chosen (the default) is never refused', (await validateStructureVariant(env, 'free', 'warp_gate', null)) === null);

console.log(failed ? `\n${failed} FAILED` : '\nALL PREMIUM LOOK CHECKS PASS');
process.exit(failed ? 1 : 0);
