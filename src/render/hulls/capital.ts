// @ts-nocheck -- authored as a data DSL (see engine.ts); the shapes are data, not typed code.
// CAPITAL HULLS and MEGASTRUCTURES, in the same hull language as the ships.
// Capitals face +x like ships; structures are centred at (32, 0) and have no front.
import { hull, wing, pod, poly, ring, disc, line, glass, drive, gun, turret, bez, arc } from './engine';

const box = (x, y, w, h, role, o = {}) => poly([[x, y], [x + w, y], [x + w, y + h], [x, y + h]], role, { m: false, ...o });
const rad = (d) => d * Math.PI / 180;
const around = (n, r, f, a0 = 0, cx = 32, cy = 0) => Array.from({ length: n }, (_, i) => { const a = a0 + i * 360 / n; return f(cx + Math.cos(rad(a)) * r, cy + Math.sin(rad(a)) * r, a, i); }).flat();
const rot = (pts, a, cx = 32, cy = 0) => pts.map(([x, y]) => { const c = Math.cos(rad(a)), s = Math.sin(rad(a)); const dx = x - cx, dy = y - cy; return [cx + dx * c - dy * s, cy + dx * s + dy * c]; });

export const MEGA_DESTROYER = {
  A: { name: 'Battle Station', note: 'a fortress that learned to fly', parts: [
    ...around(4, 22, (x, y, a) => [poly(rot([[x - 4, y - 4], [x + 4, y - 4], [x + 4, y + 4], [x - 4, y + 4]], 45, x, y), 'plate2', { m: false, layer: 'under' })], 45),
    ...around(4, 16, (x, y) => [line([[32, 0], [x, y]], 3, 'plate', { m: false, layer: 'under' })], 45),
    disc(32, 0, 15),
    ring(32, 0, 10, 10, 2.2, { layer: 'top' }),
    ...around(4, 22, (x, y) => [turret(x, y, 2.4, { m: false })], 45),
    gun(46, 0, 17, 3.2),
    disc(32, 0, 4, { core: true, layer: 'top' }),
    drive(12, -9, 2.4), drive(12, 9, 2.4, { m: false }),
  ] },
  B: { name: 'Spinal Lance', note: 'the ship is the gun', parts: [
    gun(40, 0, 24, 4),
    hull([[60, 0], [50, -6], [36, -8], [20, -14], [8, -14], [4, -8], [4, 0]]),
    poly([[46, -5], [22, -11], [22, -3], [46, -3]], 'plate'),
    line([[40, -6.4], [22, -10.4]], 1, 'liv'),
    pod(14, -17, 14, 5, 2), turret(30, -10, 2.2), turret(18, -10, 2.2),
    poly([[62, -2], [64, -2], [64, 2], [62, 2]], 'glow', { m: false, layer: 'top' }),
    drive(4, -5, 2.6), drive(8, -17, 2),
  ] },
  C: { name: 'Ringed Fortress', note: 'armoured core inside two battle rings', parts: [
    ring(32, 0, 26, 26, 3.4), ring(32, 0, 19, 19, 2.6),
    ...around(8, 26, (x, y) => [turret(x, y, 2, { m: false })], 22.5),
    ...around(4, 22.5, (x, y) => [line([[32, 0], [x, y]], 2.4, 'plate', { m: false, layer: 'under' })]),
    disc(32, 0, 12),
    gun(42, 0, 14, 2.6),
    disc(32, 0, 4, { core: true, layer: 'top' }),
  ] },
  D: { name: 'Ribbed Dreadnought', note: 'a keel of armour ribs', parts: [
    ...[50, 42, 34, 26, 18].map((x, i) => poly([[x, -3], [x - 3, -16 + i], [x - 6, -16 + i], [x - 5, -3]], 'plate2', { layer: 'wings' })),
    hull([[62, 0], [54, -5], [12, -7], [4, -5], [4, 0]]),
    ...[50, 42, 34, 26, 18].map(x => line([[x - 4, -3], [x - 4.5, -12]], 0.8, 'liv', { layer: 'wings' })),
    turret(48, 0, 2.8), turret(36, 0, 2.8), turret(24, 0, 2.8),
    gun(58, 0, 6, 2.4),
    glass([[58, -1], [55, -1.4], [55, 1.4], [58, 1]]),
    drive(4, -3, 2.8),
  ] },
  E: { name: 'Great Cylinder', note: 'a rotating hull the size of a moon', parts: [
    hull([[60, 0], [58, -10], [50, -16], [12, -16], [6, -10], [6, 0]]),
    ...[48, 40, 32, 24, 16].map(x => line([[x, -15.4], [x, 15.4]], 1, 'plate', { m: false })),
    line([[52, -8], [10, -8]], 1.2, 'liv'),
    turret(44, -12, 2), turret(28, -12, 2),
    disc(58, 0, 5, { core: true, layer: 'top' }),
    drive(6, -6, 3), drive(6, 0, 3, { m: false }),
  ] },
};

