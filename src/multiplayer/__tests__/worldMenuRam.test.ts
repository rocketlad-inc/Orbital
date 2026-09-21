// THE ASTEROID WEAPON HAS TO BE REACHABLE FROM THE MENU PLAYERS SEE.
//
// Noah built Trajectory Control Thrusters on Styx and "there's no option
// to do anything with it". The aim-and-fire controls existed — in the
// legacy BodyInspector, which the multiplayer World Menu REPLACES
// (App.tsx: `worldMenuOn ? <WorldMenuOverlay/> : <BodyInspector/>`, and
// the World Menu is on by default). The Dyson Sphere card went missing
// the same way. Source-level on purpose: the World Menu needs the whole
// game context to render, and what regressed was a MOUNT, which is
// exactly what this reads.

import fs from 'fs';
import path from 'path';

const read = (rel: string) =>
  fs.readFileSync(path.resolve(__dirname, '../../..', rel), 'utf8');

describe('asteroid ram controls in the World Menu', () => {
  const menu = read('src/multiplayer/WorldMenuOverlay.tsx');
  const inspector = read('src/components/BodyInspector.tsx');
  const app = read('src/App.tsx');

  it('the World Menu really does replace the inspector in MP (the premise)', () => {
    expect(app).toMatch(/worldMenuOn\s*\n?\s*\?\s*<>\s*<WorldMenuOverlay/);
  });

  it('mounts the ram controls for asteroids', () => {
    expect(menu).toMatch(/import \{ RamControlsSection \} from '..\/components\/BodyInspector'/);
    expect(menu).toMatch(/body\.type === 'asteroid' && \(\s*<div[^>]*>\s*<RamControlsSection body=\{body\} \/>/);
  });

  it('uses the ONE shared section, not a second copy that can drift', () => {
    expect(inspector).toMatch(/export const RamControlsSection/);
    expect(menu).not.toMatch(/const RamControlsSection/);
  });
});
