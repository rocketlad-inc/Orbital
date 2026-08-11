# Regenerating `worker/_emblemMasks.js`

`worker/_emblemMasks.js` holds 1-bit 24×24 masks of the faction emblems.
The Herald draws from it in two places — the PNG's pixel surface and the
HTML page's canvas — so both renderers stamp identical shapes.

## When you need to regenerate

**Only when the emblem ARTWORK changes** — i.e. you edit a glyph in
`src/components/FactionEmblem.tsx`, or add a new emblem id *with* art.

You do **not** need to regenerate for anything else. A missing mask is
not an error: `heraldStrip.js` falls back to printing the empire's name,
which is exactly what shipped before emblems existed. So a new emblem
that hasn't been baked yet degrades to the old behaviour rather than
breaking the Herald.

## Why this isn't an npm script

Baking the masks means rasterising SVG, and there is no rasteriser
available to do it in Node: the project has no `sharp`, `resvg` or
`canvas` dependency, and Cloudflare Workers have no canvas either. The
only rasteriser in the stack is a browser.

Adding a raster dependency purely to automate this was judged not worth
it — the artwork changes rarely, the data is ~2KB, and the fallback is
safe. If that calculus changes, `@resvg/resvg-js` would make this a
normal build step.

## How to regenerate

1. Build the app so `build/` is current, and serve it:

   ```bash
   npm run build
   ```

2. Create `src/__maskGen.tsx`:

   ```tsx
   import { getEmblemImage } from './render/emblemCache';
   import { EMBLEM_IDS } from './game/emblems';

   const MASK = 24;
   (window as any).__genMasks = async () => {
     for (const id of EMBLEM_IDS) getEmblemImage(id, '#ffffff');
     await new Promise(r => setTimeout(r, 1200));
     const out: Record<string, string> = {};
     for (const id of EMBLEM_IDS) {
       const img = getEmblemImage(id, '#ffffff');
       if (!img) continue;
       const cv = document.createElement('canvas');
       cv.width = MASK; cv.height = MASK;
       const c = cv.getContext('2d')!;
       c.drawImage(img, 0, 0, MASK, MASK);
       const d = c.getImageData(0, 0, MASK, MASK).data;
       const bytes: number[] = [];
       let cur = 0, n = 0;
       for (let i = 0; i < MASK * MASK; i++) {
         cur = (cur << 1) | (d[i * 4 + 3] > 110 ? 1 : 0); n++;
         if (n === 8) { bytes.push(cur); cur = 0; n = 0; }
       }
       if (n) { cur <<= (8 - n); bytes.push(cur); }
       out[id] = btoa(String.fromCharCode(...bytes));
     }
     return out;
   };
   ```

3. Bundle it into the served tree and run it in a browser:

   ```bash
   npx esbuild src/__maskGen.tsx --bundle --outfile=build/__mg/g.js --format=iife --define:process.env.NODE_ENV='"production"'
   ```

   Load the app, then in the console:

   ```js
   await (await fetch('/__mg/g.js')).text().then(s => (0, eval)(s));
   copy(JSON.stringify(await window.__genMasks()));
   ```

4. Paste that JSON into the `EMBLEM_MASKS` object in
   `worker/_emblemMasks.js`, keeping the file's header comment and the
   `forEachMaskPixel` helper below it.

5. Delete `src/__maskGen.tsx` and `build/__mg/`.

## Checking the result

Every mask should have ink. A blank one means the threshold (alpha > 110)
missed a glyph drawn entirely with strokes — check that
`emblemSvgElement` is still setting `style.color`, since stroke-only
glyphs (`orbit`, `ring`, `helix`, `key`) rasterise transparent without it.

`sim/heraldStripEmblems.mjs` renders the strip with and without emblems
and asserts the images differ, which catches an all-blank table.