export const MOBILE_FOUNDRY = {
  A: { name: 'Gantry', note: 'a shipyard that walks', parts: [
    line([[56, -16], [8, -16]], 3, 'plate2'),
    ...[50, 38, 26, 14].map(x => line([[x, -16], [x, 16]], 2, 'plate', { m: false, layer: 'under' })),
    pod(32, 0, 26, 10, 2, { layer: 'top' }),
    poly([[22, -3], [40, -3], [44, 0], [40, 3], [22, 3]], 'glow', { m: false, layer: 'top', op: 0.5 }),
    pod(58, 0, 8, 12, 2), glass([[61, -2], [59, -2], [59, 2], [61, 2]]),
    drive(6, -16, 2.2),
  ] },
  B: { name: 'Cradle', note: 'twin arms cradling a half-built hull', parts: [
    poly([[50, -6], [46, -20], [14, -20], [10, -6]], 'plate2', { layer: 'wings' }),
    line([[46, -20], [14, -20]], 1.2, 'liv', { layer: 'wings' }),
    hull([[40, 0], [34, -4], [18, -4], [16, 0]], { spine: false }),
    line([[40, 0], [18, 0]], 0.7, 'glow', { m: false }),
    ...[44, 32, 20].map(x => line([[x, -20], [x, -6]], 1.2, 'plate', { layer: 'under' })),
    pod(56, 0, 10, 14, 2.4), glass([[60, -2], [58, -2], [58, 2], [60, 2]]),
    drive(10, -14, 2.2),
  ] },
  C: { name: 'Ring Yard', note: 'a dock ring around the keel', parts: [
    ring(30, 0, 22, 22, 4),
    ...around(6, 22, (x, y) => [pod(x, y, 5, 5, 1, { m: false, layer: 'top' })]),
    line([[54, 0], [8, 0]], 3, 'plate', { layer: 'under' }),
    hull([[40, 0], [34, -3], [22, -3], [20, 0]], { spine: false }),
    pod(58, 0, 8, 10, 2), glass([[61, -2], [59, -2], [59, 2], [61, 2]]),
    drive(8, -3, 2),
  ] },
};

