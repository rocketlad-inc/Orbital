# The Studio: recording videos of the game

The studio turns a written description of a shot into a video of the live game, in two steps:

1. A **scene** fills a private test game with empires, ships, cities, wars, fleets and orders.
2. A **shot** moves the camera over that game, runs ticks, puts words on screen, and records the map to an MP4.

Both are JSON. A person runs them from the **Studio** tab in the lobby (admins only) and the **Studio bar** on the map. An agent runs them from `scripts/studio.mjs`, or drives `window.__studio` directly in a browser. Same verbs, same files.

Nothing in the studio can touch a real game: scenes only apply to games flagged `is_test_game`, every row they write carries the `st_` mark, and `reset` deletes only rows with that mark.

---

## Quick start (agent)

```bash
# 1. Write the scene and the shot (examples below), then on staging:
node scripts/studio.mjs apply scene.json            # prints the game id and every ship id
node scripts/studio.mjs record <gameId> shot.json --out clip.mp4 --as studio-terra
node scripts/studio.mjs close <gameId>              # when the shoot is over
```

`apply` needs the agent key in `~/.orbital-staging-agent-key` (`~/.orbital-agent-key` with `--env production`). `record` opens the game in headless Chrome as the agent player `--as` (one of the scene's factions), plays the shot on a frame clock, and writes the video. Expect roughly 4× real time: a 30 s clip takes a couple of minutes, plus the server ticks the shot asks for.

Check the frames before sending anything: the first seconds and the last. `node scripts/studio.mjs record` prints the file; play it in headless Chrome or open it.

### Film mode: the Reddit way

`record` writes an MP4 inside the page with the hook, captions and end card, over the bare map. For the game as it is played, the way the showcase clips were made, use `film`: one PNG screenshot per frame on a stepped clock, encoded afterwards. Nothing can drop a frame, because the screenshot is the frame. Film keeps the interface (top bar, outliner, dock) in the shot; `"ui": false` in the shot drops it. Neither mode ever shows the painted debug readouts, the staging banner or the build badge.

```bash
node scripts/studio.mjs film <gameId> shot.json --out frames-dir --name earth-to-europa --as studio-terra
#   -> frames-dir/00000.png … + frames.json, then earth-to-europa.webp (30 fps) and .gif (15 fps) beside it
```

**Pace (Lorne, 2026-10-19: the 30 s cuts were "way too slow for marketing").** Showcase clips are 12–15 s at `"tempo": "fast"`: one tick per second of clip (the clock holds while the server ticks, so ticks cost no clip time), camera moves of 1.2–1.5 s, a panel held about 3.5 s, and the first tick inside the first half-second. `--speed 2` on `film` (or on `studio-encode.py`) time-lapses a take that is already filmed, every other moment, without re-shooting.

**Motion through ticks is smooth.** While filming, the director owns the tick the map draws at: each tick glides to the next over exactly the time until the next `tick` step, on the film's clock, so ships and worlds move at an even pace through every boundary (before 2026-10-21 the map stood still and jumped a tick at each one). Space `tick` steps evenly for even motion; a long gap between two ticks just means slower motion across it. Anything that still changes on a tick frame is the game resolving it: volleys, kills, the outliner. After the LAST `tick` step the world does not stop dead: that tick leaves at the same pace and slows to rest on its tick over twice the pace (so about 1.8 s after the last tick at the fast tempo). It does not keep gliding past it: the next tick has not been played, and nothing beyond it is known. A shot that runs on past the rest holds a still frame; `check` warns about it (`the world comes to rest at …`), so end the shot there or tick again. The camera is placed at the moment the map is drawn, so a followed ship stays put on screen as the world comes to rest (before 2026-10-23 the camera ran a frame behind, and the frame jumped once at the end of seven clips).

**Takes cannot hang any more.** A tick request gets 30 s, a frame 150 s, a screenshot three 30 s tries; past that the take ends and encodes what it has. The manifest (`frames.json`) is written every 30 frames, so even a killed take encodes.

Use a `16:9` shot with no `hook` or captions and `"endCard": false`. Default size 1920×1080 (`--size`), encoded at 960 px wide (`--width`). `--encode 0` keeps just the frames; `python scripts/studio-encode.py frames-dir --name NAME` encodes later. Budget about 10 minutes for a 30 s clip: half filming, half encoding.

## Quick start (person)

1. Lobby → **Studio** tab. Pick an example scene, edit it, **Validate**, then **Apply scene**. Leave "seat me as the viewer faction" ticked: you become that empire, so the game appears under My games and you see everything (the studio gives every faction Sensors 10).
2. Pick or edit a shot in the right-hand box, then **Open with the Studio bar →**.
3. On the map, the Studio bar floats top-right. **Preview** plays the shot live. **Record** writes the video and downloads it. **Tick +1 / +5** run server ticks. **UI** hides and shows the interface.

For a vertical (9:16) recording, the map is cropped to the centre of your window. A narrow browser window, or the CLI (which opens Chrome at 1080×1920), gives the sharpest result.

---

## The scene language

```jsonc
{
  "name": "Three-way at Earth, war at Titan",
  "game_id": null,                 // omit to create a new game; set to re-apply to one you made
  "tick_interval_ms": 3600000,     // new games only; the studio forces ticks anyway
  "reset": true,                   // wipe this scene's earlier rows before applying (default)
  "viewer": "terra",               // the faction the camera plays
  "seat_me": true,                 // Studio tab only: seat the signed-in admin as the viewer

  "factions": [
    { "key": "terra", "name": "Terran Directorate", "home": "earth",
      "color": "#4fc3f7", "color2": "#0b2a3d", "emblem": "star", "handle": "studio-terra" }
    // key: short slug used everywhere below. home: a start world (see catalog).
    // handle: the agent player's name, default studio-<key>.
  ],

  "wars": "all",                   // or pairs: [["terra","mars"], ["saturn","neptune"]]

  "worlds": [
    { "body": "luna", "owner": "terra", "living": true, "cities": ["Tycho"], "stations": 1 }
    // owner claims the world; living = terraformed (cities need it); up to 6 cities, 2 stations.
  ],

  "ships": [
    { "key": "terra_home", "owner": "terra", "at": "earth",
      "mix": { "destroyer": 4, "frigate": 5, "corvette": 4 },   // or "class": "destroyer", "count": 4
      "loadout": "mixed",          // default | kinetic | energy | mixed | ["kinetic","energy","shield","engine"]
      "hp": 1.5,                   // multiplier; 1.5 makes a fight last ~10 ticks, 4 makes it last an hour
      "prefix": "TDS",             // ship names: TDS DD-01, TDS FF-02 …
      "variant": "A",              // hull look A–Z
      "priority": "big" }          // the fleet's target order: big (capitals first), small, civilian, or a list
  ],

  "fleets": [
    { "key": "moon_wing", "owner": "terra", "name": "Lunar Wing", "ships": ["terra_moon"] }
  ],

  "research": [ { "faction": "all", "track": "industry", "level": 6 } ],   // sensors 10 is always added

  "orders": [
    { "type": "move",   "ships": "terra_moon", "to": "luna", "depart": "+1" },   // a group, or "group.3" for one hull
    // "arrive": "+40" lands it then by LEAVING LATER, on its real engine (see below)
    { "type": "strike", "ship": "md.0", "ready": "+2" },                        // Mega Destroyer over its world
    { "type": "trade",  "ship": "fr.0", "from": "mars", "to": "ceres" }         // freighter supply line
  ],

  "silos": [
    // A Missile Silo in the owner's city on a world (staging: the silo is not on production).
    { "world": "earth", "level": 3, "stock": 15, "auto": "fleets", "salvo": 3 }
    // auto: off | missiles (shoot down incoming salvos) | fleets (also fire at hostile groups
    // bound for this world, as soon as a salvo can catch them). Needs a war with the raider.
  ],

  "laws": [
    // Bills that already passed, in force from the tick the scene lands. The Senate tab
    // shows the settled vote and the law; combat and the economy obey it on the next tick.
    { "kind": "war_authorization", "target": "mars",      // Mars takes DOUBLE damage for 21 ticks
      "proposer": "terra", "yea": ["terra", "jove"], "nay": ["mars"] },
    { "slider": "combat_damage_multiplier", "value": 2 }  // a slider law for everyone: Stronger Guns, 2x damage
    // kinds: law (default; slider + value, optional target), war_authorization, trade_embargo,
    // production_sanction. ticks: how long (21 / 14 / 24 by default). title / summary: your own words.
    // Sliders are listed by the catalog (`sliders`): weapon damage, build cost, metal, credits, research, upkeep, tariff.
  ]
}
```

Times are `"+N"` ticks from now or an absolute tick. Classes: corvette, frigate, destroyer, freighter, colony, mega_destroyer, mobile_foundry. `loadout: "mixed"` rotates kinetic (tracers), energy (beams), flak and detonator mounts across a group so one fight shows every weapon.

What `apply` returns, and what you need from it:

- `game_id`: the game. Put it in `game_id` to re-apply or to add to the scene later.
- `factions[].handle`: the agent player to record `--as`.
- `ships.<group>`: the ids of every hull, in order. In shots they are `ship:<id>` with the game prefix stripped (the CLI prints them stripped already): `ship:st_terra_moon_0`.
- `fleets.<key>`: `fleet:<id>` targets, likewise.
- `orders[]`: for a move, the departure tick and arrival tick, so you know how many ticks the flight takes (and `asked`, the arrival you asked for, when you gave one).
- `warnings[]`: what the scene asked for that the game could not do as asked. Today: a move asked to `arrive` sooner than its trip allows, which leaves at once and lands as soon as it can. The CLI prints each one as `WARNING:`.

**`arrive` never slows a ship.** A hull always flies a move on the engine a player's order would give it. `arrive` is met by holding the departure back (it leaves at `arrive` minus its natural trip, never before `depart`); if even leaving at once cannot make it, it leaves at once and the warning says when it really lands. A group still flies together at its slowest hull's pace, the way guards are paced to freighters. (It used to stretch the burn to land on `arrive`, so a 16-tick hop asked to take 40 flew on a twentieth of its engine and crawled through the shot while everything else flew.)

`GET /api/admin/studio/catalog` (or `node scripts/studio.mjs catalog`) lists classes, loadouts, emblems and every world id, plus `megastructures` (kinds and costs) and `rogue_asteroids`.

### Set pieces (2026-10-23)

```jsonc
{
  "worlds": [
    { "body": "luna", "owner": "terra", "cities": ["Tycho"], "shields": 3 },
    // shields 1-10: Orbital Shields on every studio city here, pool full (level x shield_hp_per_level, 120 by default)
    { "body": "midas", "owner": "mars", "stations": 1, "thrusters": true }
    // thrusters: Trajectory Control Thrusters on the station; rogue asteroids only (midas, styx_rock,
    // iron_anna, black_sky, vagrant, augustin). Each apply puts the rock back on its orbit, ram cleared.
  ],
  "megastructures": [
    { "key": "ws", "kind": "weapons_station", "at": "luna", "owner": "terra", "progress": 0.9 }
    // kinds: warp_gate, weapons_station, gravity_sink, deep_array, null_field, mega_destroyer, mobile_foundry.
    // progress 0..1 of the catalogue cost (Senate price laws ignored), or "complete": true. "name" optional.
    // "orbit": 20, "angle": 200 -- where it orbits: map units from the world's centre (inside its sphere of
    // influence, clear of its surface, as a player may place one) and degrees round it on the tick the scene
    // lands. Without them it hangs on the gate ring (35% of the SOI: 61 units for Mars, off any frame that
    // shows Mars at a size worth seeing). Angles: 0 is +x, the way Deimos at 223 sits from Mars on tick 0.
    // The key names it like a world: ships "at": "ws", a move "to": "ws", a mid-take deliver.
    // A complete mega_destroyer / mobile_foundry launches as a hull on the next tick, as in play.
  ],
  "ships": [
    { "key": "fr", "owner": "terra", "at": "ws", "class": "freighter", "count": 1, "cargo": { "metal": 400, "gold": 300 } }
    // cargo: every hull of the group starts with this hold ("credits" works for gold). A freighter's real hold is 400.
  ],
  "orders": [
    { "type": "ram", "asteroid": "midas", "target": "mars", "depart": "+1" }
    // needs the thrusters world above; fired by its owner through the real handler. The result gives
    // depart, flip, arrive (impact tick) and metal_cost (topped up first, so the take spends nothing).
  ],
  "gates": "birth",
  // true: the Centauri gate already open. "birth": nothing pre-spawned; the omen starts on the next tick and the
  // game sends the first gate out of the Sun 6 ticks later (result: gate_birth). The second gate is pushed to the
  // dial's maximum (1000 ticks) so nothing else arrives mid-take. A fresh game only: once a gate is out, apply
  // without game_id to film the birth again.
  "kaiju": { "at": "europa", "charge_ticks": 4, "hp": 6000 }
  // The Leviathan parked at a terrestrial world, dwarf or moon (never a homeworld or capital), hunting it.
  // The next tick it winds up (and is revealed), charge_ticks later it strikes (default 24, the
  // kaiju_charge_ticks dial); hp overrides the roll from the game's fleets. Brings far systems and gates: true
  // with it (it leaves through its gate when full). Result: kaiju { winds_up_at_tick, fires_at_tick }.
}
```

**Nothing buried where the take happens.** Worlds roll hidden secrets when a game is made, and a parked hull finds one on the next tick. The obliterate clip (2026-10-23) parked its hulls on a Callisto that had rolled `pre_terraformed`: on tick 1 the raw moon turned into a living ocean world, and the strike armed to obliterate it stood down in silence at tick 7 (a Mega Destroyer fires the strike it was ordered, or none; a living world is sterilised, only a raw one is obliterated). Apply now empties the secrets of every world the scene lists, parks hulls at, watches from or sends a move to. `"secrets": true` at the top of a scene keeps them, for a clip about a find. A world marked `"living": false` is raw on every apply: a previous take's terraform, scar or debris field is cleared, as `living: true` already restored a living one.

**What the guns can do.** A city has no gun; shields absorb first (level × 120, regenerating 6 a tick), then 300 structure. Sixteen hulls do ~1,500 a tick and take a level-5 shield and its city in ONE tick (the shield-siege clip: the bubble was gone after frame one). Eight light hulls (4 frigates, 4 corvettes) do ~110: the shield holds five ticks, breaks on the sixth, and the city falls on the ninth. A Weapons Station fires three shots a tick, closest hulls first, 22.5 × (1 + 1.2 × (1 + 0.1 × Weapons)) each at the settlement's speed (50% on a destroyer, 26% on a frigate, 11% on a corvette): it shreds light hulls, scratches destroyers, and every hull it fires on shoots back at it. A capital in a tick-0 game has no defence: give the viewer's world a home fleet, or a raid takes it in a tick (cities are targeted only once no armed hull of the defender is left in orbit).

**Re-shooting a set piece.** `reset` takes away the last take's sites, its Leviathan (hull, row, once-only log lines; its faction stays and goes back to "Unknown") and its carcass, so the next take is announced again. Sites and the carcass are **retired** (`destroyed_at_tick`), never deleted: a deleted body takes every hull parked at it with it. Anything parked at a retired site drops to the world it orbited. A world marked `living` (and the Leviathan's world) is whole again: sterilised and obliterated scars cleared. A ram's target keeps its halved yields; use a fresh game if that shows.

