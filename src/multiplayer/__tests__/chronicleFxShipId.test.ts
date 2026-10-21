import fs from 'fs';
import path from 'path';

// A replayed kill names its hull by the id the MAP uses. /state ships keep
// the game prefix ("dTPYzJOcxxUn:st_t_0"); the chronicle queue used to
// strip it, so a replayed kill never found the hull it named: it boomed a
// second time on a hashed spot of the parking ring, nearer the planet than
// the fight, and left a second wreck there (Lorne, 2026-10-21, measured in
// a Studio take on prod).

const read = (rel: string) => fs.readFileSync(path.join(__dirname, '..', '..', rel), 'utf8');

describe('chronicle FX name hulls the way the map does', () => {
  it('the queue gets the full ship id, not a stripped one', () => {
    const src = read('multiplayer/MultiplayerGameProvider.tsx');
    expect(src).toMatch(/shipId: ev\.ship_id \?\? undefined,/);
    expect(src).not.toMatch(/shipId: stripGameId\(ev\.ship_id\)/);
  });

  it('"take me there" on a ship row finds the ship', () => {
    const src = read('multiplayer/MultiplayerGameProvider.tsx');
    expect(src).toMatch(/return \{ kind: 'ship', shipId: ev\.ship_id, bodyId \};/);
  });

  it('the death registry and the queue use the same key', () => {
    const src = read('multiplayer/MultiplayerGameProvider.tsx');
    expect(src).toMatch(/markChronicleDeath\(ev\.ship_id\)/);
  });

  it('the map looks the hull up by that id, and dedupes on it', () => {
    const map = read('components/MapCanvas.tsx');
    expect(map).toMatch(/drawnShipWorldPos\(fx\.shipId\)/);
    expect(map).toMatch(/listDiffFlashedShipsRef\.current\.has\(fx\.shipId\)/);
  });
});
