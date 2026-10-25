// R2-C5: a trial starts with a freighter and no Propulsion; the Market
// said "you cannot build one yet" beside the freighter it owned.
import { freighterTradeLock } from '../tradeLock';

test('owning a freighter lifts the lock without the research', () => {
  expect(freighterTradeLock({ gating_enabled: 1, tech_levels: {}, freighters: 1 })).toBeNull();
});
test('no freighter and no research: locked, naming where it unlocks', () => {
  expect(freighterTradeLock({ gating_enabled: 1, tech_levels: {}, freighters: 0 })?.where).toMatch(/1$/);
});
test('the research alone still unlocks it', () => {
  expect(freighterTradeLock({ gating_enabled: 1, tech_levels: { propulsion: 1 }, freighters: 0 })).toBeNull();
});
test('still loading: no lock flashes up', () => {
  expect(freighterTradeLock(null)).toBeNull();
});
