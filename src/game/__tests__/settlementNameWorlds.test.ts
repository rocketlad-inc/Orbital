// R2-C9: a station on Earth was named "Ganymede Relay".
import { randomSettlementName, worldNamedIn, SETTLEMENT_NAME_POOLS } from '../settlementNames';

test('a name naming another real world is never drawn elsewhere', () => {
  for (let i = 0; i < 400; i++) {
    const n = randomSettlementName('station', [], 'Earth')!;
    const w = worldNamedIn(n);
    expect(w === null || w === 'Earth').toBe(true);
  }
});
test('on that world the name is fair game', () => {
  const others = SETTLEMENT_NAME_POOLS.station.filter(n => n !== 'Ganymede Relay' && worldNamedIn(n) !== 'Ganymede');
  // Every other name taken: only Ganymede's own remain.
  const n = randomSettlementName('station', others, 'Ganymede');
  expect(worldNamedIn(n!)).toBe('Ganymede');
});
test('the matcher reads whole words', () => {
  expect(worldNamedIn('Ganymede Relay')).toBe('Ganymede');
  expect(worldNamedIn('Io Refinery')).toBe('Io');
  expect(worldNamedIn('Ionic Hold')).toBeNull();
  expect(worldNamedIn('Tycho Station')).toBeNull();
});
