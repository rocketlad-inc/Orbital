// ============================================================
// THE SQUID CANNOT BE TARGETED IN FLIGHT (Lorne, 2026-10-07: "Refuse the
// click. Cant target the Squid in transit").
//
// The map used to read a click on a gate still flying out of the Sun as
// "go where it is going" and swap in its landing site, out in the Far
// Reach. A player who clicked the squid passing Venus, to board it, sent
// five hulls on a 40-tick burn to the edge of the system (The NEXT Zone,
// T291). The click is refused now, out loud, and the pick stays open.
// ============================================================

import fs from 'fs';
import path from 'path';
import { en } from '../../i18n/en';
import { ptBR } from '../../i18n/pt-BR';

const src = (rel: string) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

describe('clicking the squid in flight', () => {
  const map = src('MapCanvas.tsx');
  const branch = map.slice(map.indexOf('isGateInFlight(picked'), map.indexOf('isGateInFlight(picked') + 400);

  it('never swaps in the landing site', () => {
    expect(map).not.toMatch(/landingSiteIdOf/);
  });

  it('is refused out loud, and the pick stays open (no transfer is confirmed)', () => {
    expect(branch).toMatch(/orbital-transfer-refused/);
    expect(branch).toMatch(/gate_in_flight/);
    expect(branch).toMatch(/return;/);
    expect(branch.indexOf('return;')).toBeLessThan(
      branch.indexOf('orbital-transfer-confirm') === -1 ? Infinity : branch.indexOf('orbital-transfer-confirm'));
  });

  it('the ship panel says why', () => {
    const panel = src('ShipPanel.tsx');
    expect(panel).toMatch(/addEventListener\('orbital-transfer-refused'/);
    expect(panel).toMatch(/mp\.err\.gateInFlightClick/);
  });

  it('the gate card in flight says it cannot be boarded, not "park a ship on it"', () => {
    const card = fs.readFileSync(path.join(__dirname, '..', '..', 'multiplayer', 'MegastructureCard.tsx'), 'utf8');
    expect(card).toMatch(/flying\s*\?\s*t\('megastructure\.sun\.blurbFlying'/);
    for (const cat of [en, ptBR] as Array<Record<string, string>>) {
      const s = cat['megastructure.sun.blurbFlying'];
      expect(s).toMatch(/\{n\}/);
      expect(s).not.toMatch(/Park a ship on it|Estacione uma nave nele/);
    }
  });

  it('in both languages, with the landing tick', () => {
    const e = (en as Record<string, string>)['mp.err.gateInFlightClick'];
    const p = (ptBR as Record<string, string>)['mp.err.gateInFlightClick'];
    expect(e).toMatch(/\{tick\}/);
    expect(p).toMatch(/\{tick\}/);
  });
});
