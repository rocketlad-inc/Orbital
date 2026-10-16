// @ts-nocheck -- authored as a data DSL (see engine.ts); the shapes are data, not typed code.
// THE MEDIEVAL SERIES (letter Z, every class; Commander's Commission).
// Each hull is a weapon of the armoury, drawn as a spaceship: the
// silhouette a player reads at a glance is the weapon, the detail that
// makes it a ship is engines, canopies and plating.
//
//   corvette   Spear        leaf blade at the nose, lugs, a long shaft
//   frigate    Longsword    blade forward, crossguard wings, grip, pommel
//   destroyer  Warhammer    haft, a head with a hammer face and a beak, a top spike
//   freighter  Battle Axe   two crescent bits (the holds) on a haft
//   colony     Kite Shield  the shield itself, a heraldic cross, the boss a habitat
//
// The weapon is the outline; every part still sits in the 64x64 box
// with the nose at +x, so the map scales them like any other hull.
import { hull, wing, pod, poly, disc, line, glass, drive, gun, turret, arc, bez } from './engine';

// ---- Spear (corvette) ----------------------------------------------------
const SPEAR = { name: 'Spear', note: 'a leaf-bladed spear: head, lugs, a long shaft', parts: [
  // Lugs below the head (a winged spear): small swept fins.
  wing([[44, -2.8], [46.8, -2.8], [42.4, -8.4], [40.4, -8.4]]),
  // The head + shaft as one body, top half (nose -> butt).
  hull([[63, 0], [59.5, -2.7], [55.5, -5.2], [52, -6.2], [48.8, -4.6], [47.2, -2.7], [46, -2.7],
    [14, -2.7], [11, -3.5], [8.5, -3.1], [8.5, 0]], { spine: false }),
  // The blade's raised midrib and its two bevels.
  line([[48.5, 0], [61.5, 0]], 0.7, 'liv', { m: false }),
  poly([[61, -0.6], [55.6, -3.8], [52.2, -4.7], [49.6, -3.6], [48.6, -0.6]], 'plate2'),
  // Socket collar where the head meets the shaft.
  pod(46, 0, 2.8, 6.4, 0.9, { m: false, layer: 'top' }),
  // Shaft wraps (the bindings): livery bands.
  ...[22, 27, 32].map(x => poly([[x, -2.9], [x + 1.4, -2.9], [x + 1.4, 2.9], [x, 2.9]], 'liv', { m: false })),
  // A narrow canopy on the shaft, behind the collar.
  glass([[43, -1.2], [36.6, -1.8], [36.6, 1.8], [43, 1.2]]),
  // The butt cap and its drive.
  pod(10.4, 0, 3.6, 7, 1.2, { m: false, layer: 'top' }),
  drive(8.6, 0, 2.2, { m: false }),
] };

// ---- Longsword (frigate) -------------------------------------------------
const LONGSWORD = { name: 'Longsword', note: 'a longsword: blade forward, crossguard wings, grip and pommel', parts: [
  // Crossguard: a straight bar with flared quillon tips, swept a touch forward.
  wing([[24.6, -3.4], [29.4, -3.4], [30, -12.6], [31.8, -16.4], [27.2, -17.2], [24.4, -13.4]]),
  poly([[26.6, -4.6], [28.2, -4.6], [28.7, -12.2], [26.9, -12.2]], 'liv', { layer: 'wings' }),
  // Thrusters in the quillon tips.
  drive(25.2, -14.8, 1.6),
  // Blade + ricasso + grip as one body (nose -> pommel).
  hull([[63, 0], [57.5, -3], [36, -4.3], [30, -4.3], [29.4, -4.7], [29.4, -2.8],
    [17, -2.8], [16, -3.5], [14.5, -3.5], [14.5, 0]], { spine: false }),
  // The fuller: a groove down the middle of the blade.
  line([[33, 0], [55, 0]], 1.6, 'plate', { m: false }),
  line([[33, 0], [55, 0]], 0.5, 'liv', { m: false }),
  // Grip wraps.
  ...[18, 20.6, 23.2, 25.8].map(x => line([[x, -2.8], [x + 1.6, 2.8]], 0.8, 'liv', { m: false })),
  // Canopy on the ricasso, just forward of the guard.
  glass([[36, -1.5], [30.8, -2.4], [30.8, 2.4], [36, 1.5]]),
  // Pommel: a round, lit knob with the main drive behind it.
  disc(12, 0, 4.3, { core: true }),
  drive(8.4, 0, 2.2, { m: false }),
] };