**Mid-take orders** (`POST /api/admin/studio/games/:gameId/order`, a shot's `order` step), each answered with the game handler's own reply or refusal:

- `{ "type": "deliver", "ship": "st_fr_0", "site": "ws" }` hands the parked hull's hold to the site it sits at (a scene key, a site's template or its id). The last load finishes the structure.
- `{ "type": "launch", "world": "earth", "owner": "terra", "target": "mars", "count": 4 }` fires a salvo from that world's Missile Silo city (the owner's, or the first silo city there; seed it with `silos`). War to fire, as in play: someone you are at war with must be in that orbit.
- `{ "type": "ram", "asteroid": "midas", "target": "mars" }` rams now, from the rock's thrusters owner.
- `{ "type": "found", "ship": "st_cs_0", "kind": "warp_gate", "orbit": 18, "bearing": 90 }` (2026-10-23): the parked colony ship lays a megastructure's foundation, the player's own placement (`place-framework`): Construction Module on the hull (`"loadout": ["construction"]`), the research seeded (construction 4 and the kind's own: warp gate propulsion 6, gravity sink 7, foundry 8; weapons station weapons 7, mega destroyer 8; null field armor 7, deep array 8), the point inside the sphere of influence of the world it is parked at. `orbit` is map units from the world's centre; `angle` is degrees round it (0 = +x), or `bearing` degrees from the world's own heading (0 ahead, 180 trailing; the default, 90). Use `bearing`: supply legs fly in the Sun's frame, where Earth moves 11 units a tick, so the site's side of the world decides whether a leg takes 2 ticks or 4, and a bearing makes that the same in every game. The reply names the site (`mega_<random>`, "Warp Gate Site"); the colony hull is spent. The map plays a firework where it breaks ground.
- `{ "type": "supply", "ships": ["st_fr_0"], "from": "earth", "site": "last" }`: freighters on a standing supply run, the player's own route (`trade-routes/full`): loaded from the treasury at the dock `from` (a living world of theirs; seed `factions[].metal`/`gold`), poured into the site. `site`: `last` (the newest founded site, the default), a scene key, a template (`mega_warp_gate`) or an id. Up to 4 freighters a route (research permitting: propulsion 5). The route dispatches at once; the reply gives each hull's landing tick (`legs`). Lay one route per freighter a tick apart and their loads land on different ticks, so the site climbs a stage at each.

A successful order bumps the game's state version and the director refetches, holding the clock until the map has it: a founded site appears on the frame of its order, not at the next tick. In a shot, `site:<kind>` (or `site:`) is the newest founded site of that kind, the target for a site whose id the shot cannot know, and `orbit:<world>:<r>:<bearing>` is the point a `found` with that orbit and bearing uses (checked on production to the unit), so a `cursor` can click where the site will stand; a cursor click on an `orbit:` or `ship:` target is the ripple alone. Scenes can lay the same route at apply time: `{ "type": "supply", "ships": "fr", "from": "earth", "to": "yard" }` in `orders`, to a `megastructures` key (`progress: 0` starts a site empty). `reset` retires founded sites too.

**The construction clip** (2026-10-23; `sim/studioFound.mjs`, `npm run sim:studio-found`, and the same schedule on production through the real endpoints, tick for tick). Founding through the UI: the hand clicks the colony ship, `focusShip` opens its panel, the hand clicks *Lay a megastructure foundation* (`.megap__open`), the Warp Gate (`.megap__opt`), its look (`.megap__variant`), then the point (`orbit:earth:18:90`), where the `found` order lays it; `click .megac__cancel` ends the placement banner and `world site:warp_gate` opens the site's card (metal and credits climbing). A real map click would place the site at the DRAWN tick, which in a film runs ahead of the server's, and the bearing (and with it every leg) would drift. Warp gate 18 off Earth at bearing 90, founded at tick 0, three one-freighter routes laid after ticks 1, 2 and 3: loads land on ticks 4, 5, 6, 9, 10 (23, 46, 69, 91, 100%: one scaffold stage a load), complete on tick 10 (9 if two freighters drew a Quartermaster captain and carry 500).

The studio's tick calls make the room re-read the game's dials first, so the dials a scene sets (far systems, the Leviathan and its wind-up) are the ones its first tick runs on.

---

## The shot language

```jsonc
{
  "format": "9:16",                // 9:16 (TikTok/Shorts/Reels), 16:9, 1:1
  "fps": 30,
  "seconds": 34,                   // length before the 3 s end card
  "hook": "Three empires, one planet, and a war at Saturn",   // the white-box title, from frame one
  "speed": 2500,                   // milliseconds one tick glides over on screen (2500 battles, 1000 crossings)
  "endCard": true,                 // ORBITAL · Play free · orbital-empire.com
  "zoomBoost": 1,                  // extra zoom when cropping the map into the frame
  "ui": true,                      // keep the game's interface in the shot (film: default true; record: default false)
  "tempo": "fast",                 // the marketing cut: ticks glide over 900 ms, camera moves default to 1300 ms
  "steps": [
    { "at": 0,    "do": "focus",   "target": "earth", "px": 520 },        // cut: Earth 520 px across
    { "at": 0,    "do": "caption", "text": "Earth. Three fleets in orbit." },
    { "at": 0.5,  "do": "tick",    "n": 1 },                                // the clock holds while the server ticks
    { "at": 11,   "do": "zoom",    "px": 160, "ms": 2500 },                 // pull back, still on Earth
    { "at": 16,   "do": "zoom",    "scale": 0.012, "ms": 3000 },            // out to system scale
    { "at": 19.5, "do": "pan",     "target": "titan", "ms": 3500 },         // glide across the system, then hold Titan
    { "at": 23.5, "do": "zoom",    "target": "titan", "px": 520, "ms": 2500 },
    { "at": 26,   "do": "tick",    "n": 2 },
    { "at": 30,   "do": "follow",  "target": "fleet:st_fl_moon_wing" },     // centre tracks a moving fleet
    { "at": 31,   "do": "speed",   "ms": 1000 },
    { "at": 32,   "do": "ui",      "show": false }
  ]
}
```

**Targets** are a world id (`earth`, `luna`, `titan`, `sol`), `ship:<id>`, `fleet:<id>`, or `missile:<n>`: the nth missile salvo to appear during the shot (salvo ids carry their launch tick, so a shot cannot name one ahead). Once a salvo bursts it is gone and the camera holds where it was. Also `site:<kind>` (the newest founded construction site of that kind) and `orbit:<world>:<r>:<bearing>` (a point off a world, as a `found` order places one), and `mid:<a>|<b>`. A target is tracked while the camera holds it, so a moving fleet stays centred.

**Sizing.** `px` is how wide the target's world should be on the map canvas (a 1080×1920 canvas: 520 fills half the width; 160 shows the fight with room; 40 is a dot). `scale` is pixels per world unit when you want a raw number (measured on a 1920-wide frame): 0.5 is the default view (a planet and its moons); **0.15 shows the inner system out to Jupiter and Saturn, the right pull-back for a pan between planets**; 0.035 and below show every outer orbit and the Kuiper worlds, which is busy and makes the planets dots. Zooms ease in log space, so they feel even. When in doubt use `px` on a target and let the director work out the scale.

**Seeing everything.** The viewer sees every hull (Sensors 10), but a world's owner, cities and skyline are presence-fogged. The studio parks a quiet observer corvette for the viewer wherever a scene world would otherwise be fogged: at the planet for a moon (Jupiter for Europa), at an empty moon for a planet, never in the fight. `"camera": false` turns that off. A world the take only reaches by a mid-take order (a `gate` order's `then.to`) is not a scene world: list it under `worlds` with nothing else (`{ "body": "verdant" }`), or a cut to it lands in the fog of war, the whole frame dimmed until the hull's own sensors arrive and their edge sweeps across the shot (the colony clip, 2026-10-23). Far worlds are watched from a quiet moon too, never from their sun.

