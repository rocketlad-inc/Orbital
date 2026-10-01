// ============================================================================
// _emblemMasks.js — GENERATED. Do not hand-edit.
//
// 1-bit alpha masks of the faction emblems, 24x24, packed row-major
// (MSB first) and base64'd. ~72 bytes each.
//
// WHY THIS EXISTS
//   The emblem artwork is React SVG. The Herald PNG renderer is a
//   hand-rolled pixel surface with a bitmap font — no canvas, no font
//   engine, no SVG rasteriser — so it cannot draw the real artwork, and
//   this project has no sharp/resvg/canvas dependency to add one.
//
//   So the shapes are baked once from the SAME SVGs every other surface
//   draws, and BOTH Herald renderers (the HTML page canvas and the PNG
//   pixel surface) stamp from this one table. That is deliberate:
//   heraldStrip.js already notes that keeping the two renderers
//   geometrically identical is what stops them drifting into different
//   charts, and a shared mask means an emblem cannot look like one thing
//   in the page and another in the image.
//
// REGENERATING — only needed if emblem ARTWORK changes:
//   see scripts/README-emblem-masks.md
//
// A missing id is not an error: callers fall back to the empire name,
// which is what shipped before emblems existed.
// ============================================================================

export const EMBLEM_MASK_SIZE = 24;

