# Orbital Mechanics Game — Prototype Handoff Document

**Date:** 2026-05-14
**Scope:** Single-file HTML/Canvas prototype (`index.html`, ~4100 lines)
**Purpose:** Document every hard-won lesson from the prototype so the React version doesn't repeat them.

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [The Patched Conic Approximation](#2-the-patched-conic-approximation)
3. [The Escape Orbit Problem](#3-the-escape-orbit-problem)
4. [checkNodeExecution — The Heartbeat](#4-checknodeexecution--the-heartbeat)
5. [The Commit System and Node Lifecycle](#5-the-commit-system-and-node-lifecycle)
6. [Bugs That Were Hell to Find](#6-bugs-that-were-hell-to-find)
7. [Transfer Planner Design](#7-transfer-planner-design)
8. [Moon Transfer Generalization](#8-moon-transfer-generalization)
9. [Numerical Pitfalls](#9-numerical-pitfalls)
10. [Scaling — Planet Sizes, SOIs, and Orbits](#10-scaling--planet-sizes-sois-and-orbits)
11. [Visual/UX Lessons](#11-visualux-lessons)
12. [Recommendations for the React Version](#12-recommendations-for-the-react-version)

---

## 1. Architecture Overview

The prototype is a single `index.html` with inline JS. No build step. Key subsystems:

| Subsystem | Description |
|---|---|
| **BODIES[]** | Static array of 23 celestial bodies (star, planets, dwarfs, moons) with orbital elements, SOI radii, mu values |
| **Orbit representation** | Keplerian elements: `{ rp, ra, omega, M0, epoch, direction, period, parentBodyId }` |
| **Node system** | Maneuver nodes with anchors: `absolute`, `periapsis`, `apoapsis`, `encounter`, `exit`, `capture` |
| **SOI transition engine** | `findNextSOIEvent()` scans an orbit forward to detect SOI entries/exits |
| **Transfer planner** | `planTransferManeuver()` — grid search over (burnTime, dv) to find working Hohmann transfers |
| **Trajectory projection** | `projectTrajectory()` renders the colored flight path with SOI transition markers |
| **Game loop** | `loop()` → advance tick → `checkNodeExecution()` → render |

### Key helper functions the React version will need:

- `orbitWorldPos(orbit, t)` — world-space position at time t
- `localPositionAt(orbit, t)` — position relative to parent body
- `orbitFromStateVector(pos, vel, mu, parentId)` — state vector → Keplerian elements
- `applyNodeToOrbit(orbit, node)` — apply a dv burn, return new orbit
- `findNextSOIEvent(orbit, startTick, maxTick)` — scan for next SOI entry/exit
- `muOf(bodyId)` — gravitational parameter (special-cased: Sol uses derived MU_SOL, others use body.mu)
- `nextApsisTime(orbit, startTick, 'periapsis'|'apoapsis')` — when the next apsis occurs

---

## 2. The Patched Conic Approximation

The game uses **patched conics**, not n-body simulation. This means:

- At any moment, a ship orbits exactly ONE body (its `parentBodyId`)
- When the ship crosses an SOI boundary, its orbit is instantaneously re-parameterized in the new parent's frame
- SOI transitions are detected by `findNextSOIEvent()`, which steps along the orbit and checks distances to child bodies (for entries) and distance from current parent (for exits)

### SOI Grace Period

**Problem solved:** Without a grace period, a ship that just exited a body's SOI could immediately "re-enter" on the next frame (oscillating exit/re-entry). This happens because the SOI boundary check uses discrete position samples — the ship can be slightly inside on one frame, slightly outside the next, then slightly inside again.

**The mechanism (two per-ship properties):**

```js
ship._soiGrace = tick + 10;       // suppress re-entry until this tick
ship._soiGraceBody = parent.id;   // only suppress for THIS specific body
```

When the ship **exits** a body's SOI, set both. When scanning for SOI entries, skip the graced body:

```js
if (ship._soiGrace && tick < ship._soiGrace && body.id === ship._soiGraceBody) continue;
```

When the ship **enters** a body's SOI (intentional capture or encounter), clear the grace: `ship._soiGrace = 0`. This prevents the grace from blocking a legitimate later encounter with the same body.

**Grace duration (10 ticks):** Long enough that the ship moves well away from the SOI boundary. Too short and the oscillation returns. Too long and the ship can fly through a moon's SOI undetected. At high time warp this becomes a problem — 10 ticks at 100x warp is only 0.1 seconds of wall time but the ship may have crossed several SOI boundaries.

### MU_SOL Derivation

Sol's `mu` is not hardcoded. It's derived from Jupiter's orbital parameters to ensure self-consistency:

```js
const MU_SOL = 4 * PI^2 * r_jupiter^3 / T_jupiter^2
```

This guarantees that `v_circ = sqrt(MU_SOL / r)` gives the correct circular velocity at any planet's orbit. If you hardcode MU_SOL independently of the body data, numerical drift in transfers is guaranteed.

---

## 3. The Escape Orbit Problem

### Why Kepler Breaks for Escapes

All "normal" orbits (ellipses) are represented as Keplerian elements and propagated analytically — you can compute the position at any time t with pure math (mean anomaly → eccentric anomaly → true anomaly → position). This is fast and exact.

**Escape orbits (hyperbolas) can't use this.** The Keplerian propagation assumes a closed orbit with a well-defined period. A hyperbolic trajectory has no period, and the standard mean-anomaly-to-position pipeline produces garbage for `e >= 1`.

### The Dual Physics System

The prototype solves this by running **two completely separate physics paths**:

1. **Keplerian path** (normal orbits): Analytical position computation, used for everything from rendering to SOI boundary scanning. Fast, exact, no accumulation error.

2. **Verlet integration path** (escape orbits): Numerical step-by-step propagation. The orbit carries an `escapeEnergy` flag and an `escapeState` object `{ rx, ry, vx, vy, t }` — the local-frame position and velocity at the moment of the burn. The integrator steps forward from that state with `h = 0.25` tick steps.

```js
// Velocity Verlet integration
const acc = -mu / (r * r * r);
rx += vx * h + 0.5 * ax * h * h;    // position update
ry += vy * h + 0.5 * ay * h * h;
// ... recompute acceleration at new position ...
vx += 0.5 * (ax_old + ax_new) * h;  // velocity update (uses average acceleration)
vy += 0.5 * (ay_old + ay_new) * h;
```

### Where the Dual System Bites You

Every function that touches orbits must ask: "Is this an escape orbit?" and branch accordingly:

- `findNextSOIEvent()` — calls `propagateEscape()` for escape orbits instead of Kepler scanning
- `checkNodeExecution()` — uses Verlet propagation for SOI exit detection on escape orbits
- Trajectory rendering — must use integrated positions, not Kepler positions
- `orbitFromWorldState()` — sets `escapeEnergy` and stores `escapeState` when the energy term indicates a hyperbola

**The React version should consider:** Either implement hyperbolic Kepler propagation (it exists — uses hyperbolic eccentric anomaly `H` instead of `E`), which keeps one code path, or embrace the dual system but make it a clean polymorphic dispatch (e.g., `orbit.positionAt(t)` method that internally selects the right algorithm).

### Step Size Matters

The Verlet integrator uses a fixed step of `h = 0.25` ticks. At high time warp (simSpeed = 100), one frame advances `dt * 100` ticks, but `checkNodeExecution` only runs once per frame. If the ship moves more than a body's SOI diameter in one frame, it **tunnels through** without detection.

**Mitigation:** Either sub-step the physics at high time warp, or cap the effective tick advance per frame. The prototype doesn't fully solve this — it's a known gap.

---

## 4. checkNodeExecution — The Heartbeat

This is the most important function in the game. It runs every frame (when simSpeed > 0) and does three things **in a specific order that must not change**:

### Execution Order (Load-Bearing)

```
1. SOI transitions (escape orbits via Verlet, then normal orbits via position check)
   └── If entering a body's SOI AND a capture node exists for that body:
       └── Fire the capture node immediately (construct analytical circular orbit)
2. Surface collision check (rp < parent.radius)
   └── Must use FRESH parentBodyId (after step 1 may have changed it)
3. Fire committed time-triggered nodes (node.t <= tick)
   └── Skip capture-anchor nodes (they're event-driven, not time-driven)
```

**Why the order matters:**

- If you fire time-triggered nodes (step 3) before SOI transitions (step 1), a capture node might get consumed by the time-trigger code while the ship is still in heliocentric orbit.
- If you check surface collision (step 2) before SOI transitions (step 1), you'll check against the *old* parent body — the exact bug from Section 6.1.
- If you fire capture nodes outside the SOI-entry code, the ship's orbit might get modified between entry and capture, producing an inconsistent state.

### The SOI Entry + Capture Dance

When the ship enters a body's SOI AND there's a committed capture node for that body:

1. `orbitFromWorldState()` converts the world-frame state vector to an orbit around the new body
2. Immediately (same frame), the capture code constructs an analytical circular orbit:
   - `capR = min(r_at_entry, body.soi * 0.8)` — don't orbit outside the SOI
   - `omega = atan2(localPos.y, localPos.x)` — orbit aligned with current position
   - `rp = ra = capR` — exactly circular, no eccentricity drift
3. Fuel is deducted, the capture node is removed from the ship's node list

This happens atomically in one frame. The intermediate orbit from step 1 is never visible to the player or to any other system.

---

## 5. The Commit System and Node Lifecycle

### Two-Phase Node Execution

Nodes go through a lifecycle:

```
Created (uncommitted) → Committed → Fired (removed)
```

**Uncommitted nodes** are planning artifacts. They appear on the trajectory preview but do NOT execute. The player can drag their dv handles, move them, delete them. The trajectory projection shows what *would* happen if they fired.

**Committed nodes** are locked in. When `tick >= node.t`, the engine fires them. There's no undo once committed (though the player can delete committed nodes before their time arrives).

**Why this matters for React:** The trajectory projection system (`computeTrajectory`, `computeNodeChain`) processes ALL nodes regardless of commit status. The execution system (`checkNodeExecution`) only fires committed nodes. These two systems must agree on the node order and orbit chain, or the preview won't match reality.

### recomputeNodeTimes

Anchor-based nodes (`periapsis`, `apoapsis`, `encounter`, `exit`) don't have a fixed time. Their `t` is computed dynamically based on the orbit they'll fire on. `recomputeNodeTimes(ship)` walks the node chain, applies each burn to get the next orbit, and recalculates when the next anchor occurs.

This is called after:
- Any orbit change (SOI transition, node firing, capture)
- Adding or removing a node
- Changing a node's dv

If you forget to call it, anchor-based nodes fire at stale times (or never).

### Fuel Cost Model

```js
fuel_cost = round(sqrt(dv_prograde^2 + dv_radial^2) * 10)
```

Simple linear scaling from dv magnitude. Crash penalty is a flat -20 fuel. The React version may want a more nuanced model (Tsiolkovsky rocket equation, mass ratios), but the linear model works for gameplay.

---

## 6. Bugs That Were Hell to Find

### 3.1 The Stale Parent Reference Bug (Capture Crash)

**Symptom:** After capturing at Mars, the ship's orbit was forced to rp=29, ra=29 (Sol's radius + 1), and the ship appeared to be orbiting Sol despite `parentBodyId` saying Mars.

**Root cause:** The surface collision check used a `parent` variable that was set BEFORE SOI transitions ran:

```js
const parent = byId[ship.orbit.parentBodyId]; // ← set once at top
// ... SOI transitions change ship.orbit.parentBodyId to 'mars' ...
// ... capture code fires, sets orbit around Mars ...
if (parent.radius && ship.orbit.rp < parent.radius) { // ← parent is still SOL
    ship.orbit.rp = parent.radius + 1; // Sol.radius = 10... wait, it was 28 before scaling
```

**Fix:** Re-read the parent AFTER all SOI transitions and node executions:

```js
const curParent = byId[ship.orbit.parentBodyId]; // fresh read
if (curParent.id !== 'sol' && curParent.radius && ship.orbit.rp < curParent.radius) { ... }
```

**Lesson for React:** Never cache the parent body reference across a function that mutates `parentBodyId`. Either re-read it, or structure the code so SOI transitions and collision checks are in separate passes.

**Debugging technique that found it:** We used `Object.defineProperty` and `Proxy` traps on the orbit object to intercept property mutations and log their call stacks. This revealed the exact line mutating `rp`/`ra`.

### 3.2 Sol Collision False Positives

**Symptom:** Ships transferring to Mercury would crash into "the surface" even though Mercury's orbit is at r=51.

**Root cause:** Sol had a visual radius of 28 (pre-scaling). A transfer orbit with periapsis < 28 triggered the surface collision check against Sol.

**Fix:** Skip the surface collision check when `curParent.id === 'sol'`. Sol's "surface" is not meaningful gameplay-wise — no ship orbit should collide with it. If you want a solar proximity hazard, make it a separate game mechanic, not the generic collision check.

### 3.3 Capture Nodes Firing in Wrong SOI

**Symptom:** Capture nodes (intended to fire when entering the target's SOI) were consumed while the ship was still in heliocentric orbit, because the normal node-firing code checked `node.t <= tick && node.committed` without distinguishing capture nodes.

**Fix:** Skip capture-anchor nodes in the normal firing loop:

```js
if (node.anchor === 'capture') continue;
```

Capture nodes are handled separately in the SOI-enter logic. This is a critical architectural point: **capture nodes are event-driven (SOI entry), not time-driven.**

**Lesson for React:** Make the node execution system explicitly distinguish between time-triggered nodes and event-triggered nodes. A discriminated union (`{ type: 'timed', t: number }` vs `{ type: 'on-soi-enter', targetBodyId: string }`) is cleaner than anchor string checks.

### 3.4 orbitFromStateVector Producing Non-Circular Orbits for Circular Velocity

**Symptom:** After capture, the orbit should be circular (rp = ra), but `orbitFromStateVector` produced slight eccentricity (e.g., rp=14.8, ra=15.2) even when given exact circular velocity.

**Root cause:** Floating-point error in the state-vector-to-elements conversion. The eccentricity vector calculation amplifies small errors, and `1 - e` vs `1 + e` creates asymmetric rp/ra.

**Fix:** Don't use `orbitFromStateVector` for captures. Construct the orbit analytically:

```js
ship.orbit = {
    rp: capR, ra: capR,  // exactly circular
    omega: Math.atan2(localPos.y, localPos.x),
    M0: 0, epoch: tick, direction: orbit.direction,
    period: 2*PI * sqrt(capR^3 / mu),
    parentBodyId: body.id
};
```

**Lesson for React:** Anywhere you need a *known* orbit shape (circular capture, parking orbit), construct it analytically. Only use the state-vector solver for *unknown* orbits (post-burn trajectories, SOI transitions).

### 3.5 Clamping rp/ra Without Updating Other Elements

**Symptom:** After clamping `orbit.rp` and `orbit.ra` (e.g., to prevent sub-surface orbits), the ship's rendered position jumped outside the SOI.

**Root cause:** `omega` and `M0` encode the orbit orientation and phase. If you change `rp`/`ra` without recalculating these, `orbitWorldPos()` computes positions on a completely different orbit.

**Fix:** Never mutate individual orbital elements. Always construct a complete, self-consistent orbit object. If you need to "fix" an orbit, build a new one from scratch (see 3.4's analytical construction).

**Lesson for React:** Make orbit objects **immutable**. Use `Object.freeze()` or a class with no setters. Every orbit change produces a new object. This eliminates an entire class of mutation bugs.

---

## 7. Transfer Planner Design

### Why Analytic Hohmann Alone Fails

The analytic Hohmann transfer gives you:
- Injection dv = f(v_inf, mu_origin, r_pe)
- Transfer time = PI * sqrt(a_transfer^3 / mu_parent)
- Phase angle = PI - omega_target * transfer_time

But in a patched-conic sim, this is only a first approximation. The SOI boundaries create discontinuities — the ship's velocity changes frame when crossing them. The analytic solution assumes instantaneous frame changes at the exact SOI boundary, but the actual trajectory bends as it approaches.

### The Grid Search Approach

The prototype uses a **brute-force grid search** over `(burnTime, dv)`:

1. Compute analytic Hohmann parameters as the center of the search
2. Define a search window: `burnTime ∈ [tPhase - windowHalf, tPhase + windowHalf]`, `dv ∈ [dv_min, dv_max]`
3. For each (burnTime, dv) pair, simulate the trajectory through `findNextSOIEvent` calls
4. If the trajectory enters the target's SOI, compute the capture orbit and score it
5. Best score wins (soonest departure or minimum total dv, depending on strategy)

**Grid resolution:** ~140 dv steps x variable time steps x up to 2-4 phase windows. This runs in <100ms for planet-to-planet. Moon transfers are faster (shorter periods, smaller search space).

### The simulateChain Function

This is the inner loop's core. It:
1. Applies the injection burn to get a post-burn orbit
2. Walks forward through SOI events (up to 16 iterations)
3. If it finds an SOI-enter event matching the target, computes the capture orbit
4. Returns the post-capture orbit (with `_brakeDv` attached) or null

**Critical:** The chain walker must NOT abort on entering the "wrong" body. For multi-hop transfers (moon → planet exit → solar transfer → target planet), the ship passes through multiple SOI transitions. The old code aborted on wrong-body enters; this was removed to support moon transfers.

### refineBrakeDv

After the grid search finds a working trajectory, `refineBrakeDv` re-simulates to compute the exact brake dv at the target's periapsis. This accounts for the actual approach orbit (which may differ from the analytic estimate).

---

## 8. Moon Transfer Generalization

### Transfer Case Classification

Every transfer is classified into one of 6 cases based on where the ship is and where the target is:

| Case | Ship At | Target | Common Frame | Needs Escape? | Needs Capture? |
|---|---|---|---|---|---|
| `planet-planet` | Planet (orbits Sol) | Planet (orbits Sol) | Sol | Yes (planet) | Yes (planet) |
| `to-moon` | Planet | Moon of same planet | Planet | No | Yes (moon) |
| `moon-moon` | Moon | Sibling moon (same parent) | Parent planet | Yes (moon) | Yes (moon) |
| `to-parent` | Moon | Parent planet | — | Yes (moon) | No |
| `moon-to-planet` | Moon | Planet (different system) | Sol | Yes (moon+planet) | Yes (planet) |
| `planet-to-foreign-moon` | Planet | Moon of different planet | — | N/A | N/A |

The last case (`planet-to-foreign-moon`) is not directly supported. It returns an error telling the player to transfer to the moon's parent planet first. This is a UX choice — the multi-step transfer (planet → planet → moon) is better planned as two separate maneuvers.

### Hohmann Math Per Case

All non-escape cases use the same Hohmann framework, parameterized by `mu_cp` (common parent's mu), `r1` (origin orbit radius in common frame), and `r2` (target orbit radius in common frame):

```
a_transfer = (r1 + r2) / 2
v1_trans = sqrt(mu_cp * (2/r1 - 1/a_transfer))
v_inf_origin = |v1_trans - v1_circ|
transferTime = PI * sqrt(a_transfer^3 / mu_cp)
```

The injection dv computation differs per case:

- **planet-planet:** Hyperbolic excess escape: `v_burn = sqrt(v_inf^2 + 2*mu_planet/r_pe)`
- **to-moon:** Direct orbit change (no escape): `dv = v_transfer - v_current` at ship's periapsis
- **moon-moon:** Escape current moon with excess: `v_burn = sqrt(v_inf^2 + 2*mu_moon/r_pe)`
- **moon-to-planet:** Chain through two gravity wells:
  1. v_inf at planet boundary (from Hohmann)
  2. v_needed at moon's orbit: `sqrt(v_inf_planet^2 + 2*mu_planet/r_moon_orbit)`
  3. v_inf at moon boundary: `|v_needed - v_moon_circular|`
  4. v_burn at ship periapsis: `sqrt(v_inf_moon^2 + 2*mu_moon/r_pe)`

### Phase Angle Generalization

The phase angle calculation uses angular velocities and initial angles of different bodies depending on the case:

- **planet-planet:** Origin planet vs target planet around Sol
- **to-moon:** Ship's orbital motion vs moon's motion around planet
- **moon-moon:** Origin moon vs target moon around planet
- **moon-to-planet:** Parent planet vs target planet around Sol

For `to-moon`, the ship doesn't have a static `angle0` like a celestial body. Its angle at t=0 is approximated from orbital elements: `angle0 ≈ omega + M0 - omega_ship * epoch`.

### The `to-parent` Special Case

Escaping to the parent body is fundamentally different — there's no Hohmann transfer, just an escape burn:

```
dv_escape = sqrt(2 * mu_moon / r_pe) - v_current
```

Multiplied by 1.05 for margin. This is a single-node plan (no capture needed — the ship is already in the parent's SOI after escaping).

**Gotcha:** The escape burn can have enough energy to escape the parent planet too. In testing, escaping Luna put the ship into solar orbit, not Earth orbit. This is physically correct but may surprise players. Consider adding a circularization burn option after escape.

---

## 9. Numerical Pitfalls

### Vis-Viva Edge Cases

The vis-viva equation `v = sqrt(mu * (2/r - 1/a))` can produce NaN or imaginary results when:
- `a` is negative (hyperbolic orbit) and `2/r < 1/a` — this is valid, the argument is positive
- `a` is very close to zero — degenerate orbit
- `r` > SOI — the orbit extends beyond the SOI, which doesn't physically make sense

Always guard with `Math.max(0, ...)` before the sqrt.

### Period Calculation for Hyperbolic Orbits

Hyperbolic orbits have no period (they're open). But the code uses `orbit.period` in many places. For hyperbolic orbits, set period to a large finite value (e.g., `Infinity` or `1e9`) and guard against using it in modular arithmetic.

### SOI Event Scanning Step Size

`findNextSOIEvent` steps along the orbit in discrete increments. If the step size is too large, it can miss a moon's SOI entirely (the ship passes through without detecting the crossing). The step size should be proportional to the smallest SOI in the system divided by the ship's velocity. For fast-moving ships near small moons, this matters.

### Mean Anomaly Wrapping

Mean anomaly `M` grows without bound. Many calculations use `M mod 2*PI`, but this can introduce phase errors if epoch is very far in the past. Periodically re-epoch orbits (set M0 to current M, epoch to current tick) to keep numbers small.

### Time Warp and SOI Tunneling

The game loop runs `checkNodeExecution()` once per animation frame. At high time warp (simSpeed = 100), each frame advances `dt * 100` ticks. If a ship's velocity carries it past a small moon's SOI in one frame, the position check never sees it inside the SOI.

**Example:** Ship moving at 5 units/tick, moon SOI = 4 units, frame dt = 0.016s, simSpeed = 100. Tick advance = 1.6 ticks. Ship moves 8 units between checks — completely skipping a 4-unit-diameter SOI.

**Prototype workaround:** The prototype doesn't fully solve this. `findNextSOIEvent` (used for trajectory preview) does sub-tick scanning, but the runtime execution in `checkNodeExecution` uses single-point checks per frame. The Verlet integrator has a fixed step of h=0.25, which helps for escape orbits, but normal Kepler orbits use single-point checks.

**Recommendation for React:** Sub-step the physics. At high time warp, divide the frame's tick advance into sub-steps of max 0.5 ticks each, running `checkNodeExecution` for each sub-step. Alternatively, use continuous collision detection: compute the ship's swept path over the frame and check intersection with SOI spheres analytically.

### The orbitFromWorldState Eccentricity Solver

The state-vector-to-elements conversion uses a polynomial root-finding approach (bisection on a custom `f(q)` function where `q = 1 - e^2`). This is non-standard — most references use the eccentricity vector `e = (v × h)/mu - r/|r|`. The prototype's approach was chosen to avoid the eccentricity vector's numerical instability near `e = 0` (circular orbits).

However, this solver has its own edge cases:
- For nearly circular orbits (`e < 0.001`), the bisection can converge to slightly wrong values, making a "circular" orbit have a small eccentricity. This is why captures are constructed analytically (Section 6.4).
- For hyperbolic orbits (`e > 1`), the solver caps `e^2` to `[0, 1]` and instead flags the orbit with `escapeEnergy`, switching to the Verlet path.
- The solver uses 200 initial scan steps and 80 bisection refinements. Reducing these for performance will degrade orbit accuracy.

---

## 10. Scaling — Planet Sizes, SOIs, and Orbits

This was a major tuning pass that affected both visuals and physics. Getting it wrong breaks transfers silently.

### The Problem

At original scale, the inner solar system was a cramped cluster. Planets were fat blobs whose visual radii nearly touched their SOIs, and SOIs were so small that moons were invisible specks. It didn't feel like space.

### What We Changed and Why

| Parameter | Before | After | Rationale |
|---|---|---|---|
| Inner planet orbit radii (Mercury–Mars) | 1x | 1.5x | Spread the inner system so planets aren't on top of each other |
| Inner planet orbital periods | 1x | 1.5^1.5 ≈ 1.837x | **Must** scale as r^1.5 to preserve Kepler's third law (T^2 ∝ r^3). If you scale orbits without scaling periods, circular velocities are wrong and transfers break. |
| Planet visual radii | e.g., Earth=5 | Earth=3 | Smaller planets make the space between them feel bigger. Also prevents the planet disk from overlapping its own SOI ring. |
| SOI radii | e.g., Earth=20 | Earth=30 | Larger SOIs give more room for moon orbits inside them and make capture easier to visualize. A ship entering an SOI is now a visible event on the map. |
| Moon orbital radii | e.g., Luna=8 | Luna=12 | Spread moons within the now-larger parent SOIs so they're not jammed against the planet surface. |
| Gas giant orbits | Unchanged | Unchanged | Outer system already had enough room. Scaling would push them off-screen. |
| Moon SOIs | e.g., Luna=2 | Luna=4 | Larger moon SOIs make moon captures possible and visible. At SOI=2, the capture window was essentially zero. |

### The Critical Constraint: Kepler Consistency

Every `orbitPeriod` must satisfy `T = 2*PI * sqrt(r^3 / mu_parent)` for the body's `orbitRadius` and its parent's `mu`. If this relationship is broken:

- Phase angle calculations are wrong (ships arrive when the target isn't there)
- Circular velocity computations give incorrect values
- Vis-viva returns NaN or absurd dv
- Transfer burns overshoot or undershoot silently

In the prototype, we enforced this by manually computing scaled periods:
```js
// For a planet with scaled orbit:
orbitPeriod: originalPeriod * Math.pow(1.5, 1.5)  // 1.5x orbit → 1.5^1.5x period

// For moons, periods are derived from first principles:
orbitPeriod: 2 * Math.PI * Math.sqrt(Math.pow(orbitRadius, 3) / parentMu)
```

### Scaling Gotchas We Hit

**Gotcha 1 — MU_SOL cascade:** `MU_SOL` is derived from Jupiter's orbital parameters (`4*PI^2 * r^3 / T^2`). Since we didn't scale Jupiter's orbit, MU_SOL stayed consistent. But if you scale gas giants too, MU_SOL changes, which cascades to every heliocentric velocity calculation. Either derive MU_SOL from an unscaled reference body, or re-derive it after all scaling is applied.

**Gotcha 2 — Collision threshold after rescale:** After scaling planet radii down (Earth from 5 to 3) and SOIs up (20 to 30), the surface collision check (`rp < parent.radius`) still works, but the margin (`radius + 1`) is proportionally larger relative to the smaller body. Ships that crash end up in a proportionally higher orbit. Not game-breaking but worth tuning.

**Gotcha 3 — Moon SOI vs moon radius vs parent SOI:** After scaling, check that `moon.orbitRadius + moon.soi < parent.soi` (moons don't poke outside the parent's SOI) and `moon.orbitRadius - moon.soi > parent.radius` (moons don't clip the parent's surface). We had to manually adjust several moon orbit radii after expanding SOIs.

**Gotcha 4 — Transfer planner search bounds:** The grid search dv range is derived from escape velocity at the current orbit. After scaling SOIs and radii, the escape velocities changed, which shifted the search range. The search must be wide enough to find solutions but narrow enough to be fast. We ended up with `dv_min = escape_velocity - current_velocity` and `dv_max = max(2x analytic_dv, 3x dv_min)`.

### Recommendation for React

Separate physics parameters from visual parameters entirely. Have a `PhysicsBody` with real orbital mechanics values and a `VisualBody` with display radius, glow size, label offset, etc. The camera/renderer applies a zoom-dependent visual transform. This way you can tune the look without risking physics consistency.

If you want non-linear distance compression (e.g., log-scale to fit Mercury and Neptune on the same screen), do it purely in the render layer. The physics should never know about it.

Consider a `validateBodyConsistency()` function that runs on startup and asserts Kepler's law holds for every body. Any discrepancy above a threshold should throw a loud error, not silently produce broken transfers.

---

## 11. Visual/UX Lessons

### Target Selection

The original "click on the map to pick a target" approach was unreliable — small bodies are hard to click, moons are often invisible at the solar system zoom level. 

**Solution:** Button-based target list in the ship panel, grouped by category (own moons, planets, sibling moons, etc.). The map click still works as a secondary method but isn't the primary UX.

### Transfer Feedback

When a transfer plan fails to find a valid trajectory, the player needs to understand why. The prototype flashes a status message, but better feedback would include:
- "No departure window in next N orbits" vs "Target unreachable with current fuel"
- Visual phase angle indicator showing when the next window opens
- Estimated time-to-window

### Canvas Screenshot Tooling

The HTML5 Canvas with requestAnimationFrame loop caused preview/screenshot tools to consistently time out. The React version should consider using a separate rendering approach that doesn't block the main thread, or provide a "pause and snapshot" debug mode.

---

## 12. Recommendations for the React Version

### State Management

1. **Orbits should be immutable value objects.** Every mutation creates a new orbit. This eliminates the entire class of "stale reference" and "partial mutation" bugs that dominated debugging.

2. **Ship state should be clearly separated:** `{ orbit: Orbit, nodes: ManeuverNode[], fuel: number, trajectory?: ProjectedTrajectory }`. The trajectory cache should be invalidated on any orbit or node change.

3. **Use discriminated unions for maneuver nodes:**
   ```ts
   type ManeuverNode = 
     | { type: 'timed'; t: number; dv: Vector2; committed: boolean }
     | { type: 'capture'; targetBodyId: string; dv: Vector2; committed: boolean }
   ```

### Physics Engine Separation

Put all orbital mechanics in a pure module with zero DOM/React dependencies:
- `orbital-mechanics.ts` — Keplerian math, vis-viva, state vector conversion
- `soi-transitions.ts` — SOI boundary detection and orbit re-parameterization
- `transfer-planner.ts` — Hohmann computation, grid search, case classification
- `node-execution.ts` — burn application, capture logic

This makes the physics testable independently. Write unit tests for every edge case documented in Section 3.

### Transfer Planner as a Web Worker

The grid search is CPU-intensive (~100ms for planet-planet, could be longer for moon-to-planet with wider search). Run it in a Web Worker so the UI doesn't freeze. Return progress updates ("searching window 1 of 4...") for UX feedback.

### Body Hierarchy

The prototype uses a flat array with `parent` string IDs. The React version should build a proper tree:

```ts
interface CelestialBody {
  id: string;
  parent: CelestialBody | null;
  children: CelestialBody[];
  orbitRadius: number;
  orbitPeriod: number;
  mu: number;
  soi: number;
  radius: number;
  // ...
}
```

This makes "find common ancestor" and "find siblings" operations trivial, which are needed constantly by the transfer classifier.

### Testing Matrix

Every transfer type should have automated tests:

| Test | From | To | Expected |
|---|---|---|---|
| Planet→Planet (outbound) | Earth | Mars | 2 nodes, capture at Mars |
| Planet→Planet (inbound) | Earth | Venus | 2 nodes, capture at Venus |
| Planet→Own Moon | Earth | Luna | 2 nodes, capture at Luna |
| Planet→Own Moon | Jupiter | Io | 2 nodes, capture at Io |
| Moon→Sibling Moon | Io | Europa | 2 nodes, capture at Europa |
| Moon→Parent | Luna | Earth | 1 node (escape only) |
| Moon→Different Planet | Luna | Mars | 2 nodes, capture at Mars |
| Already at target | Earth | Earth | Error |
| Foreign moon | Earth | Io | Error with redirect |
| Ship in solar orbit | Sol frame | Mars | Error |

### Known Limitations to Address

1. **No retrograde orbit support** — all orbits are assumed prograde. Retrograde captures or transfers aren't planned.
2. **No inclination** — everything is 2D coplanar. If you add 3D, the transfer planner needs plane-change burns.
3. **No Oberth optimization** — the planner doesn't seek low-periapsis burns for efficiency. A "deep space maneuver" option would help.
4. **Escape-to-parent overshoots** — escaping a moon can escape the parent planet too. Should offer a circularization option.
5. **No multi-target chaining** — can't plan Earth→Jupiter→Io as one maneuver. Player must do it in two steps.
6. **Grid search completeness** — the search can miss valid windows if the analytic phase angle estimate is way off (unlikely for circular orbits but possible for eccentric ones).

---

## Appendix: Key Constants and Formulas

```
TWO_PI = 2 * Math.PI

MU_SOL = 4 * PI^2 * r_jupiter^3 / T_jupiter^2

Vis-viva:       v = sqrt(mu * (2/r - 1/a))
Circular vel:   v_circ = sqrt(mu / r)
Escape vel:     v_esc = sqrt(2 * mu / r)
Orbital period: T = 2*PI * sqrt(a^3 / mu)
Semi-major:     a = (rp + ra) / 2
Hohmann dv:     v_inf = |v_transfer - v_circular|  at departure/arrival
Hyperbolic:     v_burn = sqrt(v_inf^2 + 2*mu/r_pe)  (Oberth-boosted escape)
Phase angle:    theta = PI - omega_target * transferTime
Synodic period: T_syn = 2*PI / |omega_target - omega_origin|
```