**Sun gates.** `gates: true` starts the take with the Centauri pair landed and open, its landing site retired, so the near end draws as the gate (not "LANDING SITE"). A `gate` order is the player's own crossing, and its flash plays on the gate when the next poll brings the crossing in, about when the hull leaves: hold the camera on the gate for a second after the order and `follow` the hull after that, or the flash plays off screen.

**Verbs:** `focus` (cut), `pan` (glide, then hold), `zoom`, `follow`, `tick`, `speed`, `caption`, `hook`, `ui`, `panel`, `click`, the story steps `intercept`, `strike`, `hull`, `skip`, and the close-up `hulls`.

**Long pans arc.** A `pan` whose target starts off the frame (at the zoom of either end) pulls back until both ends fit, travels while pulled back, and pushes in again, all inside its `ms`; a pan across the system at close zoom used to sail through seconds of empty starfield and arrive after the thing it was going to see had left. The travel is held to the zoom: until the top of the arc the start stays in frame (no further from the centre than the top puts it), and from the top on so does the target, so one end is always on screen (the three-way battle's pan to Titan left a third of a second of empty stars at each end before 2026-10-23). `"arc": false` keeps the straight glide. The arithmetic is `src/multiplayer/studio/shotPlan.ts` (tested in `shotPlan.test.ts`). Captions are the outlined white words; one at a time, each replaces the last.

**Story steps.** `{ "do": "intercept", "ships": "fleet:<id>", "target": "ship:<id>" }` sends the viewer's parked hulls to intercept a ship in flight with the game's own planner; they match it and fly its plan to its world, fighting it the whole way (transit combat). `__studio.interceptPlan(ships, target)` shows each hull's meeting tick without sending: a target on a fast cruise is only catchable as it brakes, so for a fight that lasts, intercept a ship on a long trip, from hulls whose engines are not much stronger than its own (an interceptor with three engine parts and high Propulsion research reaches a raid in a tick and makes no fight worth filming), or catch it as it brakes. `arrive` no longer slows a cruise. `{ "do": "strike", "ship": "st_mega_0", "ticks": 3 }` arms a Mega Destroyer over the world it has just reached (a strike armed in flight is cleared by the tick). `{ "do": "hull", "ship": "st_mega_0", "hp": 250 }` sets a hull's HP so the next tick's real combat finishes it on cue; fire distribution changes from take to take, so a scripted death needs it. A scene world marked `living` is restored on reset (sterilise scar cleared, settlements revived).

**Close-ups of a fight in flight.** A hull in flight draws a fixed size at every zoom (so does its formation spacing), and the clip is encoded 960 wide, so a camera zoom never makes a battle in flight bigger. `{ "do": "hulls", "scale": 2.2, "ms": 900 }` draws hulls in flight (and their spacing) that many times their size, eased; send `scale: 1` to ease back before the fleets land (parked hulls are not scaled). It resets at the shot's end. Hulls fighting side by side spread apart with it, so frame the fight on `mid:ship:<a>|ship:<b>` (the middle of both groups) rather than on one ship.

**Time cuts.** `{ "do": "skip", "ms": 2700 }` (film only) lets the map run that long with no frames kept, then carries on; steps after it keep their shot times. The first frame of a take and every hard cut (a `focus`, or a `pan`/`zoom` with `ms` of 40 or less, which is made as a cut) settle the same way for at least 300 ms, so no shot needs a tiny `skip` at 0 to look right on frame 0. Every cut forgets where each hull was drawn before it (an `advance` jumps a hull thousands of px, and the map used to slide it back across the jump through the skip, off the frame), then waits 1.5 s of real time for the art the new view asked for before the frame is kept. Arrivals are where the map is least continuous: a hull that lands holds where it last flew for 1.5 s (the roster dwell), then glides about 1.2 s into its place in orbit, and an in-flight hull draws much larger than a parked one, so an arrival filmed close up reads as a pop and ships hanging in space. Cut away just before the arrival tick, skip ~2700 ms, and land the cut on the world with the fight already in orbit. And never change the zoom during that settle: the held spot is fixed in the world while the layout scales with the zoom, so a zoom through it throws arrivals out into space and flies them in again. A `zoom` on the ship being followed keeps it centred (it used to ease from the old centre and lose a fast hull).

**Showing the interface.** `{ "do": "panel", "id": "senate" }` opens a panel the way a tap on the dock would: `senate`, `faction`, `comms` (tabs of the multiplayer dock, 360 px on the right), `trades`, `situation`, `eventlog`, `multiplayer`, `settlements`, `fleet`, `research`; `"id": null` closes whatever is open. `{ "do": "click", "selector": ".sp-disc.is-quiet > summary" }` clicks the first element a CSS selector finds, which is how a shot unfolds a disclosure (the Senate's resolved-bills list, then `.sp-roll > summary` for its ballots). Give a panel a second or so of clip time to load before clicking inside it. Keep the subject on the left two-thirds of the frame while a dock panel is open.

**Building on a world.** `{ "do": "world", "body": "earth" }` opens the world menu as a click on the planet would; it is up within a few frames. (Before 2026-10-23 it came up seconds late: the director's server waits put the whole page on the wall clock, and the menu's fade stamped its start seconds ahead of the film. Only the director's own waits read the wall clock now.) Then `{ "do": "cursor", "to": "css:[data-testid=\"wm-bhit-forge\"]", "click": true }` clicks the building on the limb (its card opens beside its tag) and `css:[data-testid="wm-card-go"]` clicks the card's BUILD, a real order. Buildings are research-gated exactly as in play, and a locked card's BUILD is disabled, so the click lands and nothing is ordered: seed the research in the scene (Forge needs Society, `"track": "industry"`, level 2; Lab 1, Mint 3). Before 2026-10-23 the world menu never appeared in a film at all: the film clock held every animation frame, the menu's fade-in among them (now only the map's own loop is held: `heldFrames.ts`). Check a selector with `node scripts/studio.mjs eval <game> "<js>" --size 1920x1080` before filming.

**Ticks during a shot.** `tick` asks the server for N ticks and waits for the map to receive them; the video clock stops meanwhile, so nothing is lost. Arrivals, kills and strikes happen on ticks, so place a `tick` where the action should land. The `speed` setting decides how long each tick's motion plays: with 2500, a ship that arrives on the next tick glides in over 2.5 s.

`Director.lint(shot)` (and the Studio bar) checks a shot's shape before it runs. `__studio.check(shot)` checks it against THIS game: a `strike` step scheduled before its Mega Destroyer has landed (the server refuses a strike in flight, so the clip ends on a world where nothing happens) is named with the tick step after which it could go. The CLI runs it before every `film` and `record` and prints `WARNING:` lines; `--strict` stops the take instead. A running shot notes the same lines in `__studio.log`.

---

## window.__studio

The director is on `window.__studio` whenever an admin, or an agent player in a studio game, has the game open. Use it from a browser console or over the DevTools protocol:

```js
__studio.focus('earth', { px: 500 });       // cut
__studio.pan('titan', { ms: 3000 });        // glide
__studio.zoom({ px: 160, ms: 2000 });
__studio.follow('ship:st_terra_moon_0');
__studio.ui(false);                         // map only
__studio.speed(2500);                       // ms per tick on screen; null restores
await __studio.ticks(2);                    // server ticks, resolves when the map has them
await __studio.preview(shot);               // play live
const blob = await __studio.record(shot, { download: true });   // or false, then __studio.blobChunk(i)
__studio.progress; __studio.result; __studio.log;
```

`record` swaps the page's clock (Date.now, performance.now, requestAnimationFrame) for one it advances a frame at a time, so a slow machine produces the same video as a fast one. Nothing else on the page needs to know.

---

## Worked example: the shot that started this

> A three-way battle around Earth, with some ships fleeting to the Moon. Multiple weapon types on display, then smoothly zoom out, pan across the system, and show two fleets battling over Titan.

Scene: `three_way_earth_and_titan` in the catalog examples. Five empires; Terra, Mars and Jove at war with each other over Earth, Saturn and Neptune at war over Titan; a Terran wing fleeted and ordered to Luna on the next tick; `loadout: "mixed"` so beams, tracers, flak and mines all fire.

Shot: `earth_then_titan` in the Studio bar's examples (`src/multiplayer/studio/shotExamples.ts`). Earth at 520 px for three ticks of fighting, a pull-back as the wing leaves for the Moon, a zoom to system scale, a 3.5 s pan to Titan, a push in, two ticks of the second fight, end card.

```bash
node scripts/studio.mjs apply scene.json          # scene.json = the example, edited
node scripts/studio.mjs record <id> shot.json --out earth-titan.mp4 --as studio-terra
```

---

## Tips

- **Hull HP.** Stock hulls die in two or three ticks under a dozen guns. `hp: 1.5` gives a fight that lasts the clip; `hp: 4` for a siege that must still be running tomorrow.
- **Kills on camera.** A tick resolves damage. Put a `tick` 0.5 s after the fight is framed, then every 4 s; the `speed` of 2500 means each volley's motion fills those seconds.
- **A fleet in flight.** Ships launch on the tick after `depart`. Use `follow` with `fleet:<id>` and `speed: 1000` to watch a crossing; the flight time is in the `orders[]` result.
- **The Moon hop** is about 20 ticks; Mars–Earth about 16; Earth–Titan over 60. Shoot the departure and the arrival, not the middle.
- **Re-shooting.** Re-apply the same scene with `game_id` set: `reset` clears the last attempt's rows and seeds again at the current tick.
- **Staging vs production.** Staging is the default. On production the studio makes the same private test games (hidden from Browse, not counted anywhere); close them when done.
- **Frame rate.** Recording is deterministic, so leave `fps` at 30. Headless Chrome draws a busy battle in 50–250 ms a frame; that is why the clip takes minutes and comes out smooth.
- **What the recording contains.** `record`: the map canvas alone, with the hook, captions and end card drawn in by the director. `film`: the page as played, interface and all (`ui: false` for the bare map).

## The suite so far, and shots worth making next

Made with this tool (scene + shot in `marketing/sol-wars-screenshots/gifs`, numbered):

- **Battle of Earth to battle of Europa** (18): three fleets at Earth, pull back to 0.15, glide to a lit Europa with two fleets fighting.
- **The Senate votes double damage** (19): Senate tab open on a passed "Stronger Guns for Terra" law and a war authorization on Mars, ballots unfolded, then the fight at Earth where Mars melts.
- **Three-way at Earth, war at Titan** (20): the shot that started the module, with the Lunar Wing leaving for the Moon.
- **Mega Destroyer sterilises Venus** (21): one hull, one world, the strike.
- **Supply line Mars to Ceres** (22): a freighter on a trade route, camera following the hull.

Worth making, and what each needs:

- **A fleet in flight, fighting** (transit combat): two fleets launched toward each other from Earth and Mars with `move` orders meet in the dark. Needs only a scene and `follow`; the game decides the meeting tick, so budget ticks from the `orders[]` arrival numbers.
- **The Moon hop, start to finish**: `follow fleet:` with `speed: 1000`, twenty ticks in thirty seconds. Scene-only.
- **Every weapon in one frame**: four groups each on one preset (kinetic, energy, flak, detonators) at hp 3 so nothing dies early. Scene-only.
- **An embargo, then a sanction**: `laws` with `trade_embargo` and `production_sanction`, Senate tab open, then the Faction tab showing the yields drop. Scene-only; the shot uses `panel`.
- **Research and the shipyard**: `panel research` and the Shipwright. The designer opens with the `orbital:open-ship-designer` event; a `click` on the dock's shipyard button does it today.
- **Terraforming a world**: eight stages. The scene sets `living` only; a stage-by-stage shot needs a `worlds[].terraform` level in the scene language (small server change) and one apply per stage, filmed as a cut sequence.
- **The Leviathan**: the world-eating squid on the second sun gate. Scene key `kaiju` (above) parks it at a world with a short `charge_ticks`.
- **A sun gate's birth**: `gates: "birth"` on a fresh game; the omen, then the gate out of the Sun.
- **A shield breaking, a ram, a site finished**: `worlds[].shields`, `worlds[].thrusters` + a `ram` order, `megastructures` + `cargo` + a mid-take `deliver`.
- **Through a sun gate to Centauri**: far systems and the galaxy view. Needs the scene to enable far systems on its game (scripts/enable-far-systems.mjs does it for running games) and a `zoom` past galaxy scale; the drawers are safe at that distance.
- **Missile silo**: silo on a world, salvo on the map. New feature on `dev`; needs a `worlds[].silo` seed and a `launch` order in the scene language.
- **Discovery: a derelict found**: an observer hull lights a world and finds a ship. It already happens (the card is hidden while filming); a shot that keeps the card needs `ui` to allow it, so add a `cards: true` shot flag before filming this one.
- **Captain debut and the trophy case**: the captain card on first kill, and the ending page's awards. Both UI; `click` reaches the first, the ending page needs the game to end (close the studio game with a winner: a server verb to add).

Keep each clip under 40 s, 16:9, interface in, no end card: the showcase cut.
