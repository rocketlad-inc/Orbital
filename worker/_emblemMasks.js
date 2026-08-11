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
  anchor: 'AAAAABgAADwAAH4AAH4AADwAABgAAf+AA//AA//AABgAABgAABgAEBgIOBgcGBgYGBgYHBg4DhhwB5ngA//AAf+AAAgAAAAA',
  comet: 'AAAAAAAAAAAAAAPgAAfwAA/4AA/4AA/4AA/4AA/4AAfwADvgA/AAB+AAB8AAD4AADwAADgAADAAAGAAAEAAAAAAAAAAAAAAA',
  crown: 'AAAAAAAAAAAAAAAAAAwAABwAAB4AMD4COD8GPH8eP3++P//+P//+P//8P//8P//8P//8P//8AAAAAAAAAAAAAAAAAAAAAAAA',
  doublev: 'AAAAAAAAfMM+fOc+PmZ8Hn54Hzz4DzzwD5nwB5ngB9vgA8PAA+fAAf+AAf+AAP8AAH4AAH4AADwAADwAABgAABgAAAAAAAAA',
  eye: 'AAAAAAAAAAAAAAAAAAAAADwAAf+AA//AB//gH//4H//4P//8P//8H//4H//4B//gA//AAf+AADwAAAAAAAAAAAAAAAAAAAAA',
  gear: 'AAAAADwAADwADDwwHjx4Hzz4D//wB//gA//AA//Af//+f//+f//+f//+A//AA//AB//gD//wHzz4Hjx4DDwwADwAADwAAAAA',
  hammer: 'AAAAAAAAAAAAH//4H//4H//4H//4H//4H//4D//wADwAADwAADwAADwAADwAADwAADwAADwAADwAADwAADwAADwAADwAAAAA',
  helix: 'AgBAAwDAAwDAA4HAA4HAAcOAAOcAAH4AADwAADwAAH4AAOcAAcOAA4HAA4HAAwDABwDABwDgBwDgBwDgAwDAA4HAAYGAAIEA',
  key: 'AAAAD+AAH/AAP/gAeDwAcBwAcBwAcBwAcBwAcBwAeDwAP/gAH/gAD/gAADgAADgAAD/AAD/AADgAADgAAD/gAD/gAD/gAAAA',
  leaf: 'AAAAAAAAAADwAAfgAD+AAH4AAfwAA/AAB+AAB8AAD4AADwAAHgAAHgAAHAAAPAAAOAAAOAAAMAAAMAAAEAAAAAAAAAAAAAAA',
  moon: 'AAAAAAAAADwAAf4AA/wAB/wAD/gAH/AAH/AAP/AAP/AAP+AAP+AAP+AAH/AAH/AAH/AAD/gAB/wAA/wAAf4AADwAAAAAAAAA',
  mountain: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAMAAAOAAAeCAAfGAA/HAA/vAB//gB//gD//wD//wH//4H//4P//8P//8AAAAAAAAAAAA',
  orbit: 'AAAAAAAAAAAAAAAAAAAAAAP4AB/8AHwOAfwGA/4OD/8MHP8YGP84MP/wcH/AYD+AcD4AP/gAH8AAAAAAAAAAAAAAAAAAAAAA',
  phoenix: 'AAAAAAAAABgAABgAADwAMDwMHn54H//4D//wB//gB//gA//AD//wP//8f//+B//gAP8AAf8AAe+AAcOAA4GAAgDAAAAAAAAA',
  pyramid: 'AAAAAAAAAAAAABgAABgAADwAAH4AAH4AAP8AAP8AAf+AAf+AA//AB//gB//gD//wD//wH//4P//4P//8f//+f//+AAAAAAAA',
  ring: 'AAAAAAAAAAAAAAAAAAAAAAAAP5gAf/4Awf8AYf+Acf/gP//4H//8B/+OAf+GAP+DAH/+ABn8AAAAAAAAAAAAAAAAAAAAAAAA',
  rocket: 'AAAAABgAABgAADwAAH4AAH4AAP8AAP8AAP8AAP8AAP8AAf+AAf+AA//AA//AB//gBgBgCH8QEH4IAH4AABgAABgAAAAAAAAA',
  shield: 'AAAAAAAAAH4AAf+AB//gH//4H//4H//4H//4H//4H//4H//4H//4H//4H//4D//wD//wD//wB//gA//AAP8AAH4AAAAAAAAA',
  skull: 'AAAAABAAAP8AA//AB//gB//wD//wD//4H//4H//4H//4H//4H//4D//wD//wB//gA//AAf+AAf+AAf+AAf+AAAAAAAAAAAAA',
  spear: 'AAAAABgAABgAADwAAH4AAH4AAP8AAP8AATyAADwAADwAADwAADwAADwAADwAADwAADwAADwAADwAADwAADwAADwAADwAAAAA',
  star: 'AAAAAAAAAAAAABgAABgAADwAADwAADwAAH4AD//4P//8D//wB//gA//AAf+AAf+AAf+AA//AA8PAA4HABgBAAAAAAAAAAAAA',
  sun: 'AAAAABgAABgACBgQHBg4DgBwBwDgAn5AAP8AAf+AAf+Aef+eef+eAf+AAf+AAP8AAn5ABwDgDgBwHBg4CBgQABgAABgAAAAA',
  tower: 'AAAAAAAAA//AA//AA//AA//AA//AAf+AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAAAA',
  trident: 'AAAAAAAAAAAADAAwDBgwDBgwDBgwDBgwDBgwDBgwDBgwDhhwBhhgBxjgA9vAAf+AAP8AABgAABgAABgAABgAABgAABgAAAAA',
  wave: 'AAAAAAAAAAAAAAAAAAAAAAAADgAAH4AAP8AAP6AQHAA4CAX8AAP8AAH4D4BwH8AAP+AAPgA4HAB8AAf8AAP4AAHwAAAAAAAA',
  wolf: 'AAAAAAAAAAAAAAAAAAAAEAAIGAAYDAA4D//wD//wD//wD//wD//wH//4H//8H//wA//AAP8AAP8AAGcAAEIAAAAAAAAAAAAA',
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