export const EMBLEM_MASKS = {
  anchor: 'AAAAABgAADwAAH4AAH4AADwAABgAAf+AA//AA//AABgAABgAABgAEBgIOBgcOBgcGBgYHBg4DhhwB5ngA//AAf+AABgAAAAA',
  atom: 'AAAAAAAAA8PAB+fgBjxgBhhgBjxgB//gD//wP9v8c73OY//GY//Gc73OP9v8D//wB//gBjxgBhhgBjxgB+fgA8PAAAAAAAAA',
  comet: 'AAAAAAAAAAAAAAPgAAfwAA/4AA/4AA/4AA/4AA/4AAfwAHvgA/AAB+AAB8AAD4AADwAADgAADAAAGAAAEAAAAAAAAAAAAAAA',
  compass: 'AAAAAAAAABgAABgAABgAABgAAT2AAL0AADwAAAAAA73AP738P738A73AAAAAADwAAL0AAT2AABgAABgAABgAABgAAAAAAAAA',
  crown: 'AAAAAAAAAAAAAAgAAAwAABwAAB4AID4COD8GPH8ePn++P//+P//+P//8P//8P//8P//8P//8AAAAAAAAAAAAAAAAAAAAAAAA',
  doublev: 'AAAAAAAAfMM+POc8PmZ8Hn54Hzz4DzzwD73wB5ngB9vgA8PAA+fAAeeAAP8AAP8AAH4AAH4AADwAADwAABgAABgAAAAAAAAA',
  dragon: 'AAAAAAAAACAAAHAAAPAAAP4AAP/AAf/wA//4B/+AD//AD//gD/4AD/4AD/4AD/wAB/gAA/AAAAAAAAAAAAAAAAAAAAAAAAAA',
  eye: 'AAAAAAAAAAAAAAAAAAAAADwAAf+AA//AB//gD//wH//4P//8P//8H//4D//wB//gA//AAf+AADwAAAAAAAAAAAAAAAAAAAAA',
  galaxy: 'AAAAAAAAAAAAAAAAAAeAAAfAAA/gAA/wAA/4ADw4AH4YAH4IEH4AGH4AHDwAH/AAD/AAB/AAA+AAAeAAAAAAAAAAAAAAAAAA',
  gear: 'AAAAADwAADwABDwgDjxwHzz4D//wB//gA//AA//Af//+f//+f//+f//+A//AA//AB//gD//wHzz4DjxwBDwgADwAADwAAAAA',
  hammer: 'AAAAAAAAAAAAH//4H//4H//4H//4H//4H//4D//wADwAADwAADwAADwAADwAADwAADwAADwAADwAADwAADwAADwAADwAAAAA',
  helix: 'AgBAAwDAAwDAA4HAAYGAAcOAAOcAAH4AADwAADwAAH4AAOcAAcOAAYGAA4HAAwDAAwDABwDgBwDgBwDgAwDAA4HAAYGAAIEA',
  hourglass: 'AAAAB//gD//wD//wB//gBgBgBv9gA37AA37AAb2AAcOAAOcAAOcAAcOAAYGAAzzAA37ABn5gBv9gB//gD//wD//wB//gAAAA',
  key: 'AAAAD+AAH/AAP/gAfDwAeBwAcBwAcBwAcBwAeBwAfDwAP/gAH/gAD/gAADgAADgAAD/AAD/AADgAADgAAD/gAD/gAD/gAAAA',
  kraken: 'AAAAAAAAAAAAAH4AAP8AAf+AA//AA//AA//AA//AA//AA//AAAAAAmZAA2bAB37gDmZwHGY4AMMAAMMAAYGAAAAAAAAAAAAA',
  leaf: 'AAAAAAAAAABwAAfgAD+AAH4AAfwAA/AAB+AAB8AAD4AADwAAHgAAHgAAHAAAPAAAOAAAOAAAOAAAMAAAEAAAAAAAAAAAAAAA',
  moon: 'AAAAAAAAADwAAf4AA/wAB/wAD/gAH/AAH/AAH/AAP/AAP+AAP+AAP/AAH/AAH/AAH/AAD/gAB/wAA/wAAf4AADwAAAAAAAAA',
  mountain: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAMAAAOAAAeCAAfGAA/HAA/vAB//gB//gD//wD//wH//4H//4P//8P//8AAAAAAAAAAAA',
  nova: 'AAAAAAAAAAAAABgAABgABhhgBxjgA73AATyAAH4AAcOAH8N4H8N4AcOAAH4AATyAA73ABxjgBhhgABgAABgAAAAAAAAAAAAA',
  orbit: 'AAAAAAAAAAAAAAAAAAAAAAP4AB/8AHwOAfgGA/4OD34MHP8cOP84MH7wcH/AYB+AcD4AP/gAH8AAAAAAAAAAAAAAAAAAAAAA',
  phoenix: 'AAAAAAAAABgAABgAADwAMDwMHn54H//4D//wB//gB//gB//gD//wP//8f//+D//wAP8AAP8AAeeAAcOAAYGAAgBAAAAAAAAA',
  pyramid: 'AAAAAAAAAAAAABgAABgAADwAAH4AAH4AAP8AAP8AAf+AAf+AA//AB//gB//gD//wD//wH//4P//4P//8f//+f//+AAAAAAAA',
  raven: 'AAAAAAAAAAAAAAAAAAAAAB+AAH/gAP/4Af/gAf/AAf/AA//AA//AA/+AA/8AA/8AA/4AA+4AAY4ABg4ADgQAAAAAAAAAAAAA',
  ring: 'AAAAAAAAAAAAAAAAAAAAAAAAP5gAf/4A4f8AYf+Acf/gP//4H//8B/+OAf+GAP+HAH/+ABn8AAAAAAAAAAAAAAAAAAAAAAAA',
  rocket: 'AAAAABgAABgAADwAAH4AAH4AAP8AAP8AAP8AAP8AAP8AAf+AAf+AA//AA//AB//gBgBgDH8wAH4AAH4AABgAABgAAAAAAAAA',
  serpent: 'AAAAAAAAAAAAAIAAAYAAA4AAA4AAAeAAAfAAAfP4Aff4AffgA+fAB+fgD8fgD4fgH4fAH5/AD7+AB/4AAgAAAAAAAAAAAAAA',
  shield: 'AAAAAAAAAH4AAf+AB//gH//4H//4H//4H//4H//4H//4H//4H//4H//4H//4H//4D//wD//wB//gA//AAf+AAH4AAAAAAAAA',
  skull: 'AAAAABgAAP8AA//AB//gD//wD//wH//4H//4H//4H//4H//4H//4D//wD//wB//gA//AAf+AAf+AAf+AAf+AAAAAAAAAAAAA',
  spear: 'AAAAABgAABgAADwAAHwAAH4AAP8AAP8AATyAADwAADwAADwAADwAADwAADwAADwAADwAADwAADwAADwAADwAADwAADwAAAAA',
  star: 'AAAAAAAAAAAAABgAABgAADwAADwAADwAAH4AH//4P//8D//wB//gA//AAf+AAf+AAf+AA//AA8PAA4HAAgBAAAAAAAAAAAAA',
  sun: 'AAAAABgAABgAABgADBgwDgBwBgBgAH4AAP8AAf+AAf+Aef+eef+eAf+AAf+AAP8AAH4ABgBgDgBwDBgwABgAABgAABgAAAAA',
  swords: 'AAAAAAAAAAAAMAAMOAAcPAA8HgB4DwDwBwDgA4HAAcOAAeeAAP8AAH4AAL0AAf+AAf+AAH4AAMcAAeeAA8PAA4HAAQCAAAAA',
  tower: 'AAAAAAAAA//AA//AA//AA//AA//AAf+AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAAAA',
  trident: 'AAAAAAAAAAAADAAwDBgwDBgwDBgwDBgwDBgwDBgwDBgwDhhwDhhgBxjgA9vAAf+AAP4AABgAABgAABgAABgAABgAABgAAAAA',
  wave: 'AAAAAAAAAAAAAAAAAAAAAAAADwAAH4AAP8AAPwAQHAA4CAD8AAP8AAH4DwDwP8AAP+AAHgAYCAB8AAf8AAP8AADwAAAAAAAA',
  wolf: 'AAAAAAAAAAAAAAAAAAAAEAAIGAAYHAAwD//wD//wD//wD//wD//wH//4H//4H//4A//AAP8AAP8AAGYAAEIAAAAAAAAAAAAA',
};

/**
 * Walk a mask's set pixels. Callers draw them however their surface
 * wants — fillRect on a canvas, direct pixel writes on the raster — so
 * this module carries no drawing dependency of its own.
 *
 * @param {string} id  emblem id
 * @param {(mx:number,my:number)=>void} plot  called per SET pixel, mask space
 * @returns {boolean} false when the id has no mask (caller should fall back)
 */
export function forEachMaskPixel(id, plot) {
  const b64 = EMBLEM_MASKS[id];
  if (!b64) return false;
  const bin = atob(b64);
  const N = EMBLEM_MASK_SIZE;
  for (let i = 0; i < N * N; i++) {
    const byte = bin.charCodeAt(i >> 3);
    if ((byte >> (7 - (i & 7))) & 1) plot(i % N, (i / N) | 0);
  }
  return true;
}
