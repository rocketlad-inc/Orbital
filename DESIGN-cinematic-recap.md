# DESIGN — Cinematic Battle Recap (3D) + the Reviewer Gauntlet

Status: **shipped to production**, iterating.
Scope: a real-time 3D replay of a recorded battle, rendered in the
browser, reachable from battle analytics and from shared recap links.
It is a **new renderer, not a replacement** — the 2D canvas recap
(`TheatreRecap`) still exists and still ships.

---

## 1. What this is

A battle is already recorded tick by tick (`battle_ticks`,
`battle_shots`, `battle_participants`). The 2D recap plays that back
from above. This plays it back from *inside*: fleets staged as lines of
battle in front of a world, a camera that picks shots out of what
happened, ships that fire, burn and come apart.

Three rules the renderer is built on, each learned the hard way:

- **Stage for camera, keep the record true.** Who was there, who fired
  on whom, and who died is the record and is never altered. Where a hull
  sits inside its own line is staging. Fleets are two lines facing each
  other with the world behind them, because an orbital ring is where the
  ships actually were and the wrong shape for a film.
- **Pick shots, do not orbit.** A camera circling the action is a
  surveillance camera. The shot list is precomputed in one pass over the
  whole record, so each shot knows what it is about before it starts —
  the pair in a duel, the hull about to die, the fleet that just
  arrived. Minimum 15s per take.
- **One place per thing.** Effects live in `fx3d`, hulls in `shipModel`,
  worlds in `planetSphere`. An earlier cut of `BattleStage` grew its own
  copies of all three, and those copies were the versions reviewers
  panned while the good ones sat unused beside them.

Timing constants (`TICK_MS`, `KILL_AT`, `FIREBALL_MS`, `WRECK_MS`) are
deliberately **shared with the 2D recap**, so the two views can never
disagree about when a ship died.

---

## 2. Where the code lives

| File | Responsibility |
|---|---|
| `src/render3d/BattleStage.ts` | Scene, staging, the director, playback. `createStage(detail, canvas)` → `setPos/render/resize/dispose`. |
| `src/render3d/shipModel.ts` | Hull archetypes, hardpoints, hull fragmentation for wrecks. |
| `src/render3d/fx3d.ts` | Billboards, tracers, plumes, blasts, hull material, livery. |
| `src/render3d/planetSphere.ts` | World surfaces: giants, biomes, cratered rock. |
| `src/multiplayer/BattleCinema.tsx` | The player: clock, scrubber, speed, damage/death log. |
| `worker/analytics.js` | `/battles/:id/cinema` and `/api/recap/:token/cinema`. |
| `src/util/lazyChunk.ts` | Keeps the lazy renderer chunk from breaking the page across a deploy. |

### Ships

Five **archetypes**, not one anatomy rescaled: `wedge` (Star Destroyer
dagger), `spinal` (Pelta/Normandy — cylinder core, outrigger nacelles),
`catamaran`, `dreadnought` (Yamato — dorsal turret line, sponsons, bow
gun), `hauler`. Class decides which shapes are plausible; the **variant
letter picks one**, so two corvettes of different variants are different
ships. Proportions run *opposite* to sizes on purpose — a corvette is a
long thin dart, a destroyer a broad slab — because scaling one
silhouette up and down produced a fleet that read as one ship at three
distances.

Class length is the one place size is decided: **corvette 10, frigate
20, destroyer 46, freighter 26, colony 36**. Everything staged —
formation spacing, gap between lines, camera stand-off, effect sizes —
derives from that table rather than being tuned beside it.

### Livery

The plate texture tiles ~5× along a hull, so markings cannot live in it.
Each ship gets a canvas mapped **once** onto a panel per flank, parented
to the hull so it rides arrival, orbit and tumble. The faction lives on
the **trim** (superstructure, turrets, engine housings, cargo) plus a
stripe, pennant number and name — not as a whole-hull tint, which is
invisible when subtle and plastic when strong.

The **hull number is the hero mark**, not the name: measured, a number
still reads at 7px where a name is gone by 5px — roughly one full hull
class further out.

### Wrecks

`hullFragments` cuts a hull by **triangle centroid** along its length,
so every triangle lands in exactly one piece and the union of the pieces
is the original hull — no gaps, no doubled surfaces. Cut faces are left
open, because a warship broken across its spine should show its frames.

### Worlds

Faces come from the **same classifier the 2D map uses**
(`terraformBiome`, exported rather than reimplemented), so a world that
reads as a desert on the map reads as a desert in the film: Io volcanic,
Europa oceanic, Mars arid, Callisto tundra, Ganymede verdant. Giants get
zonal bands and a great storm. Craters are punched **only for bare
rock** — a giant has no surface to crater and a terraformed world has
weather to erase them.

---

## 3. The reviewer gauntlet

The method used throughout, and the reason the thing improved.

### How a round runs

