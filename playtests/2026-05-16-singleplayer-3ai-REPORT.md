# Single-Player Playtest — 2026-05-16

**Setup:** Player (Earth) vs 3 AI (defaults — Outer Alliance@Mars, Solar Directorate@Mercury, Mars Combine@Venus). Defaults left untouched: starting resources `fuel 200 / ore 100 / credits 50 / science 0`, 1 city + 1 station + 3 ships per faction.

**Result:** Player was eliminated at **T+795** (last ship "Scirocco" destroyed on Earth by an enemy-built "Earth Outpost" plus a roving ai-3 Bulwark). The match never ended — sim ran to T+7311 with `status: 'active'` and the player at `0 ships / 0 settlements`, idling on 517 fuel / 395 ore / 239 credits / 0 sci.

Companion log: `2026-05-16-singleplayer-3ai.log.txt` (deduped from the in-game logger ring buffer).

---

## TL;DR — five things broken

1. **No defeat / victory detection.** Once the player has 0 ships and 0 settlements, nothing changes. The game keeps ticking, the AIs keep idling, no overlay fires. (`BUG-4`)
2. **Body ownership doesn't track settlement ownership.** Earth still reads `ownedBy: 'player'` even though the player has zero settlements there and ai-3 has a "Earth Outpost" city. (`BUG-3`)
3. **AI opening rush is unwinnable as the player.** Within the first ~150 ticks every AI ships a freighter at Earth and lays a city; the player's 2 default settlements + 1 frigate cannot survive 3 simultaneous arrivals. (`BAL-1`)
4. **Faction name pool is decoupled from the actual capital body.** When ai-3 randomly lands on Venus, it still gets named "Mars Combine" — and all its starter ships get the suffix `-MAR`, which then appear orbiting Venus. (`BUG-1`)
5. **Every log entry is recorded twice.** 1594 raw entries dedupe down to exactly 807, perfectly 50%. Combat events appear twice per tick with identical timestamps — this is a logging effect double-fire (React 18 StrictMode), not actual double-combat. The diagnostic exporter is harder to read because of it. (`LOG-BUG-A`)

---

## Timeline of the match

| Tick | Event |
|---|---|
| 0 | Game starts. Player owns Earth, ai-1 Mars, ai-2 Mercury, ai-3 Venus. Each faction has 3 ships + 2 settlements. |
| 0 | Three AI factions immediately queue a frigate build at their capital and dispatch a freighter at **Earth** to colonize ("send freighter to colonize Earth"). |
| 2 | Player queues 1 frigate ("Scirocco") at Earth Yards. Cost actually paid: -20 fuel / -30 ore / -25 credits, but the BUILD button only displays the ore/credits, missing fuel. (`BUG-2`) |
| 15 | Player commits Vanguard → Mercury. |
| 44 | Player commits Sentinel → Venus. |
| 60 | All three AI frigates ("Hammer", "Defiant", "Hammer") finish. |
| 63 | Player's Scirocco frigate finishes. |
| 65–106 | ai-2's `Hauler-SOL` arrives at Earth and immediately starts taking auto-fire from Scirocco + Earth City + Earth Yards. Dies tick 106. (Player wins this engagement.) |
| 76 | Player's Vanguard arrives at Mercury — alone — into Mercury City, Mercury Yards, 2 Mercury frigates ("Vanguard-SOL", "Sentinel-SOL"). |
| 88 | ai-3 `Hauler-MAR` arrives at Earth (second incoming freighter). |
| 129 | Player's Sentinel arrives at Venus — also alone — into Venus City, Venus Yards, Vanguard-MAR, Sentinel-MAR, Hammer. |
| 151 | ai-1 `Hauler-OUT` arrives at Earth (third incoming freighter — Earth is now sharing a body with all 3 enemy freighters at once). |
| 167 | ai-2 frigates `Vanguard-SOL`/`Sentinel-SOL` arrive at Earth as escorts. The Earth body now has 5 player units (Hauler, Scirocco, Earth City, Earth Yards, +pending) versus an arriving stack. |
| 201 | Player's Vanguard destroyed at Mercury (5 enemy units pounding it for ~25 dmg/cycle). |
| 220 | Player's Sentinel destroyed at Venus. |
| 278 | The 2 ai-2 frigates ravaging Earth (`Vanguard-SOL`, `Sentinel-SOL`) finally die. |
| 290 | ai-3 frigate `Hammer` arrives at Earth — fresh attacker. |
| 360 | Player's Mercury counter-attack ends: `Defiant` (ai-2's frigate) destroyed. |
| 454 | **Massive convergence at Earth**: ai-1 Vanguard-OUT + Sentinel-OUT + ai-3 Vanguard-MAR + Sentinel-MAR all arrive in the same tick. **Earth Yards destroyed** the same tick. |
| 475 | ai-3's Vanguard-MAR + Sentinel-MAR destroyed by combined player+ai-1 fire — but the damage to Earth is done. |
| 492 | ai-3 freighter `Caravan` arrives at Earth. |
| 496 | **Earth City destroyed.** Player now has 0 settlements. |
| 544 | `Bulwark` (ai-3 frigate) destroyed; `Hauler` (player freighter) destroyed at Earth. |
| 545 | ai-1 `Hammer` destroyed at Mars (ai-1 vs ai-3 cross-fire). |
| 591 | ai-1's `Vanguard-OUT`/`Sentinel-OUT` finally destroyed at Mercury. |
| 795 | **Last player ship (`Scirocco`) destroyed** by `Earth Outpost` + ai-3 `Bulwark`. **Player has 0 ships, 0 settlements.** |
| 800 – 7311 | Player idle. No event in the log changes the player's state. AI factions stop researching, stop expanding. Tick keeps incrementing. No victory. |