export const STRUCTURES = {
  warp_gate: {
    A: { name: 'Octagon Ring', parts: [
      poly(arc(32, 0, 26, 22.5, 382.5, 8), 'plate2', { m: false, layer: 'under' }),
      poly(arc(32, 0, 20, 22.5, 382.5, 8), '#05070b', { m: false, layer: 'under' }),
      poly(arc(32, 0, 18, 0, 360, 24), 'glow', { m: false, layer: 'under', op: 0.55 }), poly(arc(32, 0, 10, 0, 360, 20), '#ffffff', { m: false, layer: 'under', op: 0.35 }),
      ...around(8, 23, (x, y) => [pod(x, y, 4.4, 4.4, 1, { m: false, layer: 'top' })], 22.5),
      line(arc(32, 0, 23, 22.5, 382.5, 8), 0.9, 'liv', { m: false }),
    ] },
    B: { name: 'Hex Frame', parts: [
      ...around(6, 22, (x, y, a) => [line([[x, y], [32 + Math.cos(rad(a + 60)) * 22, Math.sin(rad(a + 60)) * 22]], 4.4, 'plate2', { m: false })]),
      poly(arc(32, 0, 17, 0, 360, 24), 'glow', { m: false, layer: 'under', op: 0.55 }), poly(arc(32, 0, 9, 0, 360, 20), '#ffffff', { m: false, layer: 'under', op: 0.35 }),
      ...around(6, 22, (x, y) => [disc(x, y, 3.4, { layer: 'top' })]),
      ...around(6, 22, (x, y, a) => [line([[x, y], [32 + Math.cos(rad(a + 60)) * 22, Math.sin(rad(a + 60)) * 22]], 0.9, 'liv', { m: false })]),
    ] },
    C: { name: 'Torus', parts: [
      ring(32, 0, 22, 22, 7),
      poly(arc(32, 0, 16, 0, 360, 24), 'glow', { m: false, layer: 'under', op: 0.55 }), poly(arc(32, 0, 9, 0, 360, 20), '#ffffff', { m: false, layer: 'under', op: 0.35 }),
      ...around(12, 22, (x, y) => [disc(x, y, 1.2, { layer: 'top' })]),
    ] },
  },
  weapons_station: {
    A: { name: 'Cruciform', parts: [
      ...around(4, 0, () => []),
      box(26, -24, 12, 48, 'plate2', { layer: 'under' }), box(8, -6, 48, 12, 'plate2', { layer: 'under' }),
      disc(32, 0, 10),
      ...around(4, 20, (x, y) => [turret(x, y, 3, { m: false })]),
      disc(32, 0, 3.6, { core: true, layer: 'top' }),
      line([[27, -22], [37, -22]], 1.2, 'liv', { m: false }), line([[27, 22], [37, 22]], 1.2, 'liv', { m: false }),
    ] },
    B: { name: 'Bastion', parts: [
      poly([[12, -14], [22, -24], [42, -24], [52, -14], [52, 14], [42, 24], [22, 24], [12, 14]], 'plate2', { m: false, layer: 'under' }),
      poly([[16, -12], [24, -20], [40, -20], [48, -12], [48, 12], [40, 20], [24, 20], [16, 12]], 'plate', { m: false }),
      ...[[24, -12], [40, -12], [24, 12], [40, 12]].map(([x, y]) => turret(x, y, 3.2, { m: false })),
      disc(32, 0, 6, { core: true }),
      line([[22, -24], [42, -24]], 1.4, 'liv', { m: false }),
    ] },
    C: { name: 'Star Fort', parts: [
      poly(around(5, 1, (x, y, a) => [[32 + Math.cos(rad(a - 90)) * 26, Math.sin(rad(a - 90)) * 26], [32 + Math.cos(rad(a - 54)) * 12, Math.sin(rad(a - 54)) * 12]]), 'plate2', { m: false, layer: 'under' }),
      disc(32, 0, 11),
      ...around(5, 20, (x, y) => [turret(x, y, 2.4, { m: false })], -90),
      line(around(5, 1, (x, y, a) => [[32 + Math.cos(rad(a - 90)) * 24, Math.sin(rad(a - 90)) * 24]]).concat([[32, -24]]), 0.9, 'liv', { m: false }),
      disc(32, 0, 3.6, { core: true, layer: 'top' }),
    ] },
  },
  gravity_sink: {
    A: { name: 'Collar', parts: [
      poly(arc(32, 0, 12, 0, 360, 24), '#05070b', { m: false, layer: 'under' }),
      ring(32, 0, 18, 18, 6),
      ...around(6, 18, (x, y) => [pod(x, y, 5, 5, 1.2, { m: false, layer: 'top' })]),
      poly(arc(32, 0, 7, 0, 360, 20), 'glow', { m: false, layer: 'top', op: 0.35 }),
      disc(32, 0, 2.4, { core: true, layer: 'top' }),
    ] },
    B: { name: 'Drum Ring', parts: [
      ...around(8, 20, (x, y, a) => [pod(x, y, 7, 9, 2, { m: false })]),
      ring(32, 0, 20, 20, 2, { dash: false }),
      poly(arc(32, 0, 11, 0, 360, 20), '#05070b', { m: false }),
      poly(arc(32, 0, 8, 0, 360, 20), 'glow', { m: false, layer: 'top', op: 0.35 }),
      disc(32, 0, 2.6, { core: true, layer: 'top' }),
    ] },
    C: { name: 'Deep Well', parts: [
      ...[24, 18, 12].map((r, i) => ring(32, 0, r, r, 2.2 - i * 0.4, { dash: i === 0 })),
      ...around(3, 24, (x, y) => [line([[32, 0], [x, y]], 2, 'plate', { m: false, layer: 'under' })], 90),
      poly(arc(32, 0, 7, 0, 360, 20), '#05070b', { m: false, layer: 'top' }),
      disc(32, 0, 2.6, { core: true, layer: 'top' }),
    ] },
  },
  deep_array: {
    A: { name: 'Great Dish', parts: [
      disc(32, 0, 22),
      ...[16, 10, 4].map(r => ring(32, 0, r, r, 0.8, { dash: false, layer: 'top' })),
      ...around(3, 14, (x, y) => [line([[32, 0], [x, y]], 1, 'plate', { m: false })], -90),
      disc(32, 0, 3, { core: true, layer: 'top' }),
    ] },
    B: { name: 'Dish Spine', parts: [
      box(10, -2, 44, 4, 'plate2', { layer: 'under' }),
      ...[18, 32, 46].map(x => disc(x, 0, 7)),
      ...[18, 32, 46].map(x => disc(x, 0, 1.6, { core: true, layer: 'top' })),
      line([[10, -3], [54, -3]], 0.9, 'liv', { m: false }),
    ] },
    C: { name: 'Tilted Dish', parts: [
      poly(arc(32, 0, 24, 0, 360, 28, 14), 'plate2', { m: false }),
      poly(arc(32, -2, 20, 180, 360, 16, 9), 'top', { m: false, op: 0.7 }),
      line([[32, 0], [44, -16]], 1.6, 'plate', { m: false }),
      disc(44, -16, 3, { core: true }),
      line(arc(32, 0, 24, 180, 360, 16, 14), 1, 'liv', { m: false }),
    ] },
  },
  null_field: {
    A: { name: 'Pylon Cage', parts: [
      poly(arc(32, 0, 20, 0, 360, 24), 'glow', { m: false, layer: 'under', op: 0.14 }),
      ...around(6, 20, (x, y) => [pod(x, y, 5, 5, 2.5, { m: false })], 30),
      ...around(6, 20, (x, y, a) => [line([[x, y], [32 + Math.cos(rad(a + 60)) * 20, Math.sin(rad(a + 60)) * 20]], 0.8, 'glow', { m: false })], 30),
      disc(32, 0, 4),
    ] },
    B: { name: 'Containment', parts: [
      poly(arc(32, 0, 18, 0, 360, 24), 'glow', { m: false, layer: 'under', op: 0.16 }),
      ring(32, 0, 22, 22, 3),
      ...around(4, 22, (x, y) => [box(x - 3.5, y - 3.5, 7, 7, 'plate2', { layer: 'top' })], 45),
      poly(arc(32, 0, 8, 0, 360, 6), 'plate', { m: false }),
      line(arc(32, 0, 14, 0, 360, 24), 0.7, 'glow', { m: false }),
    ] },
    C: { name: 'Corner Cage', parts: [
      poly([[10, -20], [54, -20], [54, 20], [10, 20]], 'glow', { m: false, layer: 'under', op: 0.12 }),
      ...[[10, -20], [54, -20], [54, 20], [10, 20]].map(([x, y]) => disc(x, y, 4)),
      line([[10, -20], [54, -20], [54, 20], [10, 20], [10, -20]], 0.8, 'glow', { m: false }),
      disc(32, 0, 5),
    ] },
  },
};

