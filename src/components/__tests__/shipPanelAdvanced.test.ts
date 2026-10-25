/**
 * ADVANCED ORDERS SIT BEHIND ONE DISCLOSURE (playtest C25, Dale,
 * 2026-10-24). A new player sees the move buttons, the trip in plain
 * words with its cancel, COMMIT and stance; retreat, target priority,
 * auto-detonate, the delta-v node list and the chain-orders tape are one
 * tap away under ADVANCED, which remembers being open.
 *
 * Read from the source: the panel needs the whole game context to mount.
 */
import fs from 'fs';
import path from 'path';

const src = fs.readFileSync(path.join(__dirname, '..', 'ShipPanel.tsx'), 'utf8').replace(/\r\n/g, '\n');

/** The JSX between `{advancedOpen && (<>` and its closing `</>)}`. */
function advancedBlock(): string {
  const open = src.indexOf('{advancedOpen && (<>');
  expect(open).toBeGreaterThan(0);
  const close = src.indexOf('</>)}', open);
  expect(close).toBeGreaterThan(open);
  return src.slice(open, close);
}

describe('ship panel: advanced orders', () => {
  it('holds retreat, target priority, auto-detonate, the node list and the chain tape', () => {
    const adv = advancedBlock();
    for (const piece of [
      "t('ship.panel.retreatAt')", "t('ship.panel.retreatTo')", '<TargetPriorityCards',
      "t('ship.panel.autoDetonate')", '{maneuverNodesJsx}', "t('grp.chain')",
    ]) expect(adv).toContain(piece);
  });

  it('leaves stance, the repair run and COMMIT outside it', () => {
    const adv = advancedBlock();
    expect(adv).not.toContain('applyOrders({ stance: st })');
    expect(adv).not.toContain("t('ship.panel.sendYard')");
    expect(adv).not.toContain('data-tutorial-id="ship-commit-button"');
    expect(src).toContain('data-tutorial-id="ship-commit-button"');
  });

  it('multiplayer shows the trip in plain words where the node list was', () => {
    expect(src).toContain('{mpActions ? tripSummaryJsx : maneuverNodesJsx}');
  });

  it('remembers whether it is open', () => {
    expect(src).toMatch(/localStorage\.getItem\(ADVANCED_KEY\)/);
    expect(src).toMatch(/localStorage\.setItem\(ADVANCED_KEY/);
  });
});
