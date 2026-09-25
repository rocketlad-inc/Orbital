// A shared world: the rival owns it, the station is yours.
//
// Noah seized Wu Tang's wrecked station on Io while their city still
// stood (2026-09-24). One city to one station is a tie, so Io stayed
// theirs -- and the World Menu, gating on the WORLD, greyed out his own
// station's upgrades and shipyard and drew it in their colours.

import fs from 'fs';
import path from 'path';
import { worldControl, settlementLivery } from '../worldMenu/settlementControl';
import type { Settlement, Faction } from '../../types';

const st = (id: string, type: 'city' | 'station', ownedBy: string) =>
  ({ id, type, ownedBy, name: id, bodyId: 'io' }) as unknown as Settlement;
const factions = [
  { id: 'player', name: 'Stonekin', color: '#c0392b', color2: '#f1c40f' },
  { id: 'f4', name: 'The Wu Tang Clan', color: '#ff4fa3' },
] as unknown as Faction[];

// Io as it stands on prod: Wu Tang's city, Noah's seized station.
const io = [st('calodan', 'city', 'f4'), st('dst', 'station', 'player')];

describe('worldControl (Io, the reported case)', () => {
  const c = worldControl(io);
  it('finds YOUR station on a world a rival owns', () => {
    expect(c.myStation?.id).toBe('dst');
  });
  it('does not hand you their city', () => {
    expect(c.myCity).toBeNull();
  });
  it('lets you command the yard: you hold a settlement here', () => {
    expect(c.canCommand).toBe(true);
  });
  it('a world with only their settlements gives you nothing', () => {
    expect(worldControl([st('calodan', 'city', 'f4')]).canCommand).toBe(false);
  });
});

describe('settlementLivery', () => {
  it('your station flies your colours, not the world owner\'s', () => {
    expect(settlementLivery(io[1], factions)).toEqual({ color: '#c0392b', color2: '#f1c40f' });
  });
  it('their city keeps theirs', () => {
    expect(settlementLivery(io[0], factions)?.color).toBe('#ff4fa3');
  });
});

describe('the World Menu uses it', () => {
  const menu = fs.readFileSync(
    path.resolve(__dirname, '../../multiplayer/WorldMenuOverlay.tsx'), 'utf8');
  it('building buttons are gated on the settlement, not the world', () => {
    const i = menu.indexOf('const buildBtn = ');
    const fn = menu.slice(i, menu.indexOf('return (', i));
    expect(fn).not.toMatch(/!isMine/);
    expect(fn).toMatch(/const disabled = !host/);
  });
  it('the fleet box is told whether you hold a settlement here', () => {
    expect(menu).toMatch(/isMine=\{canCommand\}/);
  });
  it('the station rig paints in the station owner\'s livery', () => {
    const a = menu.indexOf('data-testid="wm-station"');
    const rig = menu.slice(a, menu.indexOf('{/* Name + HP header', a));
    expect(rig).toMatch(/\{sp1\}/);
    expect(rig).not.toMatch(/\{p1\}|\{p2\}/);
  });
});
