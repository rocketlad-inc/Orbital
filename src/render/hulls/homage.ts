// @ts-nocheck -- authored as a data DSL (see engine.ts); the shapes are data, not typed code.
// THE HOMAGE LINE (letters U-Y, every class): hulls that nod to famous
// ships of film and television without copying them. Each keeps the
// signature a fan reads at a glance (the foils, the saucer, the flight
// pods, the mandibles) and is drawn in the same two-tone hull language
// as the rest of the fleet. Names are our own; the notes say what the
// shape is, not whose it is.
import { hull, wing, pod, poly, disc, line, glass, drive, gun, turret, arc } from './engine';

const rad = (d) => d * Math.PI / 180;
const rot = (pts, a, cx, cy) => pts.map(([x, y]) => { const c = Math.cos(rad(a)), s = Math.sin(rad(a)); const dx = x - cx, dy = y - cy; return [cx + dx * c - dy * s, cy + dx * s + dy * c]; });
const box = (x, y, w, h, role, o = {}) => poly([[x, y], [x + w, y], [x + w, y + h], [x, y + h]], role, { m: false, ...o });

export const CORVETTE_HOMAGE = {
  U: { name: 'Crossfoil', note: 'four split foils, cannon at every tip', parts: [
    poly([[27, -3], [32, -3], [21, -19.5], [16.5, -19.5]], 'plate', { layer: 'under' }),
    gun(15, -19.8, 22, 0.7),
    wing([[30, -3], [36, -3], [25, -21.5], [20.5, -21.5]]),
    poly([[31.2, -5], [33.6, -5], [27.6, -14.5], [25.2, -14.5]], 'liv', { layer: 'wings' }),
    gun(19.5, -21.6, 25, 0.9),
    pod(20, -5.2, 13, 3.4, 1.5), drive(13.5, -5.2, 1.7),
    hull([[62, 0], [56, -1.5], [38, -2.5], [24, -3.3], [12, -3.5], [8, -2.8], [8, 0]]),
    poly([[49, -1.9], [51, -1.8], [51, 1.8], [49, 1.9]], 'liv', { m: false }),
    glass([[43, -1.2], [37, -1.8], [37, 1.8], [43, 1.2]]),
    disc(31, 0, 1.3),
  ] },
  V: { name: 'Hexwing', note: 'a ball cockpit between two great panels', parts: [
    poly([[29, -5], [35, -5], [34, -15.5], [30, -15.5]], 'plate2'),
    poly([[14, -17.5], [18.5, -20], [45.5, -20], [50, -17.5], [45.5, -15], [18.5, -15]], 'plate'),
    line([[17, -17.5], [47, -17.5]], 0.7, 'liv'),
    ...[23, 32, 41].map(x => line([[x, -15.3], [x, -19.7]], 0.5, 'dark')),
    disc(32, 0, 7.2),
    poly(arc(37.4, 0, 2.6, 0, 360, 8, 2.6), 'glass', { m: false, layer: 'top' }),
    ...[0, 45, 90, 135].map(a => { const c = Math.cos(rad(a)) * 2.6, s = Math.sin(rad(a)) * 2.6; return line([[37.4 - c, -s], [37.4 + c, s]], 0.4, 'dark', { m: false }); }),
    gun(38, -2.6, 4.5, 0.8),
    drive(25.6, 0, 1.4, { m: false }),
  ] },
  W: { name: 'Stinger', note: 'lean interceptor, three drives', parts: [
    wing([[30, -4], [37, -4], [20, -13.5], [15, -13.5]]),
    poly([[31.8, -5.4], [34, -5.4], [22, -12.4], [20, -12.4]], 'liv', { layer: 'wings' }),
    hull([[61, 0], [53, -1.8], [38, -3], [24, -4.2], [12, -4.8], [8, -3.6], [8, 0]]),
    poly([[25, -0.8], [11, -0.8], [9, 0.8], [23, 0.8]], 'plate2', { m: false, layer: 'top' }),
    glass([[46, -1.3], [40, -1.9], [40, 1.9], [46, 1.3]]),
    gun(47, -3, 10, 0.8),
    drive(8, -2.8, 1.8), drive(8, 0, 2.1, { m: false }),
  ] },
  X: { name: 'Quadpod', note: 'a cockpit in an X of engine pods', parts: [
    line([[34, -3], [44, -13]], 2.2, 'plate', { layer: 'under' }),
    line([[26, -3], [18, -13]], 2.2, 'plate', { layer: 'under' }),
    pod(44, -14, 10, 4.2, 1.6), pod(18, -14, 10, 4.2, 1.6),
    drive(39.4, -14, 1.6), drive(13.4, -14, 1.6),
    hull([[52, 0], [47, -3], [22, -3.6], [16, -2.6], [16, 0]]),
    poly([[40, -3.2], [42, -3.3], [42, 3.3], [40, 3.2]], 'liv', { m: false }),
    glass([[50, -1.3], [45, -2], [45, 2], [50, 1.3]]),
    gun(47, -4.6, 9, 0.9),
    drive(16, 0, 1.8, { m: false }),
  ] },
  Y: { name: 'Kitefox', note: 'broad wings with bright tip blades', parts: [
    wing([[22, -5], [42, -5], [27, -21], [19, -22.5], [16, -12]]),
    poly([[36, -6.4], [39, -6.4], [26.4, -19], [23.6, -19]], 'liv', { layer: 'wings' }),
    poly([[19, -22.5], [27, -21], [34, -25], [33, -26.6]], 'plate2', { layer: 'wings' }),
    poly([[28.4, -22.6], [32.4, -24.8], [32.8, -24.2], [28.8, -22]], 'glow', { layer: 'wings' }),
    hull([[61, 0], [55, -2.8], [40, -4.6], [26, -6], [16, -5.6], [12, -3], [12, 0]]),
    glass([[45, -1.9], [36, -2.9], [36, 2.9], [45, 1.9]]),
    gun(46, -3.9, 9, 0.8),
    drive(12, 0, 2.8, { m: false }),
  ] },
};

