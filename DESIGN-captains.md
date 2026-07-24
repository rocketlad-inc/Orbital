# DESIGN — Captains

Status: **approved direction** (Lorne + Alante, 2026-07-24, voice call). Working
spec for the captain layer: a named, persistent officer attached to every ship,
scaffolded onto the EXISTING veterancy system rather than a new XP track.

Playtest drivers (Alante, 2026-07-24):
- "Why do I care about this ship? It's just another resource I'm building."
- "My biggest struggle is giving a damn about the things happening in the game
  and figuring out when to go back and check." — **and, crucially: "I *want* to."**
- "If my guy's the same as everybody else's, I don't care. My captain is unique,
  so I care more."
- Traits double as *direction*: "He's a good explorer → make it an exploratory
  corvette." When you're dropped in with no idea what to do, your captain tells you.

The retention problem is the point. Ships are fungible, so nothing pulls a player
back between ticks. A captain is a **person with a name who can die** — that is the
hook, not the stat bonus.

---

## 0. Hard constraints

- **Fully optional.** A player who never opens the captain UI must lose nothing and
  be nagged by nothing. Everything auto-generates; every field is edit-*able*, none
  is edit-*required*. No blocking modals, ever.
- **No uploaded images.** Custom avatar upload = Cloudflare storage cost + a
  moderation surface we're not staffing. Avatars are **code-shipped SVGs** (§4).
  Revisit post-launch.
- **Scaffold, don't fork.** Captains take over the existing `rank` /
  `combat_history` veterancy (worker/room.js kill-award pass, `rankDamageMul` /
  `rankHpMul` in src/game/techs.ts). No second progression system.

---

## 1. The entity

New per-game table `game_captains`:

| field | notes |
|---|---|
| `id`, `game_id`, `faction_id` | owner |
| `name` | auto-generated from a name bank; player-editable |
| `avatar_id` | one of the code-shipped SVG set (§4) |
| `bio` | auto-generated one-liner; player-editable, ~240 char cap |
| `rank`, `combat_history` | **moved off `game_ships`** (§2) |
| `traits_json` | 1–2 trait ids (§3) |
| `ship_id` | nullable — NULL means "in the bank", unassigned |
| `status` | `active` \| `lost` |
| `created_at_tick`, `lost_at_tick` | for the chronicle + memorial |

`game_ships` gains `captain_id` (nullable).

Name bank follows the existing `SHIP_NAME_POOLS` / `SETTLEMENT_NAME_POOLS` pattern
in src/game/ — a `CAPTAIN_NAME_POOLS` (given + surname lists, sci-fi flavored,
deduped against living captains).

---

## 2. Veterancy moves to the captain

Today: `game_ships.rank` grows +1 per kill and gives **+1% damage and +1% max HP
per rank** (`RANK_PER_KILL_MUL`). The ship owns it, so it dies with the hull.

New: **the captain owns the rank.** A ship's effective rank is its captain's rank;
a ship with no captain performs at rank 0. This is the whole emotional payoff — a
veteran who survives carries his record into the next hull.

- Kill-award pass (worker/room.js, `topAttackerShip` → `UPDATE game_ships SET rank`)
  redirects to the killer ship's captain.
- `rankDamageMul` / `rankHpMul` read the captain's rank. Because
  `effectiveShipMaxHp()` already composes rank × armor tech, this slots in cleanly
  (see the HP fix, 2026-07-24).
- **Migration is mandatory:** on rollout, mint one captain per existing active ship,
  carrying that ship's current `rank` and `combat_history`. Live games must not lose
  veterancy. Ships with rank 0 still get a captain (identity is the feature).

### 2.1 Death, survival, and stakes

On ship destruction, roll for the captain:

- **Base survival 25%.**
- **Modified by proximity to your own stations** — a captain lost next to a friendly
  yard is likely picked up; one lost deep in enemy space usually isn't.
  Suggested curve: `25% base`, `+35%` at/adjacent to a body with a friendly station,
  decaying with distance to a **5% floor** in unsupported space. (Reuse the
  nearest-friendly-station logic from src/game/repair.ts.)
- **Survived** → `ship_id = NULL`, back in the bank, full rank intact, reassignable.
- **Lost** → `status = 'lost'`. **Permanent.** Permadeath is what makes the roll
  matter; without it the 25% is a formality.

Both outcomes are **chronicled**, and this is the retention hook — these are exactly
the events worth a Discord/digest push (worker/discord.js, worker/digest.js):

> *"Captain Vela Ordoñez went down with the Osprey at Umbriel. 14 kills."*
> *"Captain Vela Ordoñez was recovered from the wreck of the Osprey."*

That line is the thing that makes someone open the game. It is the feature.