export const SCAFFOLD = [0, 1, 2, 3].map(st => ({ name: `Stage ${st + 1}`, parts: [
  ...around(8, 22, (x, y, a, i) => i < 2 + st * 2 ? [line([[x, y], [32 + Math.cos(rad(a + 45)) * 22, Math.sin(rad(a + 45)) * 22]], 2, 'plate2', { m: false })] : [], 0),
  ...around(8, 22, (x, y, a, i) => i < 3 + st * 2 ? [disc(x, y, 2)] : []),
  ...(st >= 1 ? [line([[32, -22], [32, 22]], 1.4, 'plate', { m: false, layer: 'under' }), line([[10, 0], [54, 0]], 1.4, 'plate', { m: false, layer: 'under' })] : []),
  ...(st >= 2 ? [disc(32, 0, 6)] : []),
  ...(st >= 3 ? [disc(32, 0, 2.4, { core: true, layer: 'top' })] : []),
  pod(46, 14, 6, 4, 1, { m: false, layer: 'top' }), line([[46, 12], [40, 6]], 0.8, 'liv', { m: false }),
] }));

// Orbital station: a hub with modules (each module appears at its level).
export const STATION = {
  core: { name: 'Station hub', parts: [
    box(8, -3, 48, 6, 'plate', { layer: 'under' }),
    ...[10, 16, 44, 50].map(x => box(x, -15, 5, 30, '#16324c', { layer: 'under' })),
    ...[10, 16, 44, 50].map(x => line([[x + 2.5, -15], [x + 2.5, 15]], 0.6, '#3f6f9a', { m: false })),
    ring(32, 0, 14, 14, 3.4),
    ...around(4, 14, (x, y) => [line([[32, 0], [x, y]], 1.4, 'plate', { m: false, layer: 'under' })]),
    disc(32, 0, 6),
    disc(32, 0, 2.2, { core: true, layer: 'top' }),
  ] },
  weapons: { name: 'Weapons module', parts: [
    box(20, -8, 24, 16, 'plate2'), turret(26, -3, 3, { m: false }), turret(38, 3, 3, { m: false }), line([[20, -8], [44, -8]], 1.2, 'liv', { m: false }),
  ] },
  lab: { name: 'Lab module', parts: [
    disc(32, 0, 10), poly(arc(32, 0, 7, 190, 350, 8).concat([[32, 0]]), 'glass', { m: false, op: 0.6, layer: 'top' }), line([[32, -10], [44, -20]], 1.2, 'plate', { m: false }), disc(44, -20, 3.2),
  ] },
  shipyard: { name: 'Shipyard module', parts: [
    line([[14, -12], [50, -12]], 2.4, 'plate2', { m: false }), line([[14, 12], [50, 12]], 2.4, 'plate2', { m: false }),
    ...[18, 30, 42].map(x => line([[x, -12], [x, 12]], 1.2, 'plate', { m: false, layer: 'under' })),
    hull([[46, 0], [40, -4], [22, -4], [20, 0]], { spine: false }), line([[46, 0], [22, 0]], 0.8, 'glow', { m: false }),
    line([[14, -13], [50, -13]], 0.9, 'liv', { m: false }),
  ] },
};
