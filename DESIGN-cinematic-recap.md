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
| 3D reel — **feature-bar series**, target 8 | **3.33** (R1) |

Round-to-round movement includes real reviewer variance. Weight findings
that repeat across reviewers and rounds over any single score.

#### The feature-bar series is a RECALIBRATION, not a regression

R1 of this series scored 3.33 (3 / 4 / 3) against 5.50 for the same
subject earlier. Nothing got worse. The rubric changed: reviewers were
given an explicit anchored scale — 5 = competent amateur, 7 = good
indie/TV, **8 = convincingly professional feature work**, 10 =
reference-class — and told to judge against the Battle of Coruscant. The
old rounds had no anchored scale. Do not compare across the two series;
compare only within this one.

#### R1 findings that ALL THREE reviewers reported

Ranked by how much frame area the defect covers, which is the tiebreak
when reviewers disagree on ordering:

1. **The planet reads as a flat coloured disc** at 40–45% of nearly every
   frame — "soft blur of brown smears", "no sharp feature anywhere in 24
   frames", edge meets space as a hard cut with no haze or thinning. The
   VFX supervisor made this the sole release blocker.
2. **One camera, one distance, ~24 times.** The limb sits as a near-vertical
   arc through frame centre in 16–18 of 24 cells; subject scale never
   changes; cells #0, #3, #8, #10, #12, #13 are near-empty plates.
3. **Explosions are one soft radially-symmetric disc plus one 4-point star
   flare, rescaled** — no core, no shell, no smoke, no thrown debris, no
   asymmetry, no per-instance variation.
4. **Weapon fire is uniform-width hard-edged line work** — parallel, evenly
   spaced, no muzzle flash at the origin, no impact at the terminus,
   several bolts simply stop in empty space.
5. **Light does not travel between objects.** Blasts and flares sit beside
   hulls without warming them; the six kill lights are the only
   interactive light in the reel.
6. **Flat untextured slabs, planks and cubes at hero scale** (#10, #11,
   #21, #22, #23) — single-value faces, mathematically straight edges.
7. **Everything is uniformly razor sharp** regardless of speed or distance:
   no motion streak, no depth cueing, so near and far collapse into one
   plane and scale dies.

Protect these — all three named them unprompted: the warm-planet-against-navy
palette; dark hulls silhouetted across the lit limb (#4, #7, #9, #16); the
GOLD TAPERED tracers (all three called them the model the rest of the fire
should copy); the capital-ship silhouette language; and hero-6's value
structure (near-black planet, thin rim, warm plumes), which the VFX
supervisor called the most cinematic image in the set.

**The one genuine conflict, and its resolution.** On the on-hull numerals
("170 DAGGER"), the critic said delete them as the single most
disqualifying detail, while the games-press reviewer said they are the
ONLY ownership cue in the reel and it works. Both are right about
different things, so the fix is neither: keep the ownership read, restyle
it as physical paint — small, weathered, dimmer, broken by panel edges,
foreshortened onto the hull curvature. Same for the dark-planet
disagreement (standardise on it vs. it ruins the climax): it is a good
SHOT and a bad ENDING, so use it as variety and keep the climax lit.

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

Five more from the feature-bar series, all caught by measurement rather
than by looking:

- **`onBeforeCompile` runs BEFORE includes are resolved**
  (WebGLRenderer.js:1645). At that point the source still says
  `#include <normal_fragment_maps>`, so matching text from inside the
  chunk finds nothing — and `String.replace` fails **silently**. The first
  detail-map build compiled clean, rendered clean, and changed nothing.
  Caught only because the sharpness ratio came back at exactly 1.00.
  Anchor on the include directive, and assert the anchor exists.
- **A uniform added to `shader.uniforms` but not declared in GLSL** is a
  compile error that renders the whole frame black rather than throwing.
  `uDetailAO` did this; mean luminance dropped 85 → 4.
- **Tiling noise needs each octave indexed modulo ITS OWN frequency.** One
  shared lattice period of 32 with octaves at 4/8/16/32 is not seamless:
  at u=1 an octave of frequency f lands on lattice cell f, which only
  wraps to 0 if f is a multiple of the period. The seams drew a dark
  perpendicular grid across the planet — and I first misread that grid as
  "pre-existing tracers" and nearly dismissed it. Magnify before deciding.
- **Sampling the reel on integer beats measures the deadest instant of
  every beat.** Fire ramps in at ~0.05, peaks at ~0.40, and is gone by
  ~0.70, so an integer-sampled contact sheet shows zero gunfire and a
  reviewer would correctly report a battle with no weapons in it. Sample
  on the peak. (The corollary is a real product defect: the last ~30% of
  every beat — about 660ms at TICK_MS 2200 — is dead air.)
- **A "planet width" scan that spans the leftmost to rightmost warm pixel
  crosses black gaps and measures the planet plus a ship.** Use the
  largest contiguous run. The bogus version reported 2265px and nearly
  became the basis of a whole conclusion.

The planet fix itself came out of arithmetic, not taste: `ANCHOR_R = 120`
puts 1024 texels over a 754-unit circumference (1.36 texels/unit) while
cinema framing gives ~7.6 screen px/unit — **≈5.6 screen pixels per
texel**. Reaching 1:1 would need a map ~5700px wide, or 33M pixels across
three maps, which is not available in a browser. So detail is decoupled
from map size instead: one shared 512² tiling detail normal at a repeat
that scales with body radius, plus slope-driven albedo breakup, because
the base albedo has literally no content finer than ~45 screen px and
normal perturbation alone vanishes wherever the star is near head-on.
Measured result on the same frame and patch: high-frequency energy
0.743 → 1.071 (**×1.44**) with mean luminance held (85.1 → 82.3).

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

### Feature-bar series: what R1 asked for and what is done

Done in R2 (planet, the unanimous blocker):

- Tiling detail normal + slope albedo breakup, resolution-independent.
- Atmosphere rebuilt: thicker shell, two-lobe falloff so the haze has
  width, soft terminator carried onto the night side, forward scattering.
  The old shell peaked at alpha 0.17 with a pow-5.5 falloff — faint and
  only a few pixels wide, which is why three reviewers called the edge a
  hard cut.
- `STAR_DIR` collapsed to one exported constant. The key light and the
  atmosphere shell each had their own copy and they disagreed
  (−1, 0.42, 0.72 against −1, 0.4, 0.7).

Still outstanding from the R1 unanimous list, in the order the reviewers
would fix them:

1. **Camera.** A real cut list: genuinely different subject scales, at
   least one hull cropped by the frame edge, at least one true wide, and
   no beat framed with nothing above ~8% of frame.
2. **Weapon fire.** Make every bolt look like the gold tapered ones —
   bright head, falloff, muzzle flash at the origin, impact at the
   terminus, and break the parallel/even-spacing pattern.
3. **Explosions.** Per-instance seeded shape, hot asymmetric core,
   expanding shell, smoke/ember remnant, thrown debris.
4. **Interactive light for every blast**, not just the six kill lights.
5. **Depth cueing** — motion streak on fast elements, and haze or DOF so
   near and far separate.
6. **Dress or remove the flat slabs/planks/cubes** at hero scale.
7. **Restyle livery as physical paint** (see the conflict resolution in §3).
8. **The dead 30% at the tail of every beat** (see §4).