export const FRIGATE_HOMAGE = {
  U: { name: 'Saucerwing', note: 'saucer forward, twin nacelles on pylons', parts: [
    line([[21, -4], [15, -12.4]], 1.8, 'plate', { layer: 'under' }),
    pod(15, -14, 27, 3.8, 1.9),
    line([[5, -12.5], [26, -12.5]], 0.6, 'glow'),
    poly(arc(28.2, -14, 1.5, -90, 90, 8, 1.8), 'glow', { layer: 'top' }),
    poly([[36, -2.2], [26, -2.8], [26, 0], [36, 0]], 'plate2'),
    hull([[31, 0], [28, -4.4], [14, -5], [10, -3.6], [10, 0]], { spine: false }),
    poly(arc(30.8, 0, 1.4, -90, 90, 8, 2.4), 'glow', { m: false }),
    disc(44, 0, 13.5),
    line(arc(44, 0, 9.5, 0, 360, 40), 0.5, 'plate', { m: false }),
    line(arc(44, 0, 12.6, 0, 360, 48), 0.9, 'liv', { m: false }),
    disc(44, 0, 2.8),
  ] },
  V: { name: 'Stormhawk', note: 'stepped arrow hull, delta wings, wingtip drives', parts: [
    wing([[38, -6], [45, -6], [23, -20], [14, -20], [16, -6]]),
    pod(20, -18.6, 13, 3.4, 1.4), drive(13.5, -18.6, 1.8),
    line([[24, -8], [13, -9.2]], 1.3, 'liv', { layer: 'wings' }),
    hull([[62, 0], [55, -3], [44, -4.4], [40, -5.6], [30, -6.2], [14, -6.2], [10, -4.2], [10, 0]]),
    poly([[52, -2.2], [42, -3.4], [42, -2.8], [52, -1.6]], 'dark'),
    glass([[30, -1.2], [26, -1.6], [26, 1.6], [30, 1.2]]),
    gun(52, 0, 10, 1.2, { m: false }),
    drive(10, -1.6, 2), drive(10, -4.6, 1.8),
  ] },
  W: { name: 'Warbird', note: 'a small head on a long neck, wings swept forward', parts: [
    wing([[31, -4], [16, -4], [22, -14], [28, -24.5], [37.5, -24.5]]),
    ...[[20, -6, 25, -20], [24, -5.4, 30, -21.6], [28, -5, 34, -22]].map(([a, b, c, d]) => line([[a, b], [c, d]], 0.6, 'plate', { layer: 'wings' })),
    poly([[31, -21], [37, -24.5], [36.4, -23], [30.4, -20]], 'liv', { layer: 'wings' }),
    gun(33, -24, 10, 1.2),
    hull([[61, 0], [58, -2.6], [52, -2.8], [48, -1.3], [36, -1.5], [30, -4], [20, -5], [14, -3], [14, 0]]),
    poly(arc(60.4, 0, 1, -90, 90, 6, 1.4), 'glow', { m: false }),
    glass([[56, -1], [53, -1.4], [53, 1.4], [56, 1]]),
    drive(14, 0, 2.4, { m: false }),
  ] },
  X: { name: 'Nightjar', note: 'sleek stealth frigate, drives on the wingtips', parts: [
    wing([[30, -6], [39, -6], [21, -16], [14, -16]]),
    wing([[50, -2.4], [54, -2.2], [46, -7], [43, -7]]),
    pod(16, -16.6, 17, 3.4, 1.6), drive(8, -16.6, 1.8),
    hull([[62, 0], [56, -2], [41, -4.2], [28, -6], [18, -6.2], [12, -4], [12, 0]]),
    line([[54, -1.3], [22, -3.8]], 0.8, 'liv'),
    glass([[52, -1.2], [46, -1.8], [46, 1.8], [52, 1.2]]),
    drive(12, 0, 2.2, { m: false }),
  ] },
  Y: { name: 'Brawler', note: 'a narrow gunship: keel railgun, point defence, one big drive', parts: [
    gun(20, 0, 44, 1.3, { m: false }),
    poly([[12, -7], [6.5, -8.8], [6.5, 0], [12, 0]], 'plate'),
    hull([[60, 0], [56, -3], [46, -3.6], [44, -4.6], [30, -4.8], [28, -5.6], [16, -5.8], [12, -7], [8, -7], [8, 0]]),
    poly([[40, -4.4], [42, -4.5], [42, 4.5], [40, 4.4]], 'liv', { m: false }),
    ...[[46, -3.7], [30, -5]].map(([x, y]) => poly([[x, y], [x - 3, y], [x - 3, y + 0.8], [x, y + 0.8]], 'dark')),
    turret(50, -4.4, 1.4), turret(22, -6.2, 1.4),
    glass([[54, -1.1], [50, -1.6], [50, 1.6], [54, 1.1]]),
    drive(6.5, 0, 3.6, { m: false }),
  ] },
};

