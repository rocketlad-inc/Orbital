/**
 * A trade offer is refused only for an amount actually offered that the
 * stockpile cannot cover. Lorne, 2026-10-08: "Why cant I send this
 * deal?" -- 1000 credits for 1000 metal, Send dead, the Science box red
 * at 0. His science was stored as -5.7e-14 (float residue), and 0 >
 * -5.7e-14, so the composer (and the server) said he could not afford
 * the 0 science he was not offering.
 */
import fs from 'fs';
import path from 'path';
import { cannotAfford } from '../tradeAfford';
import { cannotAfford as serverCannotAfford } from '../../../worker/tradeAfford.js';

const RESIDUE = -5.684341886080802e-14; // his real stored value

test.each([
  ['nothing offered, residue held', RESIDUE, 0, false],
  ['nothing offered, nothing held', 0, 0, false],
  ['the whole pool, a hair short from residue', 999.9999999999, 1000, false],
  ['exactly what is held', 4722, 4722, false],
  ['more than held', 117, 1000, true],
  ['one over', 4722, 4723, true],
  ['something offered from an empty pool', RESIDUE, 1, true],
])('%s', (_label, held, offered, short) => {
  expect(cannotAfford(held, offered)).toBe(short);
  // The server copy rules the same way, so the button and the endpoint agree.
  expect(serverCannotAfford(held, offered)).toBe(short);
});

test('the composer and both server checks use it, not a bare comparison', () => {
  const root = path.resolve(__dirname, '../../..');
  const trades = fs.readFileSync(path.join(root, 'worker/trades.js'), 'utf8');
  expect(trades).not.toMatch(/roposer\[k\] < res\.offer\[k\]/);
  expect((trades.match(/cannotAfford\(\w*[pP]roposer\[k\], res\.offer\[k\]\)/g) ?? []).length).toBe(2);
  const composer = fs.readFileSync(path.join(root, 'src/multiplayer/TradeComposer.tsx'), 'utf8');
  expect(composer).not.toMatch(/offer\[k\] > me\[k\]/);
  expect(composer).toMatch(/cannotAfford\(me\[k\], offer\[k\]\)/);
});
