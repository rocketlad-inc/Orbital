// Sam, 2026-10-22, over the New Trade Route form: "Make this list
// alphabetical, alongside always having the current location at the top.
// Same goes for the destination field being alphabetical." Both lists
// came out in catalogue order (Earth, Luna, Juno, Midas, Iron Anna...).
import { sortWorldsAZ } from '../ShipPanel';

const w = (id: string, name: string) => ({ id, name });
const worlds = [
  w('earth', 'Earth'), w('luna', 'Luna'), w('juno', 'Juno'), w('midas', 'Midas'),
  w('iron', 'Iron Anna'), w('sky', 'Black Sky'), w('aug', 'Augustín'), w('europa', 'Europa'),
];

test('A-Z by name, ignoring case and accents', () => {
  expect(sortWorldsAZ(worlds).map(x => x.name)).toEqual([
    'Augustín', 'Black Sky', 'Earth', 'Europa', 'Iron Anna', 'Juno', 'Luna', 'Midas',
  ]);
});

test('the world the freighter is at goes first, the rest stay A-Z', () => {
  expect(sortWorldsAZ(worlds, 'midas').map(x => x.name)).toEqual([
    'Midas', 'Augustín', 'Black Sky', 'Earth', 'Europa', 'Iron Anna', 'Juno', 'Luna',
  ]);
});

test('a current world that is not in the list changes nothing', () => {
  expect(sortWorldsAZ(worlds, 'saturn')).toEqual(sortWorldsAZ(worlds));
});

test('never reorders the list it was given', () => {
  const copy = [...worlds];
  sortWorldsAZ(worlds, 'midas');
  expect(worlds).toEqual(copy);
});
