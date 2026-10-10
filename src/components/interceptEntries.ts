// What the intercept picker shows for each group in flight: names in the
// player's words, the game's own ship icons in the owner's colours, and
// the bearing of the meeting from the hull that would fly it (the radar).
// Shared by the ship panel and the group bar.

import type { GameState } from '../types';
import { t, tk } from '../i18n/core';
import { meetBearing, type InterceptOption, type Vec } from '../game/interceptOptions';
import { makeupOf } from '../game/interceptPicker';
import { iconClassFor } from './ShipIcons';
import { STANDING_RING, type PickerEntry } from './InterceptPicker';

export function interceptPickerEntries(
  options: readonly InterceptOption[],
  gs: Pick<GameState, 'factions' | 'currentTick'>,
  myPos: Vec,
): PickerEntry[] {
  const now = gs.currentTick;
  return options.map(o => {
    const owner = gs.factions.find(f => f.id === o.lead.ownedBy);
    const mine = o.lead.ownedBy === 'player';
    const name = o.fleet
      ? o.fleet.name
      : o.members.length > 1
        ? t('ship.rv.andMore', { name: o.lead.name, n: o.members.length - 1 })
        : o.lead.name;
    const ownerName = mine ? t('ship.panel.yours') : (owner?.name ?? t('ship.panel.rival'));
    return {
      key: o.key,
      name,
      ownerName,
      ownerColor: mine ? STANDING_RING.yours : (owner?.color ?? '#8a9fb3'),
      standing: o.standing,
      ok: o.ok,
      ships: o.members.length,
      makeup: makeupOf(o.members).map(m => `${m.n}× ${tk(`data.ship.${m.cls}.name`, m.cls)}`).join(' · '),
      captain: o.fleet?.flagCaptainName ?? o.lead.captainName ?? null,
      dest: o.dest.name,
      meetIn: Math.round(o.meetIn),
      myEta: Math.round(o.myEta),
      theirEta: Math.round(o.theirEta - now),
      match: !!o.rv,
      angle: meetBearing(o, myPos),
      icon: {
        cls: iconClassFor(o.lead.class),
        variant: o.lead.iconVariant,
        parts: o.lead.parts,
        color: owner?.color,
        color2: owner?.color2,
      },
      // ownerName too, so "yours" finds your own (as the old search did).
      search: [name, ownerName, owner?.name ?? '', o.dest.name, ...o.members.map(m => m.name)].join(' | ').toLowerCase(),
    };
  });
}