1. **Render an artefact** — a reel (188–225 frames, encoded to animated
   WebP) or a bench sheet (single hulls, hero-lit, product-shot framing).
2. **Spawn 2–3 independent reviewers**, each given a different persona:
   an independent critic, a VFX supervisor, a games-press writer. They
   do not see each other's notes.
3. **Score fixed axes 1–10** with justification — Cinematography,
   Effects, Excitement, Professionalism for reels; Silhouette, Surface
   detail, Materials & paint, Reference fidelity for models.
4. **Rank the top 3–5 defects**, each naming the file it appears in,
   exactly what is wrong, and a concrete fix.
5. **Act on what repeats across reviewers**, not on any single opinion.

### Rules that make it work

- **Reviewers describe; they do not diagnose.** Their best contribution
  is a precise account of what is on screen. Every time a reviewer
  offered a *cause*, it was wrong — "no directional light" (there was a
  2.8 key), "bloom with no ceiling" (the camera was inside the
  fireball), "a far-LOD path" (there is no LOD system). The one time a
  reviewer was asked to *measure and describe* an artifact instead of
  explaining it, the description — per-plate quantised, random
  amplitude, edges landing inboard of the seams — identified a UV
  misalignment in a single reading.
- **Verify every claim before acting on it.** Three rounds running
  reported "per-panel albedo jumping the full 0–100% range". Dumping the
  generated maps to disk showed albedo uniform and roughness a clean
  150–228 checker. The claim was false and there was no way to know from
  outside the shader.
- **The instrument must not exceed the product.** The model bench ran a
  3.2 key and 2.2 rim at exposure 1.0 — hotter than anything a player
  sees — and manufactured blowout that did not exist. It also framed
  every hull to fill the shot, so a corvette and a destroyer rendered
  identically sized, and a reviewer correctly reported that class does
  not read *from renders where class could not possibly read*. **An
  instrument that normalises away the thing you are measuring will
  happily report it missing.**
- **Benches localise what whole scenes hide.** At battle distance a hull
  is forty pixels and any silhouette passes. `__models`, `__sterns`,
  `__worlds`, `__livery` and `__maps` each exist because a defect was
  invisible in the reel.
- **Change one variable at a time.** The flank artifact survived
  controlled tests of lighting, emissive, environment map, normal scale
  and intersecting geometry. Each negative result was worth recording;
  the eventual cause was none of them.
- **Reduce the thing that masks failures.** A `polygonOffset` of −4/−4
  punched buried geometry back out through the hull, so a *placement*
  bug rendered as a floating card. Cutting the bias to −1/−1 is what
  made the remaining errors visible at all.

### Scores

| Subject | Rounds |
|---|---|
| 2D canvas recap | 3.5 → 4.2 → 4.5 → 4.8 → 4.85 → **5.0** (shipped) |
| 3D reel (Mars) | 3.92 → 3.92 → **5.50** |
| 3D reel (Juno) | **5.83** |
| Ship models | 2.25 → 3.0 → 4.75 → 3.75 → 4.25 |
| Livery clarity | 2.5 → 6.0 → 5.5 |

Round-to-round movement includes real reviewer variance. Weight findings
that repeat across reviewers and rounds over any single score.

---

## 4. The recurring bug class

Nearly every defect that survived more than one round was a
**measurement error**, not a shading or design problem. Worth reading
before touching this code:

- `slab()` is a `CylinderGeometry`, whose radius runs to the **vertex,
  not the face**. A hull declaring beam `B` reaches `B·√½`. Every hull
  understated itself by 29%.
- `BufferGeometry.translate()/scale()` update `boundingBox` **in place**,
  so extents read afterwards are already normalised — scaling them again
  shrinks by a second factor of hull length.
- Measuring the envelope off the **whole merged mesh** includes towers
  and masts, so "half height" lands well above the plating.
- **Maximum beam applied where the hull is narrow** lifts a band off the
  prow taper.
- Four maps got **four different UV offsets**, because the offset was
  drawn inside a per-map clone helper.
- Effects are **sized in world units against a scene whose scale keeps
  changing**. When Mars went 4× and the camera moved out, plumes, blasts
  and bolts each needed rechecking; each was caught a round late.

Symptoms of these looked like art problems — floating decals, flat
plumes, bolts with no origin, white rectangles on the flank. They were
arithmetic.

---

## 5. Open work

- Markings are screen-aligned quads, not projected decals: they do not
  foreshorten across a curved hull (the spinal archetype in particular).
- No distance LOD on markings — at corvette scale the name degenerates
  into a bar that reads as an unintended stripe.
- Corvette silhouettes are weak; catamarans still miss the Pelta read
  (full-length spars rather than short pods on pylons).
- Giants' band edges are softer than reference; no ring geometry.
- Theatre-scoped cinema (multi-battle campaign reel) — the payload shape
  already supports it; only battle scope is wired.
- Models last measured 4.25, reel 5.83. Neither has been re-scored since
  the livery, wreck-breakup, world-face and VFX work landed.