export const DESTROYER_HOMAGE = {
  U: { name: 'Flightdeck', note: 'armoured spine between two long flight pods', parts: [
    poly([[40, -5], [36, -5], [36, -9.6], [40, -9.6]], 'plate2'),
    poly([[20, -5], [16, -5], [16, -9.6], [20, -9.6]], 'plate2'),
    pod(28, -12, 42, 5.4, 1.6),
    line([[9, -12.6], [47, -12.6]], 0.5, 'dark'),
    poly([[49, -10.4], [46, -9.6], [46, -14.4], [49, -13.6]], 'glow', { op: 0.6 }),
    hull([[63, 0], [62, -3.4], [56, -6], [51, -4.2], [44, -5.2], [20, -5.8], [10, -5.2], [6, -3.2], [6, 0]]),
    ...[18, 23, 28, 33, 38].map(x => line([[x, -5.6], [x, 5.6]], 0.55, 'plate', { m: false })),
    poly([[63, -1], [59, -1.2], [59, 1.2], [63, 1]], 'dark', { m: false }),
    poly([[57, -4.6], [55, -5.2], [55, 5.2], [57, 4.6]], 'liv', { m: false }),
    turret(44, -2.6, 1.4), turret(30, -2.6, 1.4),
    drive(6, 0, 2.8, { m: false }), drive(7, -3.4, 2.3),
  ] },
  V: { name: 'Dagger', note: 'a vast wedge, command tower astern', parts: [
    hull([[63, 0], [10, -21], [7, -19], [7, 0]]),
    line([[58, -1.4], [14, -18.4]], 0.5, 'plate'),
    poly([[46, 0], [18, -5.4], [10, -5.4], [10, 0]], 'plate2'),
    line([[46, 0], [18, -5.4]], 0.6, 'liv'),
    turret(34, -9.6, 1.3), turret(24, -13.6, 1.3),
    box(10, -4.2, 6, 8.4, 'base', { layer: 'top' }),
    disc(13, -5.6, 1.7, { layer: 'top' }), disc(13, 5.6, 1.7, { layer: 'top' }),
    drive(7, -4.2, 2.4), drive(7, 0, 3, { m: false }), drive(7, -10.5, 2),
  ] },
  W: { name: 'Ironclad', note: 'a sea battleship: triple turrets and a bow gun', parts: [
    hull([[63, 0], [56, -3.8], [48, -6.2], [20, -6.6], [12, -5.6], [8, -3], [8, 0]]),
    poly([[33, -2.8], [26, -3.2], [23, -2.2], [23, 0], [33, 0]], 'plate2', { layer: 'top' }),
    glass([[33, -1], [30, -1.4], [30, 1.4], [33, 1]]),
    ...[[46, 1], [37.5, 1], [17, -1]].flatMap(([x, dir]) => [
      line([[x, -1.3], [x + dir * 10, -1.3]], 1.1, 'plate'),
      line([[x, 0], [x + dir * 10.6, 0]], 1.1, 'plate', { m: false }),
      poly([[x - dir * 3.4, -3.2], [x + dir * 1.6, -3], [x + dir * 3.2, -1.6], [x + dir * 3.2, 1.6], [x + dir * 1.6, 3], [x - dir * 3.4, 3.2]], 'plate2', { m: false }),
      poly([[x - dir * 3.4, -3.2], [x + dir * 1.6, -3], [x + dir * 3.2, -1.6], [x - dir * 3.4, -1.6]], 'top', { m: false, op: 0.55 }),
    ]),
    turret(28, -5.2, 1.1), turret(40, -5.2, 1.1),
    poly(arc(62.2, 0, 1.1, -90, 90, 6, 1.9), 'glow', { m: false, layer: 'top' }),
    line([[58, -2.6], [50, -5]], 0.8, 'liv'),
    drive(8, -2, 2.2),
  ] },
  X: { name: 'Marauder', note: 'needle bow, drop bay amidships, heavy engine block', parts: [
    pod(26, -9.6, 11, 2.6, 1), gun(30, -9.6, 9, 0.8),
    hull([[63, 0], [50, -1.4], [40, -2], [36, -4], [30, -4.6], [28, -7], [14, -7.6], [10, -9.2], [6, -9.2], [6, 0]]),
    poly([[34, -3.4], [20, -3.4], [20, 0], [34, 0]], 'dark'),
    line([[20, -1.7], [34, -1.7]], 0.4, 'plate'),
    line([[50, -4.2], [50, 4.2]], 0.9, 'plate2', { m: false }),
    poly([[48, -1.6], [46, -1.8], [46, 1.8], [48, 1.6]], 'liv', { m: false }),
    turret(24, -5.6, 1.2),
    drive(6, -6.4, 2.4), drive(6, -2.2, 2.4),
  ] },
  Y: { name: 'Siegespine', note: 'blunt armoured prow around a spinal cannon', parts: [
    hull([[61, 0], [61, -3.6], [57, -4.8], [50, -4.8], [48, -6.2], [20, -6.2], [18, -8.2], [8, -8.2], [6, -6], [6, 0]]),
    line([[61, 0], [20, 0]], 1.6, 'dark', { m: false }),
    poly(arc(61.2, 0, 1, -90, 90, 6, 2.2), 'glow', { m: false, layer: 'top' }),
    ...[42, 36, 30, 24].map(x => line([[x, -6], [x, 6]], 0.7, 'plate', { m: false })),
    poly([[46, -6.2], [22, -6.2], [22, -5.3], [46, -5.3]], 'liv'),
    turret(40, -4.4, 1.2), turret(28, -4.4, 1.2),
    drive(6, -5, 2.6), drive(6, -1.6, 2.6),
  ] },
};