---

## 3. Traits — flavor and *direction*

A trait bank, each mapped to one ship aspect. Auto-rolled at generation (1 trait,
2 for a captain recovered above rank 10).

| trait | effect | reads as |
|---|---|---|
| Gunner | +% damage | line warship |
| Bulwark | +% max HP / mitigation | tank, hold the line |
| Wrench | +% repair rate | forward operations |
| Voidrunner | +% engine (travel time) | scout / rapid response |
| Pathfinder | +% sensor range | **explorer** |
| Quartermaster | +% cargo | trade / logistics |
| Colonist | cheaper/faster settlement founding | expansion |

Design rules:
- **Traits are multiplicative percentages; ship parts stay additive fittings.** They
  must not become a second parts system, and must not flatten the kinetic/energy
  counter-matrix (§2.1a of the identity-economy spec).
- **Keep them small** (~5–15%). A captain should *flavor* a hull, not out-scale the
  ship designer. Rank is the growth axis; traits are the personality.
- **Traits are the onboarding prompt** (Alante's point). The trait names a *job*, so
  a new player reads "Pathfinder" and knows to go look around. The **free starting
  ship ships with a Pathfinder captain deliberately** — the first lesson is
  "explore," taught by a person rather than a tooltip.

---

## 4. Avatars

- A code-shipped set of **~12 generic SVG portraits**, same pattern as
  `ShipIconVariant` A–F in src/components/ShipIcons.tsx (inline SVG, faction-tintable,
  zero storage cost, zero moderation surface).
- Placeholder-quality is fine for P0 — **Lorne is authoring the final art**; the
  contract is just "pick one of N ids."
- Rendered at: ship panel header, fleet rows, captain bank, chronicle entries.

---

## 5. UI

### 5.1 The naming moment (resolving the one real tension)

Alante wants a naming ritual per ship ("you gotta name his captain"). Lorne requires
it be skippable. Both are satisfiable — **offer, never block**:

- On ship launch, the existing launch chronicle entry names the captain
  ("…launched a corvette *Gust* under Captain Vela Ordoñez").
- A small, **dismissible** card on launch shows portrait + name + trait with an
  inline rename field. Ignore it and the auto-generated captain simply stands.
- No modal, no confirmation, no blocked build flow.

### 5.2 Captain Bank (new Fleet-panel option)

Fleet panel gains a **Captains** view alongside the existing `All / Player / Enemy`
filter chips:

- Roster: portrait, name, rank, trait, current ship (or **UNASSIGNED**).
- **Assign / reassign** a captain to any ship of yours lacking one; swap between ships.
- **Create ahead of time** — pre-stock the bank so future builds draw a captain you
  already made and named, instead of a fresh random one.
- **Memorial**: lost captains listed with final rank + how they died. Cheap to build,
  disproportionate emotional return.

### 5.3 Assignment on build

Ship completes → if the bank holds an unassigned captain, take the
**longest-waiting** one; otherwise generate fresh. (Player-created bank entries are
the "I planned this" path; generation is the zero-effort path.)

---

## 6. Sequencing

1. **P0 — identity + stakes.** Table, auto-gen (name/avatar/bio), attach on build,
   rank migration off ships, survival roll + permadeath, chronicle lines, ship-panel
   display. *This alone delivers Alante's ask.*
2. **P1 — Captain Bank.** Fleet-panel view, assign/reassign, create-ahead, memorial.
3. **P2 — Traits.** Trait bank + effects + the deliberate Pathfinder starter.
4. **P3 — Polish.** Final avatar art, bio editing UI, Discord/digest push on captain
   death & promotion.

Rationale: P0 is where the emotion lives and it's mostly server-side. Traits are
Alante's *direction* argument, so they precede art polish. Uploads stay out.

---

## 7. Decisions log

- **2026-07-24** — Captains own veterancy; ships no longer carry `rank`. A ship
  without a captain performs at rank 0.
- **2026-07-24** — Captain death is **permanent**; base survival 25%, improved by
  proximity to friendly stations, floor 5%.
- **2026-07-24** — **No user-uploaded avatars** (cost + moderation). Code-shipped
  SVG set only.
- **2026-07-24** — Everything auto-generates and is optional to touch; the naming
  moment is an offer, never a blocking prompt.
- **2026-07-24** — Traits are small multiplicative modifiers, deliberately weaker
  than ship-designer parts, and must not disturb the damage-type counter-matrix.
- **OPEN** — Should captains persist across games (account-level, like ship
  templates) or die with the match? Leaning per-game for now; a cross-game "hall of
  fame" is a natural follow-up.
- **OPEN** — Exact trait percentages, pending a balance pass against parts + tech.
