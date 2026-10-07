// The English catalog is assembled from one file per area so that several
// people (or agents) can translate different screens at the same time
// without touching the same file. Each area owns key prefixes; the test in
// __tests__/catalogs.test.ts enforces that, so two areas can never define
// the same key.
export { ship } from './ship';
export { map } from './map';
export { econ } from './econ';
export { social } from './social';
export { review } from './review';
export { guide } from './guide';
export { data } from './data';
export { helpers } from './helpers';

/** Which key prefixes each area may use. */
export const PART_PREFIXES: Record<string, string[]> = {
  ship: ['ship.', 'fleet.', 'grp.'],
  map: ['map.', 'body.', 'outliner.', 'topbar.', 'dock.', 'threats.', 'settle.', 'megastructure.', 'meteoroid.', 'worldmenu.'],
  econ: ['build.', 'tech.', 'econ.', 'trade.', 'market.', 'route.'],
  social: ['senate.', 'comms.', 'faction.', 'standing.', 'captains.', 'notify.', 'profile.', 'hangar.', 'roomlobby.', 'shell.', 'bot.', 'feed.'],
  review: ['review.', 'theatre.', 'replay.', 'story.', 'recap.', 'eventlog.', 'situation.', 'combat.', 'discovery.'],
  guide: ['tutorial.', 'howto.', 'site.', 'banner.', 'errorboundary.', 'saveload.', 'mp.', 'landing.'],
  data: ['data.'],
  helpers: ['helper.'],
};
