import fs from 'fs';
import path from 'path';

// TRADE IS ITS OWN RAIL PANEL.
//
// Offers used to live under Multiplayer › Trades and freight routes
// under Empire › trade; a player chasing an idle freighter had to know
// which of the two to open. Both now sit behind one rail icon
// (TradeDock: PRIVATE + ROUTES). These guards keep the move from
// quietly regressing — a Trades tab creeping back into the shell, or
// the Empire panel growing a second home for routes.

const read = (rel: string) =>
  fs.readFileSync(path.join(__dirname, '..', '..', rel), 'utf8');

describe('trade rail panel — the move', () => {
  const rail = read('components/DockRail.tsx');
  const shell = read('multiplayer/MultiplayerShell.tsx');
  const empire = read('components/SettlementsPanel.tsx');
  const app = read('App.tsx');
  const dock = read('multiplayer/TradeDock.tsx');

  it('the rail has a trade key with its own MP-only button', () => {
    expect(rail).toMatch(/DockRailKey = [^;]*'trade'/);
    expect(rail).toMatch(/ICON_KEYS[^\n]*'trade'/);
    expect(rail).toMatch(/which="trade"/);
    // Gated on isMultiplayer like the Multiplayer button: in SP nothing
    // listens for active === 'trade', so the control would be dead.
    expect(rail).toMatch(/\{isMultiplayer && !lobbyOnly && \(\s*<DockButton\s*which="trade"/);
  });

  it('App mounts TradeDock in MP only', () => {
    expect(app).toMatch(/import \{ TradeDock \} from '\.\/multiplayer\/TradeDock'/);
    expect(app).toMatch(/\{isMultiplayer && <TradeDock \/>\}/);
  });

  it('TradeDock hosts both tenants and answers the rail + deep links', () => {
    expect(dock).toMatch(/<TradesPanel gameId=\{gameId\} \/>/);
    expect(dock).toMatch(/<SettlementTradeTab/);
    expect(dock).toMatch(/<RouteComposer/);
    expect(dock).toMatch(/detail\?\.active === 'trade'/);
    // Both offer and route deep links land here.
    expect(dock).toMatch(/panel !== 'trades' && panel !== 'routes'/);
    expect(dock).toMatch(/detail: \{ active: 'trade' \}/);
  });

  it('the multiplayer shell no longer owns a Trades tab', () => {
    expect(shell).not.toMatch(/from '\.\/TradesPanel'/);
    expect(shell).not.toMatch(/tab === 'trades'/);
    expect(shell).not.toMatch(/setTab\('trades'\)/);
    expect(shell).toMatch(/type Tab = 'lobby' \| 'faction' \| 'comms' \| 'senate';/);
    // The offer modal's "Take Me There" goes through the shared deep link.
    expect(shell).toMatch(/orbital:open-panel', \{ detail: \{ panel: 'trades' \} \}/);
  });

  it('trade attention badges the trade icon, not the multiplayer one', () => {
    expect(shell).toMatch(/which: 'trade', count: incomingTradeCount \| 0/);
    // The multiplayer aggregate no longer sums trades.
    expect(shell).toMatch(/const count = \(unreadMessages \| 0\) \+ \(incomingProposalCount \| 0\);/);
    expect(dock).toMatch(/detail\?\.which !== 'trade'/);
  });

  it('the Empire panel lost its trade filter', () => {
    expect(empire).not.toMatch(/'trade'/);
    expect(empire).not.toMatch(/SettlementTradeTab|RouteComposer/);
    expect(empire).toMatch(/\['economy'\] as Filter\[\]/);
  });
});
