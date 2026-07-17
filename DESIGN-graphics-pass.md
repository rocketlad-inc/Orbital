# DESIGN — Graphics & UI Pass ("Make It Pop")

Status: **approved, build everything** (Lorne, 2026-07-17).
Scope: every visual element of the map renderer + canvas-adjacent UI glue.
Prime directive unchanged: **never at the expense of speed.** Canvas2D,
cached offscreen rasters, seeded determinism, zero per-frame allocation
storms. Every new animation must be gated by the existing LOD thresholds
so zoomed-out perf is untouched.

## Global implementation rules

- **LOD gates (existing, reuse):** body screen radius <3.5px = dot,
  3.5–8 legacy, >8 textured, >40 iso structures. Ship flames fade in
  across camera scale 1.2–2.5 (`thrustVisibility`). New FX must pick the
  gate that matches their read-distance; nothing animates at full-system
  zoom except tracers/explosions (combat must always be visible).
- **Glow = additive.** `globalCompositeOperation: 'lighter'` inside a
  save/restore, never layered translucent white.
- **Time base:** use `ctx.t` (sim tick, works when paused-rendering) for
  world animation and `ctx.nowMs ?? performance.now()` for pure-cosmetic
  flicker, matching the damage-flash pattern.
- **Determinism:** anything scattered/random uses the hashStr→mulberry32
  pattern keyed on a stable id, so all clients render identically.
- **No new images.** Everything is vector/gradient, rasterized to
  offscreen canvases where reused (planet textures, ship icons pattern).
- **State for FX** (tracer endpoints, deaths, arrivals) comes from diffs
  the client already computes (damageFlashStart machinery) — extend that
  Map pattern; do NOT add server round-trips for cosmetics.

---

## Workstream A — SHIPS

1. **Filled, shaded hulls** (ShipIcons.tsx SVG wrapper): solid primary
   fill on the hull child; keel shade — a darkened bottom-half overlay
   (clipPath or second path at `darken(primary, .6)`, 40% opacity);
   1px bright dorsal line along the top edge (`lighten(primary, 1.3)`).
   Details stay secondary-colored (two-tone livery unchanged).
2. **Always-on engine glow:** small warm radial dot at the engine bell
   (icons face +x; bell ≈ x=4..6, y=16) baked into the icon raster at
   30% intensity; the live thrust flame still layers on during burns.
3. **Size hierarchy** (mapRenderer ship draws): rest sizes corvette 14,
   frigate 17, freighter 16, colony 16, destroyer 22 (+4 when selected).
4. **Banking on heading change:** track last heading per ship id in a
   module-level Map; render rotation = heading + clamp(Δheading × 3,
   ±0.14 rad) decaying 15%/frame. No allocation — reuse the Map.
5. **State dressing:** retreating → thin fading wake line astern (12px,
   secondary color, 35% alpha); stance hold → icon at 80% alpha;
   rank ≥5 → 2px gold chevron above the icon (skip when <1.2 camera
   scale so far zoom stays clean).

## Workstream B — COMBAT & EVENT FX

1. **Tracer fire** (the headliner): ships in combat exchange 2px additive
   tracer lines on their volley cadence. Client detects volleys the same
   way damage flashes are detected (hp deltas per tick on hostile pairs
   at one body); store `{fromShipId, toId, startMs}` in a rolling array
   (cap 64). Draw: line from attacker to target, bright head dot, 140ms
   life, primary color of the shooter. ALWAYS visible at any zoom.
2. **Detonator blast:** on ship_detonated event (chronicle already
   polled): white core flash → expanding shockwave ring (to ~48px) →
   6 debris sparks (deterministic angles from ship id) flying out over
   500ms. Replaces the generic damage flash for this event.
3. **Ship death debris:** extend the existing destruction flash with
   4–6 1–2px sparks on seeded angles, 400ms fade.
4. **Arrival flash:** ship arrives at a body (transit → orbit diff) →
   one expanding soft ring at the ship in the OWNER's primary at 30%
   alpha, 350ms. Friendly, not alarming.
5. **Asteroid ram heat-shimmer:** second draw of the rock at +0.5px
   seeded jitter, 30% alpha, only while ram is active.

## Workstream C — WORLDS (planets, sun, macro backdrop)

1. **Atmosphere rim-light:** additive 2px arc on the sun-facing limb for
   textured bodies (>8px). Color by type: terrestrial #9fd4ff, Mars-like
   rust #ffb08a, gas giant #ffe9c4, ice giant #bfe6ff. Use
   `lightDirToBody` (exists) for the arc center angle; 90° sweep,
   radial-gradient stroke.
