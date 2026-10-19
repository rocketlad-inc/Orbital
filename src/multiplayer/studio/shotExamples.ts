// Shots the Studio bar offers as starting points. They pair with the
// scenes in worker/studioScene.js (EXAMPLES): the first plays the
// "three-way at Earth, war at Titan" scene end to end.
import type { Shot } from './director';

export const SHOT_EXAMPLES: Record<string, Shot> = {
  earth_then_titan: {
    format: '9:16', fps: 30, seconds: 34, speed: 2500,
    hook: 'Three empires, one planet, and a war at Saturn',
    steps: [
      { at: 0, do: 'focus', target: 'earth', px: 520 },
      { at: 0, do: 'caption', text: 'Earth. Three fleets in orbit.' },
      { at: 0.5, do: 'tick', n: 1 },
      { at: 4, do: 'caption', text: 'Beams, railguns, flak and mines' },
      { at: 4, do: 'tick', n: 1 },
      { at: 8, do: 'tick', n: 1 },
      { at: 11, do: 'caption', text: 'A wing breaks off for the Moon' },
      { at: 11, do: 'zoom', px: 160, ms: 2500 },
      { at: 12, do: 'tick', n: 1 },
      { at: 16, do: 'caption', text: 'Meanwhile, out at Saturn…' },
      { at: 16, do: 'zoom', scale: 0.012, ms: 3000 },
      { at: 19.5, do: 'pan', target: 'titan', ms: 3500, scale: 0.012 },
      { at: 23.5, do: 'zoom', target: 'titan', px: 520, ms: 2500 },
      { at: 26, do: 'caption', text: 'Titan: two more empires at war' },
      { at: 26, do: 'tick', n: 1 },
      { at: 30, do: 'tick', n: 1 },
    ],
  },
  battle_in_orbit: {
    format: '9:16', fps: 30, seconds: 24, speed: 3000,
    hook: 'Space battles here happen in orbit',
    steps: [
      { at: 0, do: 'focus', target: 'earth', px: 560 },
      { at: 0.5, do: 'tick', n: 1 },
      { at: 4, do: 'tick', n: 1 },
      { at: 8, do: 'tick', n: 1 },
      { at: 12, do: 'tick', n: 1 },
      { at: 16, do: 'tick', n: 1 },
      { at: 20, do: 'tick', n: 1 },
    ],
  },
  system_to_dogfight: {
    format: '9:16', fps: 30, seconds: 20, speed: 2500,
    hook: 'The whole solar system is the map',
    steps: [
      { at: 0, do: 'focus', target: 'sol', scale: 0.0045 },
      { at: 0, do: 'caption', text: 'Every colour is an empire' },
      { at: 2, do: 'pan', target: 'earth', ms: 4000, px: 40 },
      { at: 6, do: 'caption', text: 'Zoom in anywhere…' },
      { at: 6.5, do: 'zoom', target: 'earth', px: 520, ms: 3500 },
      { at: 10, do: 'caption', text: '…and someone is fighting over it' },
      { at: 10, do: 'tick', n: 1 },
      { at: 14, do: 'tick', n: 1 },
    ],
  },
};
