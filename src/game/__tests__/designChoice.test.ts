// ============================================================
// Picking a saved design at the hull and at the yard.
//
// Noah, 2026-09-30: retrofitting one freighter into a miner meant making
// the miner the ACTIVE template in the fleet designer first; Lorne asked
// for the same picker at the yard. The server already took any design of
// the right class for a refit order and for a build.
// ============================================================

import fs from 'fs';
import path from 'path';
import { retrofitChoices, retrofitOptions, defaultRetrofitPick, buildChoices, sameFit } from '../designChoice';
import type { Ship, ShipDesign } from '../../types';

const d = (id: string, name: string, parts: string[], isActive = false, shipClass = 'freighter'): ShipDesign =>
  ({ id, name, parts, isActive, shipClass, createdAtMs: 0 } as unknown as ShipDesign);
const CARGO = d('cargo', 'Hauler', ['armor'], true);
const MINER = d('miner', 'Miner', ['mining']);
const BARE = d('bare', 'Stripped', []);
const FRIGATE = d('frig', 'Picket', ['kinetic'], true, 'frigate');
const ALL = [CARGO, MINER, BARE, FRIGATE];

const freighter = (parts: string[], pending?: string): Ship =>
  ({ id: 's1', class: 'freighter', parts, refitPendingDesignId: pending } as unknown as Ship);

describe('retrofit choices', () => {
  it('every design of the class except the fit it already has, active first', () => {
    expect(retrofitChoices(freighter(['armor']), ALL).map(x => x.id)).toEqual(['miner', 'bare']);
    expect(retrofitChoices(freighter([]), ALL).map(x => x.id)).toEqual(['cargo', 'miner']);
  });

  it('a freighter matching the ACTIVE template can still go to the miner (the reported case)', () => {
    const choices = retrofitChoices(freighter(['armor']), ALL);
    expect(choices.some(x => x.id === 'miner')).toBe(true);
  });

  it('never offers another class', () => {
    expect(retrofitChoices(freighter(['armor']), ALL).some(x => x.shipClass !== 'freighter')).toBe(false);
  });

  it('opens on the standing order, else the active design, else the first', () => {
    const s = freighter(['armor']);
    expect(defaultRetrofitPick(freighter([], 'miner'), retrofitChoices(freighter([], 'miner'), ALL))?.id).toBe('miner');
    expect(defaultRetrofitPick(freighter([]), retrofitChoices(freighter([]), ALL))?.id).toBe('cargo');
    // The active design is the ship's own fit here, so the first by name.
    expect(defaultRetrofitPick(s, retrofitChoices(s, ALL))?.id).toBe('miner');
  });

  it('nothing to offer with no other fit saved', () => {
    expect(retrofitChoices(freighter(['armor']), [CARGO])).toEqual([]);
    expect(retrofitChoices(freighter(['armor']), undefined)).toEqual([]);
  });

  it('a fit is the same whatever order its parts are listed in', () => {
    expect(sameFit(['a', 'b'], ['b', 'a'])).toBe(true);
    expect(sameFit(['a', 'a'], ['a'])).toBe(false);
  });
});

describe('the retrofit dropdown lists the whole class', () => {
  // Noah's board: a freighter carrying its Default fit, and one other
  // template. With the fitted one left out, the picker had a single
  // entry and collapsed to text -- "my suggestion was for pre-existing
  // ships", with a mockup of the list he expected to see.
  const noahs = [d('def', 'Default', ['engine'], true), d('mine', 'Mine Time', ['mining'])];
  it('shows the fitted design, flagged, beside the one to refit to', () => {
    const opts = retrofitOptions(freighter(['engine']), noahs);
    expect(opts.map(o => [o.name, o.fitted])).toEqual([['Default', true], ['Mine Time', false]]);
  });
  it('never another class', () => {
    expect(retrofitOptions(freighter(['armor']), ALL).every(o => o.shipClass === 'freighter')).toBe(true);
  });
});

describe('yard template choices', () => {
  it('the class designs, active first', () => {
    expect(buildChoices('freighter', ALL).map(x => x.id)).toEqual(['cargo', 'miner', 'bare']);
    expect(buildChoices('frigate', ALL).map(x => x.id)).toEqual(['frig']);
    expect(buildChoices('destroyer', ALL)).toEqual([]);
  });
});

describe('both screens use them', () => {
  const read = (p: string) => fs.readFileSync(path.resolve(__dirname, p), 'utf8').replace(/\r\n/g, '\n');

  it('the ship panel retrofit lists every saved fit, not only the active one', () => {
    const src = read('../../components/ShipPanel.tsx');
    const i = src.indexOf('RETROFIT</div>');
    const section = src.slice(src.lastIndexOf('{isOwn && mpActions && (() => {', i), i + 3000);
    expect(section).toMatch(/retrofitChoices\(ship, gameState\.shipDesigns\)/);
    expect(section).toMatch(/data-testid="refit-pick"/);
    // Always a dropdown, never collapsed to text for a single alternative.
    expect(section).not.toMatch(/choices\.length > 1 && \(/);
    expect(section).toMatch(/retrofitOptions\(ship, gameState\.shipDesigns\)/);
    expect(section).not.toMatch(/d\.shipClass === ship\.class && d\.isActive\)/);
  });

  it('the yard builds the design its cell shows', () => {
    const src = read('../../multiplayer/WorldMenuOverlay.tsx');
    expect(src).toMatch(/buildChoices\(cls, gameState\.shipDesigns\)/);
    expect(src).toMatch(/data-testid=\{`wm-template-\$\{cls\}`\}/);
    const b = src.indexOf('const buildShip = async');
    expect(src.slice(b, b + 6000)).toMatch(/designId: chosen\.id/);
  });
});
