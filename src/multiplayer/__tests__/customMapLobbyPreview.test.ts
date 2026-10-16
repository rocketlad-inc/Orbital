// A custom-map lobby's backdrop draws the map's own sun and start worlds,
// never Sol (2026-10-15 audit). The server sends them in
// snap.custom_map.preview (worker/lobby.js customMapOptions).

import { customPreviewSystem } from '../LobbyMapPreview';

describe('custom-map lobby preview', () => {
  const sys = customPreviewSystem({
    sun: { name: 'Ardent', color: '#7fd4ff', size: 60 },
    bodies: [
      { id: 'cm_home', name: 'Aurel', type: 'terrestrial', parent: 'sol', orbit: 400, angle: 1, radius: 3, color: '#4f8a3c', surface: 'verdant' },
      { id: 'cm_g', name: 'Colossus', type: 'gas-giant', parent: 'sol', orbit: 1200, angle: 2, radius: 8, color: '#d4a574', rings: true },
      { id: 'cm_m', name: 'Pip', type: 'moon', parent: 'cm_g', orbit: 30, angle: 0, radius: 1.2, color: '#a0a6ad' },
    ],
  });

  it('draws the custom sun under its own name, colour and size', () => {
    const sun = sys.byId.get('sol')!;
    expect(sun).toMatchObject({ name: 'Ardent', color: '#7fd4ff', radius: 60, type: 'star' });
  });

  it('holds only the map\'s worlds, in client spellings and authored orbits', () => {
    expect(sys.bodies.map(b => b.id)).toEqual(['sol', 'cm_home', 'cm_g', 'cm_m']);
    expect(sys.byId.get('cm_g')!.type).toBe('gas_giant');
    expect(sys.byId.get('cm_m')!).toMatchObject({ parent: 'cm_g', orbitRadius: 30 });
    expect(sys.bodies.some(b => b.id === 'earth' || b.id === 'jupiter')).toBe(false);
  });
});
