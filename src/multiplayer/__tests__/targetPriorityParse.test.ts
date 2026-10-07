/**
 * "Changing target priority for a fleet ends with it resetting to default
 * regardless of your order" (player report). The server stores the full
 * six-key order; the client parser only knew five keys and dropped every
 * order containing capital, so the UI showed AUTO.
 */
import { parseTargetPriority } from '../targetPriority';
import { TARGET_PRIORITY_DEFAULT } from '../../types';

test('an order with capital ships in it is read, not dropped to AUTO', () => {
  const stored = JSON.stringify(['capital', 'destroyer', 'frigate', 'corvette', 'civilian', 'settlement']);
  expect(parseTargetPriority(stored)).toEqual(['capital', 'destroyer', 'frigate', 'corvette', 'civilian', 'settlement']);
});

test('every key the cards offer is accepted', () => {
  expect(parseTargetPriority(JSON.stringify(TARGET_PRIORITY_DEFAULT))).toEqual(TARGET_PRIORITY_DEFAULT);
});

test('no order, junk, or an unknown key still reads as AUTO', () => {
  expect(parseTargetPriority(null)).toBeNull();
  expect(parseTargetPriority('')).toBeNull();
  expect(parseTargetPriority('not json')).toBeNull();
  expect(parseTargetPriority('[]')).toBeNull();
  expect(parseTargetPriority(JSON.stringify(['corvette', 'battleship']))).toBeNull();
});

test('the provider reads target priority through this parser', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const src: string = require('fs').readFileSync(
    require('path').join(__dirname, '../MultiplayerGameProvider.tsx'), 'utf8');
  expect(src).toMatch(/parseTargetPriority\(s\.target_priority\)/);
  expect(src).not.toMatch(/k === 'civilian' \|\| k === 'settlement'/);
});