2. **Cloud drift on terrestrials:** second sparse cloud layer painted
   into a SEPARATE cached 256² canvas per terrestrial (only ones that
   cross the 8px gate; reuse planetTexture cache pattern + cap), scrolled
   at 0.3× the gas-band drift rate, 45% alpha.
3. **Gas-giant rings with occlusion:** ring ellipse split at the planet
   horizon — draw back arc, planet disk, front arc; soft shadow segment
   where the ring passes behind the terminator. Saturn (and any body
   with `ring: true` in catalog… if no flag exists, key on template ids
   saturn/uranus) gets it at >8px screen radius.
4. **Sun corona shimmer:** two cached radial-gradient layers rotating at
   different slow rates (0.001 and -0.0016 rad/tick), additive, replacing
   the static outer glow. Keep the core as-is.
5. **Two-layer parallax starfield:** split existing field into far
   (0.2× camera translation) and near (0.5×); near layer slightly
   larger/brighter stars. Both remain precomputed point arrays.
6. **System nebulae:** one big cached radial-gradient wash behind each
   far system (Sol none, Centauri warm amber, Cygnus X violet), drawn
   before the starfield at 8% alpha. Cached full-size offscreen per
   system, redrawn only on resize.
7. **Belt dust twinkle:** existing BeltDustParticle gets brightness
   modulation `0.75 + 0.25*sin(nowMs/900 + seed)` — no new particles.

## Workstream D — ORBITS, TRAJECTORIES, TERRITORY

1. **Orbit relevance fading:** selected body's orbit + its siblings
   (same parent) at full alpha; all other orbit rings at 30%; moon
   orbits hidden entirely when parent body screen radius < 12px.
2. **Own-trajectory dash crawl:** player's own transfer lines get
   `lineDashOffset` animated toward the destination (~24px/s wall
   clock). Enemy/neutral lines stay static.
3. **Arrival tick-marks:** small perpendicular notches on the player's
   selected ship's trajectory every 10 ticks of flight time (samples
   already exist) + a slightly larger notch at flip point.
4. **Gradient trajectories:** all transfer lines fade from 85% alpha at
   the ship to 15% at the destination (createLinearGradient per line —
   acceptable, lines are few; skip gradient below camera scale 0.5 and
   use flat 40% alpha instead).
5. **Territory halos at far zoom:** when camera scale < 0.8, replace the
   barber-pole ownership ring with a soft faction-primary radial halo
   under the body (cached gradient, 18% alpha, radius ≈ body pixel
   radius + 10). Barber-pole ring stays at close zoom (≥0.8). Hysteresis
   ±10% so it doesn't flicker at the boundary.

## Workstream E — CITIES, STATIONS, CAMERA & SELECTION (UI glue)

1. **Station beacon blink:** the two-tone beacon dot pulses 0.5Hz
   (alpha 0.4→1.0 sine), secondary color. Iso structures AND flat
   diamond marker.
2. **Weld sparks while building:** 2–3 flickering 1px additive sparks
   inside the shipyard scaffold, 3–4 flashes/sec, seeded positions,
   only when buildInFlight (already threaded).
3. **Night-window flicker:** in drawNightLights, ~10% of dots (seeded)
   modulate alpha with slow independent sines. No extra dots.
4. **Population growth pulse:** pop increase diff → one soft green
   expanding pulse over the city (reuse damage-flash machinery with a
   'growth' style), 600ms.
5. **Eased camera:** focus/zoom transitions lerp position+scale over
   ~250ms ease-out instead of snapping (MapCanvas camera update path;
   respect pinch/wheel = direct, only programmatic focus eases).
6. **Corner-bracket selection:** replace dashed selection circles
   (bodies, ships, settlements) with 4 corner brackets rotating slowly
   (0.15 rad/s), warning-amber for bodies, info-cyan for ships. Same
   radii as today.
7. **Label fade-in:** body labels near their zoom threshold get 150ms
   alpha fade (track appearance in a small Map<id, appearMs>).

---

## Acceptance

- 60fps at default system view with a 7-faction late-game save (no new
  work at far zoom except tracers/halos, both O(active entities)).
- All FX deterministic across clients where world-visible.
- Nothing added to the server; zero schema changes.
- Each workstream compiles + `CI=true npm run build` green standalone.

## Sequencing

Five parallel worktree agents (A–E). File ownership to minimize merge
pain: A owns ShipIcons/shipIconCache + ship-draw fns; B owns the flash/FX
section + MapCanvas FX-state wiring; C owns body-draw + starfield
sections + planetTexture; D owns orbit/trajectory/ownership sections;
E owns isoStructures + city/station draws + MapCanvas camera/selection.
Integrator (main session) merges, resolves mapRenderer overlaps,
verifies, deploys.