export const FREIGHTER_HOMAGE = {
  U: { name: 'Mandible', note: 'saucer hull, twin forward prongs, cockpit off to one side', parts: [
    hull([[40, -11.4], [58.5, -9.6], [58.5, -3.4], [42, -2.2]], { m: false }),
    hull([[40, 11.4], [58.5, 9.6], [58.5, 3.4], [42, 2.2]], { m: false }),
    pod(41, 14.4, 11, 4.2, 2, { m: false }),
    glass([[47, 13.2], [44.6, 12.6], [44.6, 16.2], [47, 15.6]]),
    disc(30, 0, 16.5),
    ...[30, 90, 150, 210, 270, 330].map(a => line([[30 + Math.cos(rad(a)) * 5, Math.sin(rad(a)) * 5], [30 + Math.cos(rad(a)) * 15.5, Math.sin(rad(a)) * 15.5]], 0.5, 'plate', { m: false })),
    disc(26, -8, 3.2),
    line(arc(30, 0, 15.6, 148, 212, 12), 2, 'glow', { m: false }),
    turret(30, 0, 2.4, { m: false }),
  ] },
  V: { name: 'Wanderer', note: 'a bird-shaped tramp: head, body, two swinging engines', parts: [
    line([[24, -6], [16, -13.6]], 2.4, 'plate', { layer: 'under' }),
    pod(16, -14.6, 9, 5.4, 2.6), drive(11.6, -14.6, 2.6),
    disc(18, 0, 4.4), drive(13, 0, 3.4, { m: false }),
    hull([[57, 0], [55, -3.2], [46, -3.6], [40, -2.4], [35, -4.4], [35, 0]]),
    disc(28, 0, 8.4),
    line(arc(28, 0, 7, 200, 340, 12), 0.9, 'liv', { m: false }),
    glass([[56, -1.2], [52, -2], [52, 2], [56, 1.2]]),
  ] },
  W: { name: 'Towline', note: 'a blocky tug hauling a towering refinery', parts: [
    box(4, -9, 32, 18, 'dark', { layer: 'under' }),
    ...[8, 14, 20, 26, 32].map(x => line([[x, -9], [x, 9]], 0.5, 'plate', { m: false, layer: 'under' })),
    pod(14, -5, 7, 4.4, 1), pod(26, -5, 7, 4.4, 1),
    disc(10, 0, 2.6), disc(20, 0, 3), disc(30, 0, 2.2),
    line([[44, 0], [34, 0]], 2.2, 'plate', { m: false, layer: 'under' }),
    hull([[62, 0], [61, -4.2], [55, -6.2], [46, -6.2], [44, -4], [44, 0]]),
    poly([[58, -3], [56, -3.4], [56, 3.4], [58, 3]], 'liv', { m: false }),
    glass([[61, -1.4], [59, -2], [59, 2], [61, 1.4]]),
    drive(44, -4, 2),
  ] },
  X: { name: 'Moonhopper', note: 'an open spaceframe with a pod slung in the middle', parts: [
    line([[10, -4.2], [54, -4.2]], 1.4, 'plate'),
    ...[14, 20, 26, 38, 44, 50].map(x => line([[x, -4.2], [x, 4.2]], 0.7, 'plate', { m: false })),
    pod(44, -6.4, 5.4, 3.2, 1), pod(18, -6.4, 5.4, 3.2, 1),
    pod(32, 0, 18, 6.4, 1.8, { m: false }),
    line([[25, -3.2], [39, -3.2]], 0.6, 'liv'),
    hull([[62, 0], [60, -3.2], [54, -3.8], [52, -2], [52, 0]]),
    glass([[61, -1.2], [58.6, -1.8], [58.6, 1.8], [61, 1.2]]),
    drive(9, -2.6, 1.8), drive(9, -6, 1.6),
  ] },
  Y: { name: 'Skimmer', note: 'a flat hull riding on rows of hover pads', parts: [
    ...[14, 22, 30, 38, 46].map(x => pod(x, -7.4, 5.2, 3.2, 1.2)),
    ...[14, 22, 30, 38, 46].map(x => poly(arc(x, -7.4, 1.4, 0, 360, 10, 0.9), 'glow', { layer: 'top' })),
    hull([[61, 0], [56, -3], [40, -5.2], [14, -5.6], [8, -4.2], [8, 0]]),
    line([[50, -3], [14, -4.4]], 0.7, 'liv'),
    glass([[56, -1.3], [51, -2], [51, 2], [56, 1.3]]),
    drive(8, -2.4, 1.8),
  ] },
};

