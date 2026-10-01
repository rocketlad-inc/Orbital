// @ts-nocheck -- authored as a data DSL (see engine.ts); the shapes are data, not typed code.
// FREIGHTERS: supply lines. Holds, tanks, spines and tugs, never guns.
import { hull, wing, pod, poly, ring, disc, line, glass, drive, gun, turret, bez, arc } from './engine';

const box = (x, y, w, h, role) => poly([[x, y], [x + w, y], [x + w, y + h], [x, y + h]], role, { m: false });
const containers = (x0, cols, rows, cw = 7, ch = 7, gap = 1, y0 = null) => {
  const out = [], top = y0 ?? -(rows * (ch + gap)) / 2;
  for (let c = 0; c < cols; c++) for (let r = 0; r < rows; r++) {
    out.push(pod(x0 + c * (cw + gap) + cw / 2, top + r * (ch + gap) + ch / 2, cw, ch, 0.6, { m: false }));
    if ((c + r) % 3 === 0) out.push(box(x0 + c * (cw + gap) + 1, top + r * (ch + gap) + ch - 2.2, cw - 2, 1.2, 'liv'));
  }
  return out;
};

export const FREIGHTER = {
  A: { name: 'Hauler', note: 'container spine', parts: [
    line([[52, 0], [12, 0]], 3, 'plate', { layer: 'under' }),
    ...containers(16, 4, 2, 7, 8, 1.2),
    hull([[62, 0], [58, -5], [50, -6], [50, 0]]),
    glass([[60, -1.2], [56, -2.4], [56, 2.4], [60, 1.2]]),
    pod(10, 0, 6, 12, 1.5), drive(7, -3.5, 2),
  ] },
  B: { name: 'Tanker', note: 'twin-tank bulk carrier', parts: [
    line([[52, 0], [10, 0]], 3, 'plate', { layer: 'under' }),
    disc(40, -8, 7.5), disc(40, 8, 7.5), disc(24, -8, 7.5), disc(24, 8, 7.5),
    line([[40, -15], [40, -1]], 0.9, 'liv', { m: false }), line([[24, -15], [24, -1]], 0.9, 'liv', { m: false }),
    hull([[62, 0], [58, -4], [52, -4.5], [52, 0]]),
    glass([[60, -1], [56, -2], [56, 2], [60, 1]]),
    drive(10, -3, 2),
  ] },
  C: { name: 'Bulk', note: 'one great hold, tiny bridge', parts: [
    hull([[58, 0], [56, -14], [16, -14], [10, -10], [10, 0]]),
    poly([[52, -12], [18, -12], [18, 12], [52, 12]], 'plate', { m: false }),
    line([[44, -12], [44, 12]], 0.8, 'edge', { m: false }), line([[35, -12], [35, 12]], 0.8, 'edge', { m: false }), line([[26, -12], [26, 12]], 0.8, 'edge', { m: false }),
    poly([[52, -12], [52, -9], [18, -9], [18, -12]], 'liv', { m: false }),
    pod(58, 0, 6, 8, 1.5, { layer: 'top' }), glass([[61, -2], [59, -2], [59, 2], [61, 2]]),
    drive(10, -6, 2.4),
  ] },
  D: { name: 'Tug', note: 'small tug towing a cargo pod', parts: [
    line([[40, 0], [30, 0]], 1, 'liv', { layer: 'under' }),
    disc(18, 0, 11),
    line([[18, -11], [18, 11]], 1, 'liv', { m: false }), line([[7, 0], [29, 0]], 0.7, 'edge'),
    hull([[62, 0], [58, -5], [44, -7], [40, -5], [40, 0]]),
    glass([[60, -1.4], [56, -2.4], [56, 2.4], [60, 1.4]]),
    drive(42, -5.5, 1.6), drive(6, 0, 1.4),
  ] },
  E: { name: 'Barge', note: 'flat wide deck barge', parts: [
    hull([[56, 0], [60, -20], [12, -20], [8, -16], [8, 0]]),
    poly([[54, -18], [14, -18], [14, 18], [54, 18]], 'plate', { m: false }),
    ...[-12, -4, 4, 12].map(y => box(18, y - 2.5, 32, 5, 'plate2')),
    line([[54, -18], [14, -18]], 1.2, 'liv'),
    pod(56, 0, 5, 7, 1.2, { layer: 'top' }), glass([[58, -1.6], [57, -1.6], [57, 1.6], [58, 1.6]]),
    drive(8, -12, 2.2), drive(8, -3, 2.2),
  ] },
  F: { name: 'Spindle', note: 'long cylinder, cargo drums', parts: [
    hull([[62, 0], [56, -4], [10, -4], [6, -2], [6, 0]]),
    ...[48, 38, 28, 18].map(x => pod(x, 0, 6, 18, 2.8, { m: false, layer: 'top' })),
    ...[48, 38, 28, 18].map(x => box(x - 3, -1, 6, 2, 'liv')),
    glass([[60, -1.2], [57, -2], [57, 2], [60, 1.2]]),
    drive(6, 0, 2.4),
  ] },
  G: { name: 'Ore Scoop', note: 'open scoop jaws forward', parts: [
    poly([[40, -6], [62, -16], [62, -11], [46, -4]], 'plate2', { layer: 'wings' }),
    poly([[62, -16], [62, -11], [60.5, -11.4], [60.5, -15.4]], 'liv'),
    hull([[46, 0], [42, -9], [14, -10], [8, -7], [8, 0]]),
    poly([[40, -7], [18, -8], [18, 8], [40, 7]], 'plate', { m: false }),
    ...[[24, -3], [30, 3], [36, -2], [22, 4], [33, -5]].map(([x, y]) => disc(x, y, 2)),
    glass([[14, -1.4], [11, -2], [11, 2], [14, 1.4]]),
    drive(8, -5, 2.2),
  ] },
  H: { name: 'Liner', note: 'sleek passenger liner, window rows', parts: [
    wing([[30, -5], [18, -14], [12, -14], [14, -5]]),
    hull([[62, 0], ...bez([56, -3], [46, -7], [30, -7], 5), [14, -6], [8, -4], [8, 0]]),
    ...Array.from({ length: 9 }, (_, i) => box(18 + i * 4, -5, 1.6, 1.4, 'glass')),
    line([[54, -3], [16, -3]], 0.9, 'liv'),
    glass([[58, -1.2], [52, -2.2], [52, 2.2], [58, 1.2]]),
    drive(8, -2, 2),
  ] },
  I: { name: 'Crane', note: 'gantry crane over the hold', parts: [
    hull([[58, 0], [54, -8], [14, -8], [8, -6], [8, 0]]),
    poly([[50, -6], [18, -6], [18, 6], [50, 6]], 'plate', { m: false }),
    line([[40, -16], [40, 16]], 2.4, 'plate2', { m: false, layer: 'under' }), line([[28, -16], [28, 16]], 2.4, 'plate2', { m: false, layer: 'under' }),
    line([[40, -16], [28, -16]], 2, 'liv'),
    pod(34, 9, 6, 5, 1, { m: false, layer: 'top' }),
    glass([[56, -1.3], [52, -2], [52, 2], [56, 1.3]]),
    drive(8, -4, 2),
  ] },
  T: { name: 'Caravan', note: 'chain of three linked pods', parts: [
    line([[54, 0], [8, 0]], 1.4, 'liv', { layer: 'under' }),
    pod(42, 0, 11, 12, 3), pod(28, 0, 11, 12, 3), pod(14, 0, 11, 12, 3),
    hull([[62, 0], [58, -4], [51, -5], [50, 0]]),
    glass([[60, -1.2], [56, -2], [56, 2], [60, 1.2]]),
    drive(8, -3.5, 1.8),
  ] },

  J: { name: 'Specter', premium: true, note: 'stealth courier, faceted hold', parts: [
    hull([[62, 0], [44, -8], [20, -12], [8, -8], [8, 0]], { spine: false }),
    poly([[44, -8], [20, -12], [22, -4], [40, -3]], 'plate2'),
    ...[26, 32, 38].map(x => box(x, -2.5, 4, 5, 'plate')),
    line([[62, 0], [40, -3], [22, -4], [8, 0]], 0.7, 'liv'),
    glass([[52, -1], [47, -2], [47, 2], [52, 1]]),
    drive(8, -4, 1.8), drive(8, 4, 1.8),
  ] },
  K: { name: 'Talon', premium: true, note: 'grapple claws clutching cargo', parts: [
    poly([[48, -4], [58, -14], [52, -16], [42, -6]], 'plate2', { layer: 'wings' }),
    poly([[58, -14], [60, -8], [56, -9]], 'liv', { layer: 'wings' }),
    disc(52, 0, 7),
    hull([[44, 0], [40, -6], [14, -7], [8, -5], [8, 0]]),
    ...containers(18, 2, 1, 8, 9, 1.5),
    glass([[40, -1.4], [36, -2], [36, 2], [40, 1.4]]),
    drive(8, -3, 2),
  ] },
  L: { name: 'Corsair', premium: true, note: 'smuggler with one side-slung hold', parts: [
    hull([[60, 0], [54, -4], [16, -5], [8, -3], [8, 0]]),
    pod(30, 12, 30, 12, 3, { m: false }),
    line([[40, 5], [40, 7]], 2, 'plate', { m: false, layer: 'under' }), line([[22, 5], [22, 7]], 2, 'plate', { m: false, layer: 'under' }),
    box(18, 13, 24, 1.4, 'liv'),
    glass([[52, -3.6], [46, -3.8], [46, -1], [52, -1]]),
    drive(14, 12, 2.6, { m: false }), drive(8, -1.5, 1.6, { m: false }),
  ] },
  M: { name: 'Aurora', premium: true, note: 'swan-necked luxury hauler', parts: [
    wing([[36, -5], ...bez([32, -10], [24, -22], [8, -18], 8).slice(1), [18, -5]]),
    hull([[63, 0], ...bez([58, -2], [50, -3], [44, -8], 5), [20, -9], [10, -6], [8, 0]]),
    line(bez([31, -10], [24, -20], [10, -17], 8), 0.9, 'liv', { layer: 'wings' }),
    ...[22, 29, 36].map(x => box(x, -2.5, 5, 5, 'plate')),
    glass([[60, -0.9], [55, -1.3], [55, 1.3], [60, 0.9]]),
    drive(8, -3, 2),
  ] },
  N: { name: 'Bastion', premium: true, note: 'armoured strongbox convoy', parts: [
    hull([[58, 0], [58, -8], [50, -11], [12, -11], [8, -7], [8, 0]]),
    poly([[48, -9], [16, -9], [16, 9], [48, 9]], 'plate', { m: false }),
    ...[[20, -7], [32, -7], [20, 1], [32, 1]].map(([x, y]) => box(x, y, 10, 6, 'plate2')),
    line([[48, -10], [16, -10]], 1.1, 'liv'),
    glass([[56, -1.4], [52, -2], [52, 2], [56, 1.4]]),
    drive(8, -5, 2.2),
  ] },
  O: { name: 'Mirage', premium: true, note: 'twin holds, bridged by light', parts: [
    hull([[58, -8], [50, -14], [14, -14], [8, -11], [8, -4], [50, -4]], { m: false }),
    hull([[58, 8], [50, 14], [14, 14], [8, 11], [8, 4], [50, 4]], { m: false }),
    ...[18, 30, 42].map(x => line([[x, -4], [x, 4]], 1.4, 'glow')),
    ...[20, 30, 40].map(x => box(x - 3, -12, 6, 5, 'plate')), ...[20, 30, 40].map(x => box(x - 3, 7, 6, 5, 'plate')),
    drive(8, -7.5, 1.8), drive(8, 7.5, 1.8),
  ] },
  P: { name: 'Tempest', premium: true, note: 'storm-runner, jagged heat fins', parts: [
    wing([[40, -5], [36, -12], [31, -9], [28, -18], [23, -12], [18, -20], [14, -5]]),
    hull([[62, 0], [54, -5], [16, -6], [8, -4], [8, 0]]),
    ...[18, 27, 36].map(x => box(x, -3.5, 7.5, 7, 'plate')), ...[18, 36].map(x => box(x + 1, 2, 5.5, 1.2, 'liv')),
    glass([[57, -1.3], [51, -2], [51, 2], [57, 1.3]]),
    drive(8, -3, 2.4),
  ] },
  Q: { name: 'Sovereign', premium: true, note: 'treasure galleon, crowned stern', parts: [
    poly([[20, -8], [18, -16], [15, -9], [12, -18], [9, -9], [6, -15], [5, -8]], 'liv', { layer: 'wings' }),
    hull([[62, 0], [56, -5], [46, -9], [14, -10], [6, -8], [5, 0]]),
    poly([[44, -8], [18, -8], [18, 8], [44, 8]], 'plate', { m: false }),
    ...[20, 29, 38].map(x => box(x, -3, 6, 6, 'plate2')), ...[20, 38].map(x => box(x + 1, -1.8, 4, 1.2, 'liv')),
    line([[46, -6.6], [16, -6.6]], 1, 'liv'),
    glass([[59, -1.3], [55, -1.8], [55, 1.8], [59, 1.3]]),
    drive(5, -3.5, 2),
  ] },
  R: { name: 'Drake', premium: true, note: 'winged cargo wyrm', parts: [
    wing([[34, -6], [32, -15], [26, -26], [22, -18], [16, -23], [13, -12], [12, -6]]),
    line([[33, -7], [26, -25]], 0.9, 'liv', { layer: 'wings' }), line([[27, -7], [16, -22]], 0.9, 'liv', { layer: 'wings' }),
    hull([[64, 0], [60, -2.4], [52, -2.4], [44, -8], [14, -8], [8, -4], [2, 0]]),
    ...[18, 26, 34].map(x => box(x, -3, 6, 6, 'plate')),
    glass([[61, -1], [56, -1.4], [56, 1.4], [61, 1]]),
    drive(9, 0, 2),
  ] },
  S: { name: 'Eclipse', premium: true, note: 'cargo sphere in a crescent cradle', parts: [
    poly(arc(30, 0, 25, 105, 255, 16).concat(arc(36, 0, 20, 250, 110, 16)), 'plate2', { m: false, layer: 'under' }),
    line(arc(30, 0, 22.5, 115, 245, 14), 1.1, 'liv', { m: false, layer: 'under' }),
    disc(36, 0, 14),
    ...[[30, -5], [38, -6], [34, 4], [42, 3]].map(([x, y]) => box(x - 2.5, y - 2.5, 5, 5, 'plate')),
    hull([[62, 0], [58, -3], [50, -3.5], [48, 0]]),
    glass([[60, -1], [56, -2], [56, 2], [60, 1]]),
    drive(20, -6, 1.6), drive(20, 6, 1.6),
  ] },
};