---

## Bug list

### BUG-1 — Faction name pool decoupled from capital body

`src/state/singlePlayerSetup.ts:151-159` assigns the name `SP_FACTION_NAMES[(i+1) % …]` *before* the capital body is decided in lines 184-191 (random unclaimed fallback). The result is "Mars Combine" can spawn on Venus, "Solar Directorate" on Mercury, etc., and the starter ship naming (`${spec.baseName}-${f.name.slice(0,3).toUpperCase()}`) gives you `Vanguard-MAR` orbiting Venus.

**Fix sketch:** generate ship names from the *capital body name* instead of the faction name, or pick a faction name that matches the chosen capital after the random fallback.

### BUG-2 — BUILD buttons hide fuel cost

`src/components/BuildPanel.tsx` (or wherever the build buttons render their cost) shows `30O 25C` for a frigate but the real cost is `{fuel:20, ore:30, credits:25}`. Verified by deducting 200→180 fuel after one frigate build with no other fuel consumption mid-tick.

**Fix:** add the fuel prefix to the button label, or display all four resources consistently (matching the `SHIPYARD` headers in the panel: `FUEL / GOLD / METAL / SCI`).

### BUG-3 — Body ownership ≠ settlement ownership

At T+1329 I logged it explicitly: Earth's `body.ownedBy === 'player'` while `player` had zero settlements there, and ai-3 had a "Earth Outpost" city extracting on the body. Body ownership only flips at game seeding (in `setupSinglePlayer`) — it doesn't track settlement losses or captures.

This bug is what masks BUG-4: ai-3 effectively owns Earth economically, but the game still thinks it's player territory.

**Fix:** recompute `body.ownedBy` each tick as the majority (or sole) settlement owner; flip to `undefined` if no settlements remain.

### BUG-4 — No defeat / victory condition

`status: 'active'` is set in `setupSinglePlayer` and never updated. The game runs forever. The TODO at the bottom of `singlePlayerSetup.ts` already notes "Tick-countdown victory was removed", but no replacement exists.

**Fix:** when a non-player faction has zero ships *and* zero settlements, mark them eliminated and skip their AI turn. When all non-player factions are eliminated → player victory. When the player is eliminated → defeat. Mount the existing `VictoryOverlay.tsx` for either.

### LOG-BUG-A — Every log entry is recorded twice

Strict (tick + level + category + msg + data) dedup of the export reduces 1594 entries to exactly 807. This is React 18 StrictMode running the gameContext effect twice in dev, causing every inline `logger.log(...)` to fire twice. The actual game state still advances only once per real tick — only the log is doubled.

**Fix options:**
- Move the logging out of the render-time effect into the reducer that actually mutates state.
- Or gate the logger with a `useRef`-tracked `lastLoggedTick` so the same (tick, msg) doesn't fire twice.

---

## UX issues

### UX-1 — TRANSFER button has hidden meaning

In the ShipPanel bottom sheet, two adjacent buttons say:
- **TRANSFER** — switches the map into "click a target body" mode. No visible hint that the map is now interactive in a new way, no banner, no overlay.
- **SHOW LIST** — opens the actual picker modal with `Mercury / Venus / Mars / …`.

A player tapping TRANSFER (the more inviting label) gets nothing visible. I had to read source to learn that SHOW LIST is the discoverable path.

**Fix:** when the map enters target-selection mode, render a banner like `"Tap a target body — or cancel"`. Or just merge the two buttons (TRANSFER opens the modal and offers a "Pick on map" link).

### UX-2 — Duplicate ship names in combat log