// The Endurance-style ring: twelve modules on a wheel, four spokes.
const WHEEL = Array.from({ length: 12 }, (_, i) => {
  const a = i * 30, cx = 32 + Math.cos(rad(a)) * 18, cy = Math.sin(rad(a)) * 18;
  return poly(rot([[cx - 3.4, cy - 2.4], [cx + 3.4, cy - 2.4], [cx + 3.4, cy + 2.4], [cx - 3.4, cy + 2.4]], a + 90, cx, cy), i % 3 === 0 ? 'plate2' : 'base', { m: false });
});

export const COLONY_HOMAGE = {
  U: { name: 'Longreach', note: 'a spherical crew head on a long spine', parts: [
    line([[48, 0], [16, 0]], 1.8, 'plate2', { m: false }),
    ...[22, 28, 34, 40].map(x => line([[x, -1.9], [x, 1.9]], 0.8, 'plate', { m: false })),
    pod(12, -5.4, 7, 2.6, 1),
    hull([[18, 0], [16, -4.6], [8, -4.8], [6, -3], [6, 0]]),
    drive(6, 0, 2.6, { m: false }),
    disc(52, 0, 6.6),
    glass([[58.4, -1], [56.8, -1.8], [56.8, 1.8], [58.4, 1]]),
    disc(47, 6.4, 1.8),
  ] },
  V: { name: 'Wheelhouse', note: 'twelve modules on a ring around a docking hub', parts: [
    ...[45, 135, 225, 315].map(a => line([[32, 0], [32 + Math.cos(rad(a)) * 17, Math.sin(rad(a)) * 17]], 1.4, 'plate', { m: false, layer: 'under' })),
    ...WHEEL,
    line(arc(32, 0, 18, 0, 360, 48), 0.6, 'liv', { m: false }),
    pod(42, 0, 7, 2.6, 1, { m: false }),
    disc(32, 0, 4.4, { core: true }),
  ] },
  W: { name: 'Grand Liner', note: 'a smooth pleasure hull lined with windows', parts: [
    hull([[62, 0], [60, -4], [54, -8.2], [40, -10.2], [20, -10.2], [10, -8.4], [6, -4.4], [6, 0]]),
    line([[52, -6.4], [14, -6.4]], 0.8, 'glass'),
    line([[48, -3.2], [16, -3.2]], 0.8, 'glass'),
    poly([[57, -1.2], [48, -2.2], [48, 2.2], [57, 1.2]], 'liv', { m: false }),
    poly(arc(32, 0, 4.2, 0, 360, 24), 'glass', { m: false, op: 0.7 }),
    drive(6, -4.4, 2.4), drive(6, 0, 2.6, { m: false }),
  ] },
  X: { name: 'Shieldbearer', note: 'a heat shield leading a long truss and glowing radiators', parts: [
    wing([[34, -1.6], [48, -1.6], [45, -21], [31, -21]]),
    ...[36, 40, 44].map(x => line([[x, -3], [x - 1.4, -20]], 0.5, 'plate', { layer: 'wings' })),
    line([[48, -1.6], [45, -21], [31, -21]], 0.7, 'glow', { layer: 'wings' }),
    line([[56, 0], [12, 0]], 1.2, 'plate', { m: false }),
    line([[56, 1.4], [50, -1.4], [44, 1.4], [38, -1.4], [32, 1.4], [26, -1.4], [20, 1.4], [14, -1.4]], 0.5, 'plate2', { m: false }),
    pod(26, 0, 10, 4.2, 1.4, { m: false }),
    poly([[59, -15], [63, 0], [59, 15], [54.4, 15], [57.6, 0], [54.4, -15]], 'plate2', { m: false }),
    poly([[59, -15], [63, 0], [59, 15], [60.6, 0]], 'top', { m: false, op: 0.6 }),
    line([[59, -15], [63, 0], [59, 15]], 0.9, 'liv', { m: false }),
    drive(12, -2, 2.2),
  ] },
  Y: { name: 'Two-Deck', note: 'a classic flying saucer with a domed upper deck', parts: [
    drive(12.4, 0, 2.4, { m: false }),
    disc(32, 0, 20),
    line(arc(32, 0, 16, 0, 360, 56), 1.4, 'glow', { m: false }),
    disc(32, 0, 11),
    line(arc(32, 0, 11, 0, 360, 40), 0.7, 'liv', { m: false }),
    poly(arc(32, 0, 5.2, 0, 360, 24), 'glass', { m: false, op: 0.8 }),
  ] },
};
