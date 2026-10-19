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
      "variant": "A" }             // hull look A–Z
  ],

  "fleets": [
    { "key": "moon_wing", "owner": "terra", "name": "Lunar Wing", "ships": ["terra_moon"] }
  ],

  "research": [ { "faction": "all", "track": "industry", "level": 6 } ],   // sensors 10 is always added

  "orders": [
    { "type": "move",   "ships": "terra_moon", "to": "luna", "depart": "+1" },   // a group, or "group.3" for one hull
    { "type": "strike", "ship": "md.0", "ready": "+2" },                        // Mega Destroyer over its world
    { "type": "trade",  "ship": "fr.0", "from": "mars", "to": "ceres" }         // freighter supply line
  ]
}
```

Times are `"+N"` ticks from now or an absolute tick. Classes: corvette, frigate, destroyer, freighter, colony, mega_destroyer, mobile_foundry. `loadout: "mixed"` rotates kinetic (tracers), energy (beams), flak and detonator mounts across a group so one fight shows every weapon.

What `apply` returns, and what you need from it:

- `game_id`: the game. Put it in `game_id` to re-apply or to add to the scene later.
- `factions[].handle`: the agent player to record `--as`.
- `ships.<group>`: the ids of every hull, in order. In shots they are `ship:<id>` with the game prefix stripped (the CLI prints them stripped already): `ship:st_terra_moon_0`.
- `fleets.<key>`: `fleet:<id>` targets, likewise.
- `orders[]`: for a move, the departure tick and arrival tick, so you know how many ticks the flight takes.

`GET /api/admin/studio/catalog` (or `node scripts/studio.mjs catalog`) lists classes, loadouts, emblems and every world id.

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

**Targets** are a world id (`earth`, `luna`, `titan`, `sol`), `ship:<id>` or `fleet:<id>`. A target is tracked while the camera holds it, so a moving fleet stays centred.

**Sizing.** `px` is how wide the target's world should be on the map canvas (a 1080×1920 canvas: 520 fills half the width; 160 shows the fight with room; 40 is a dot). `scale` is pixels per world unit when you want a raw number: 0.5 is the default view (a planet and its moons), 0.05 shows a planet's neighbourhood, 0.012 shows the whole solar system out to the Kuiper belt in about a third of the frame. Zooms ease in log space, so they feel even. When in doubt use `px` on a target and let the director work out the scale.

**Verbs:** `focus` (cut), `pan` (glide, then hold), `zoom`, `follow`, `tick`, `speed`, `caption`, `hook`, `ui`. Captions are the outlined white words; one at a time, each replaces the last.

**Ticks during a shot.** `tick` asks the server for N ticks and waits for the map to receive them; the video clock stops meanwhile, so nothing is lost. Arrivals, kills and strikes happen on ticks, so place a `tick` where the action should land. The `speed` setting decides how long each tick's motion plays: with 2500, a ship that arrives on the next tick glides in over 2.5 s.

`Director.lint(shot)` (and the Studio bar) checks a shot's shape before it runs.

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
- **What the recording contains.** The map canvas alone: no panels, no bar, no browser. The hook, captions and end card are drawn into the video by the director.