// ---- Warhammer (destroyer) -----------------------------------------------
// Asymmetric on purpose: a war hammer is a hammer face on one side and a
// beak on the other, which is the whole read.
const WARHAMMER = { name: 'Warhammer', note: 'a war hammer: haft, hammer face, beak and top spike', parts: [
  // The head's core block across the haft.
  pod(50, 0, 10, 10, 1.2, { m: false }),
  // Hammer face (y < 0): a block that flares into a broad striking face.
  poly([[45.6, -4.5], [54.4, -4.5], [55.2, -11.5], [57.6, -13.2], [57.6, -17], [42.4, -17], [42.4, -13.2], [44.8, -11.5]], 'plate2', { m: false }),
  poly([[42.4, -15.2], [57.6, -15.2], [57.6, -17], [42.4, -17]], 'top', { m: false }),
  line([[43.4, -16.1], [56.6, -16.1]], 0.6, 'liv', { m: false }),
  turret(47, -9.2, 1.7, { m: false }), turret(53, -9.2, 1.7, { m: false }),
  // Beak (y > 0): a curved spike sweeping back.
  poly([...bez([46, 4.5], [47, 12], [42.6, 19], 8), [44.4, 19.4], ...bez([47.2, 18], [53, 11], [54.4, 4.5], 8)], 'plate', { m: false }),
  line(bez([50, 5.5], [50, 12], [45.6, 17.6], 6), 0.6, 'liv', { m: false }),
  // Top spike past the head: the ram.
  poly([[55, -2.6], [64, 0], [55, 2.6]], 'plate2', { m: false }),
  line([[56, 0], [62.6, 0]], 0.5, 'liv', { m: false }),
  // Haft: long, with langets (metal straps) running back from the head.
  hull([[45.2, 0], [45.2, -2.6], [14, -2.6], [11.2, -3.6], [8.5, -3.6], [8.5, 0]], { spine: false }),
  line([[33, -2.3], [45, -2.3]], 0.8, 'dark'),
  ...[20, 25].map(x => poly([[x, -2.8], [x + 1.6, -2.8], [x + 1.6, 2.8], [x, 2.8]], 'liv', { m: false })),
  glass([[42.5, -1.2], [36.5, -1.7], [36.5, 1.7], [42.5, 1.2]]),
  // Butt and twin drives.
  drive(8.6, -1.9, 1.8),
] };

// ---- Battle Axe (freighter) ----------------------------------------------
// Two crescent bits, one each side: the holds ride in the blades.
const AXE_BIT = [
  [47.8, -3], [44.6, -6.5],
  ...bez([44.6, -6.5], [40, -9], [36.2, -17], 6).slice(1),
  ...arc(48, -9.5, 12.6, 200, 340, 14, 10.8).slice(1),
  ...bez([59.8, -13.2], [55, -9], [52.4, -6.5], 6).slice(1),
  [50.6, -3],
];
const BATTLE_AXE = { name: 'Battle Axe', note: 'a double-bitted battle axe; the holds are the blades', parts: [
  poly(AXE_BIT, 'plate2'),
  // The cutting edge, bright along the crescent.
  line(arc(48, -9.5, 12.6, 204, 336, 12, 10.8), 0.9, 'top'),
  // Cargo bays in each bit, following the curve.
  ...[[40, -12.6], [44.8, -15.4], [50.2, -15.4], [55, -12.6]].map(([x, y]) =>
    poly([[x - 1.8, y - 1.3], [x + 1.8, y - 1.3], [x + 1.8, y + 1.3], [x - 1.8, y + 1.3]], 'liv')),
  // Head socket and the spike past it.
  pod(49.2, 0, 6.4, 7.6, 1.2, { m: false, layer: 'top' }),
  poly([[52.2, -1.6], [60.5, 0], [52.2, 1.6]], 'plate', { m: false, layer: 'top' }),
  // Haft.
  hull([[46, 0], [46, -2.1], [14, -2.1], [11, -3.4], [8.5, -3.4], [8.5, 0]], { spine: false }),
  ...[22, 28, 34].map(x => line([[x, -2.1], [x + 1.4, 2.1]], 0.7, 'liv', { m: false })),
  glass([[44.5, -1], [39.5, -1.5], [39.5, 1.5], [44.5, 1]]),
  drive(8.6, -1.8, 1.7),
] };

// ---- Kite Shield (colony) ------------------------------------------------
const KITE_SHIELD = { name: 'Kite Shield', note: 'a kite shield with a heraldic cross; the boss is the habitat', parts: [
  // The shield: a flat top at the stern, sides curving to a point at the nose.
  hull([[61, 0], ...bez([61, 0], [47, -15.5], [24, -17.2], 8).slice(1), [13, -17.2], [11.6, -15.6], [11.6, 0]], { spine: false }),
  // A rim inside the edge.
  line([[58, 0], ...bez([58, 0], [46, -13.3], [24, -14.8], 8).slice(1), [14, -14.8], [14, 0]], 0.8, 'liv'),
  // The cross: one arm along the length, one across.
  poly([[56.4, -1.4], [14, -1.4], [14, 1.4], [56.4, 1.4]], 'liv', { m: false }),
  poly([[29.2, -14.6], [32, -14.6], [32, 14.6], [29.2, 14.6]], 'liv', { m: false }),
  // Habitat windows along the quarters.
  ...[[21, -8], [38, -8], [45, -6]].map(([x, y]) => line([[x - 3, y], [x + 3, y]], 0.9, 'glass')),
  // The boss: the habitat dome where the arms cross.
  disc(30.6, 0, 5, { core: true }),
  // Drives along the flat top.
  drive(11.6, -9, 1.8), drive(11.6, 0, 2.2, { m: false }),
] };

export const CORVETTE_MEDIEVAL = { Z: SPEAR };
export const FRIGATE_MEDIEVAL = { Z: LONGSWORD };
export const DESTROYER_MEDIEVAL = { Z: WARHAMMER };
export const FREIGHTER_MEDIEVAL = { Z: BATTLE_AXE };
export const COLONY_MEDIEVAL = { Z: KITE_SHIELD };
