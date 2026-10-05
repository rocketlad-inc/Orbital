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

// A D1 stand-in that answers the one entitlement query store.js asks.
const entitled = new Set(['paid']);
const env = {
  DB: {
    prepare: () => ({
      bind: (userId) => ({ first: async () => (entitled.has(userId) ? { x: 1 } : null) }),
    }),
  },
};

const FREE = 'ABCDEFGHI'.split('');
const PREMIUM = 'JKLMNOPQRSTUVWXY'.split('');

for (const v of FREE) {
  check(`hull ${v} is free`, (await validateIconVariant(env, 'free', v)) === null);
}
for (const v of PREMIUM) {
  const r = await validateIconVariant(env, 'free', v);
  check(`hull ${v} is refused without the Commission`, r?.code === 'premium_required', JSON.stringify(r));
  check(`hull ${v} is allowed with it`, (await validateIconVariant(env, 'paid', v)) === null);
}
check('a letter past Y is still invalid', (await validateIconVariant(env, 'paid', 'Z'))?.code === 'bad_request');

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