Two AI factions both built ships named `Hammer`, so combat lines read:
```
[COMBAT] Hammer hits Hammer for 6
```
Untangling who hit whom requires the faction's color or the ship id.

**Fix:** prefix the faction's `slice(0,3)` tag (the same one used in ship names) when logging combat — `Hammer/OUT hits Hammer/MAR for 6`.

### UX-3 — Frigate fuel cost surprise (paired with BUG-2)

Same root cause as BUG-2 above, but counts as UX too: the player can't tell what they're spending until they see the resource bar move.

---

## Balance observations

### BAL-1 — Player faces a 3-way colonization rush in the first 100 ticks

The opening AI script (visible in `aiActivityLog` at T+0) for every AI is:
```
[EXP] Solar Directorate: Hauler-SOL → Earth — send freighter to colonize Earth
[EXP] Outer Alliance: Hauler-OUT → Earth — (eventually)
[EXP] Mars Combine: Hauler-MAR → Earth — send freighter to colonize Earth
```

Three freighters converge on Earth between T+65 and T+151. The auto-combat cadence is 20 ticks (Earth City + Yards + Scirocco shoot back), but each incoming freighter is followed by escorting frigates (`Vanguard-SOL`, `Sentinel-SOL`, `Hammer`, `Vanguard-MAR`, …). A starting player has 2 settlements (200 HP + 100 HP) + 3 frigates, and that pool gets shredded before the player can plausibly research, scout, or counter.

For a "theoretically ready to play" SP mode, this is the central problem: **every AI's *opening* move targets the human's capital**, and they all succeed simultaneously.

**Fix ideas:**
- Stagger AI aggression: only 1 of N AIs goes for the human's capital in the first hundred ticks; the others build economy or attack each other.
- Make the human's capital have ≥ 1 starter frigate dedicated to defense (e.g., always keep 1 frigate orbiting the capital regardless of player orders, OR boost capital defenses for the player only).
- Reduce default starter ship count for AI (3 → 2) or buff player city HP.

### BAL-2 — AIs become inert after their opening

ai-2 (Solar Directorate) shrank to 1 ship + 2 settlements + 0 credits by T+562 and then sat at `"standing by"` indefinitely. The AI doesn't appear to know how to recover from a depleted economy. ai-3 sat at 385 science but never researched (researching: null on the snapshot). The game's late-game state is effectively *all four factions idle*.

### BAL-3 — Cross-AI attacks happen but don't resolve

At T+279 the two ai-3 frigates `Vanguard-MAR` + `Sentinel-MAR` arrived at Mars (ai-1's capital). They traded fire with `Vanguard-OUT` + `Sentinel-OUT` + `Hammer` + `Aegis` + Mars City + Mars Yards for ~200 ticks. The ai-3 attackers died but the AIs didn't follow up. After this single exchange, no AI ever attacked another AI again — they just sat in their home orbits.

---

## What worked well

- **Bezier transfer arcs** rendered correctly and the ETA / Δv math agreed with the panel.
- **Auto-combat** is reliably 20 ticks/cycle, fires for both sides, kills the right ship — no obvious math bugs in the engagements themselves.
- **The diagnostic logger** captured every relevant event (player actions, build completions, transfer arrivals, combat, tick snapshots) and the categorization made parsing easy. Apart from the double-fire, the design works as intended — I could reconstruct the match minute-by-minute from the file alone.
- **Resource economy** matched expectations: +6.3F / +6.0O / +4.0C per tick from city+station, accumulating linearly until settlements were destroyed.
- **Transfer planning UI** correctly disabled the current body in the picker, showed Δv + arrival tick, and the commit/cancel flow worked.

---

## Recommended next steps (priority order)

1. **Add defeat detection** so the game ends when the player or all AIs hit 0 ships + 0 settlements. (~30 min, unblocks all future playtests)
2. **Sync `body.ownedBy` with settlements** — once per tick or on settlement add/destroy. (~30 min)
3. **De-throttle the AI opening** — at most 1 of N AIs targets the player's capital before T+200. (~1–2 hrs, biggest balance lever)
4. **Fix log double-fire** — move logger calls out of StrictMode-affected effects. Painful to read traces while it's happening. (~1 hr)
5. **Add a fuel cost label on the BUILD buttons.** Trivial. (~10 min)
6. **Faction names vs capitals** — pick faction names *after* the capital is chosen, or strip the body name out of the ship suffix entirely. (~20 min)
7. **Disambiguate combat-log ship names** — prefix faction tag. (~20 min)
8. **Polish TRANSFER button discovery** — add a "tap a body" banner when target-selection mode is active. (~30 min)

Until #1–#3 land, single-player isn't really playable end-to-end: I lost the home base in under 800 ticks and nothing in the game told me the match was over.
