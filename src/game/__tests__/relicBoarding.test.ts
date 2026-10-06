/**
 * An ancient relic can be boarded, and its card says how.
 *
 * fartmaster, 2026-10-06: "so how exactly do i board this thing?" -- a
 * breached Eris Ancient Relay (0/3000 hull) whose card said "Breached --
 * boardable by anyone holding the orbit" and showed no way to do it. The
 * card hid its whole boarding section for anything with no founder, which
 * was meant for the ancient warp gates and caught the relics too, while
 * the server (handleSeizeSite) would have taken the boarding.
 */
import fs from 'fs';
import path from 'path';
import { isSeizable } from '../megastructures';

const read = (rel: string) => fs.readFileSync(path.join(__dirname, '..', '..', '..', rel), 'utf8');

test('a relic is seizable; a built site is; an ancient gate is not', () => {
  expect(isSeizable({ foundedByFactionId: null, ancient: true })).toBe(true);
  expect(isSeizable({ foundedByFactionId: 'f2' })).toBe(true);
  expect(isSeizable({ foundedByFactionId: null, ancient: false })).toBe(false);
  expect(isSeizable({ foundedByFactionId: null })).toBe(false);
});

test('the card gates its boarding section on that rule', () => {
  const card = read('src/multiplayer/MegastructureCard.tsx');
  expect(card).toMatch(/!mine && !derelict && isSeizable\(site\) && mpActions/);
  expect(card).not.toMatch(/site\.foundedByFactionId !== null && mpActions/);
});

test('the client learns which structures are relics', () => {
  expect(read('worker/state.js')).toMatch(/completed_at_tick, ancient\s+FROM game_megastructures/);
  expect(read('src/multiplayer/MultiplayerGameProvider.tsx')).toMatch(/ancient: Number\(m\.ancient\) === 1/);
});

test('the server agrees: relics are taken, gates are not', () => {
  const actions = read('worker/actions.js');
  expect(actions).toMatch(/if \(!site\.owner_faction_id && Number\(site\.ancient\) !== 1\)/);
});

test('a breached finished structure does not claim to be operational', () => {
  expect(read('src/multiplayer/MegastructureCard.tsx'))
    .toMatch(/complete \? \(isBreached\(site\) \? 'Breached · offline' : 'Operational'\)/);
});
