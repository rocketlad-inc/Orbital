// A FINISHED STRUCTURE IS NOT A SITE (Studio clip a-megastructure-completes:
// the map and outliner still said "WEAPONS STATION SITE" after it was
// built). The end-to-end check is sim/megaComplete.mjs; this pins the
// naming rule both the completion rename and the /state read use.

import { megaBodyName, siteNameFor } from '../../../worker/megastructures.js';

describe('megaBodyName', () => {
  it('founding names a site "<Label> Site"', () => {
    expect(siteNameFor('weapons_station')).toBe('Weapons Station Site');
    expect(siteNameFor('not_a_kind')).toBeNull();
  });
  it('a complete structure drops "Site"', () => {
    expect(megaBodyName('Weapons Station Site', 'weapons_station', 'complete')).toBe('Weapons Station');
  });
  it('a site still building keeps it', () => {
    expect(megaBodyName('Weapons Station Site', 'weapons_station', 'building')).toBe('Weapons Station Site');
  });
  it('a name of its own is never touched', () => {
    expect(megaBodyName('Eye of Ceres', 'deep_array', 'complete')).toBe('Eye of Ceres');
    expect(megaBodyName('Null Field Site', 'weapons_station', 'complete')).toBe('Null Field Site');
  });
});
