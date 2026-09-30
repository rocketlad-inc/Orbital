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

const pk = await validateStructureVariant(env, 'free', 'mega_destroyer', 'F');
check('the Planet Killer is refused without the Commission', pk?.code === 'premium_required', JSON.stringify(pk));
check('...and allowed with it', (await validateStructureVariant(env, 'paid', 'mega_destroyer', 'F')) === null);
for (const v of 'ABCDE'.split('')) {
  check(`Mega Destroyer ${v} stays free`, (await validateStructureVariant(env, 'free', 'mega_destroyer', v)) === null);
}
check('other kinds have no premium looks', (await validateStructureVariant(env, 'free', 'warp_gate', 'C')) === null);

console.log(failed ? `\n${failed} FAILED` : '\nALL PREMIUM LOOK CHECKS PASS');
process.exit(failed ? 1 : 0);
