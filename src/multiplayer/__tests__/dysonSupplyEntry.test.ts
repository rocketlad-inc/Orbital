/**
 * The Sun is a supply-route target from its OWN card, and a supply run
 * never offers the second freighter it cannot fly.
 *
 * Crimson_Song, 2026-10-04: "sol is not a valid target for any of the
 * things" -- only a freighter's cargo tab could lay a route to the
 * Dyson Sphere; the sphere's card said "give a freighter a route" with
 * no way to do it. And "+ Freighter" on a supply run (one pinned hull
 * by design) only ever earned a single_carrier refusal.
 */
import fs from 'fs';
import path from 'path';

const read = (f: string) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

test("the Dyson card opens a supply route to the Sun itself", () => {
  const src = read('WorldMenuOverlay.tsx');
  const card = src.slice(src.indexOf('const WmDysonCard'));
  expect(card).toMatch(/<WmSupplyAssign[\s\S]{0,80}destId="sol"/);
});

test('the terraform card and the Dyson card share one route picker', () => {
  const src = read('WorldMenuOverlay.tsx');
  const terraform = src.slice(src.indexOf('const WmTerraformCard'), src.indexOf('const WmSupplyAssign'));
  expect(terraform).toMatch(/<WmSupplyAssign/);
});

test('a supply run with its freighter aboard offers no second one, and no remove on it', () => {
  const src = read('SettlementTradeTab.tsx');
  expect(src).toMatch(/const pinnedRun = !isWalker && carriers\.length >= 1;/);
  expect(src).toMatch(/disabled=\{[^}]*\|\| pinnedRun\}/);
  expect(src).toMatch(/\(isWalker \|\| s\.role === 'guard'\) && <button/);
});
