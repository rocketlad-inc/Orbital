// ============================================================
// Tutorial steps — declarative walkthrough of the major systems.
//
// Each step targets a UI element via data-tutorial-id and shows
// a coachmark card. The overlay (src/components/TutorialOverlay.tsx)
// reads this array, finds the target via document.querySelector,
// positions the card adjacent to it, and dims the rest.
//
// Adding a step:
//   1. Add an entry below with a unique id + the target's
//      data-tutorial-id (or null for center-of-screen steps).
//   2. Make sure the target element has the matching
//      data-tutorial-id attribute somewhere in the component tree.
//   3. Pick a placement so the card doesn't overlap the target.
//
// Voice notes (be ruthless when editing copy):
//   - Each body is one or two sentences, max. The card is a
//     glance, not a manual. Players who want depth will find it
//     in the UI's hover tooltips.
//   - Lead with the WHY (what the player gets out of this) before
//     the HOW (which button does what). "Stockpile only reaches
//     your pool through a collector" beats "click + COLLECTOR to
//     build a logistics endpoint."
//   - Avoid in-house jargon — "L3 diminishing returns" reads
//     fine to us but lands as gibberish on a new player.
//
// Auto-open behavior:
//   The 'select-body' and 'select-ship' steps have a side effect —
//   TutorialOverlay auto-selects the player's first owned body /
//   ship when those steps become active, so the BodyInspector /
//   ShipPanel are actually mounted by the time the following
//   deep-dive steps need to anchor inside them. If a panel can't
//   open (the player has none), the deep-dive steps degrade to
//   centered fallback cards.
// ============================================================

export type Placement = 'above' | 'below' | 'left' | 'right' | 'center';

export interface TutorialStep {
  id: string;
  /** Short title shown in bold at the top of the coachmark. */
  title: string;
  /** Body text — one to two sentences. Plain string, no markdown. */
  body: string;
  /** data-tutorial-id of the element to point at. null means
   *  center-of-screen (used for intro / outro steps). The card is
   *  positioned relative to this primary target. */
  target: string | null;
  /** Additional elements to cut out of the backdrop. They get the
   *  same un-dimmed treatment as `target` but don't influence the
   *  card position. Useful when a step refers to two places at
   *  once — e.g. the select-body step explains "click in the
   *  Outliner" while also wanting the freshly-opened BodyInspector
   *  to stay readable. Missing anchors are silently skipped. */
  extraTargets?: string[];
  /** Which side of the primary target to place the card. Ignored
   *  when target is null. */
  placement: Placement;
}

export const TUTORIAL_STEPS: TutorialStep[] = [
  // === Orientation ==========================================
  {
    id: 'welcome',
    title: 'Welcome to Orbital',
    body: 'Build an interplanetary empire across the Sol system — in real time, one tick an hour, running whether you’re watching or not. Quick tour of the major systems; hit Skip if you’d rather just play.',
    target: null,
    placement: 'center',
  },
  {
    id: 'victory',
    title: 'Three ways to win',
    body: 'CHANCELLOR — get the senate to elect you. DOMINATION — own more than 60% of the worlds on the map. ENGINEERING — finish the Dyson Sphere around the sun. Pick a path; the rest of the game answers to that choice.',
    target: null,
    placement: 'center',
  },
  {
    id: 'map',
    title: 'Reading the map',
    body: 'Drag to pan, scroll to zoom, double-click any body to follow it. What your sensors can see is in full colour; what they can’t is dimmed.',
    target: null,
    placement: 'center',
  },
  {
    id: 'world-menu',
    title: 'The map IS the menu',
    body: 'Click a world you own and its menu opens right on the map — build ships, upgrade buildings, deploy a collector, rename things. Almost everything you do starts by clicking a world.',
    target: null,
    placement: 'center',
  },

  // === Top bar ==============================================
  {
    id: 'resources',
    title: 'Your treasury',
    body: 'Metal builds, credits pay, science researches. The +X/t rate is NET — settlement income minus your fleet’s per-tick upkeep. If the treasury runs dry, the fleet goes into ARREARS and fights at −25% damage until you’re solvent again.',
    target: 'topbar-resources',
    placement: 'below',
  },

  // === Outliner =============================================
  {
    id: 'outliner',
    title: 'Your holdings',
    body: 'Every body and ship you own, grouped by location. HP dots show damage at a glance; ★ marks bodies you control. Click any row to focus the map.',
    target: 'outliner',
    placement: 'left',
  },
  {
    id: 'situation-report',
    title: 'The Situation Report',
    body: 'Your inbox for the whole war: what’s in combat NOW, what needs a decision, what’s sitting idle. Every row is a link — click it and the game takes you straight to the problem.',
    target: null,
    placement: 'center',
  },

  // === Economy ==============================================
  {
    id: 'collector',
    title: 'Plug worlds into the network',
    body: 'A settlement’s income only reaches your treasury through a collector — without one it banks locally at the settlement. Deploy collectors from the world menu, or send freighters to haul stranded stockpiles home.',
    target: null,
    placement: 'center',
  },
  {
    id: 'buildings',
    title: 'Upgrade buildings',
    body: 'Cities take FORGE (metal), MINT (credits), LAB (science) — yields compound with every level. Stations take WEAPONS (return fire) and SHIPYARD (parallel builds). Costs ramp; deep levels stay worth buying.',
    target: null,
    placement: 'center',
  },

  // === Ship panel ===========================================
  {
    id: 'select-ship',
    title: 'Inspect a ship',
    body: 'Click any of your ships — here in the Outliner or out on the map — to open its panel. We’ve opened one for you.',
    target: 'outliner',
    extraTargets: ['ship-panel'],
    placement: 'left',
  },
  {
    id: 'ship-stats',
    title: 'Hull and status',
    body: 'Class, HP, loadout, and what the ship is doing right now. Parked at a friendly station? It quietly repairs each tick — damaged ships even have a one-tap “send to shipyard” order.',
    target: 'ship-stats',
    placement: 'right',
  },
  {
    id: 'ship-combat-record',
    title: 'Veterancy and captains',
    body: 'Kills raise rank — more damage, more hull. Captains carry the rank and their own traits; lose the ship and the captain may survive to be rescued. A veteran is worth pulling back to heal rather than losing.',
    target: 'ship-combat-record',
    placement: 'right',
  },
  {
    id: 'ship-fleet-section',
    title: 'Fleets',
    body: 'Group ships into a fleet to move them as one — a transfer ordered for any member sweeps the whole group along. Form, leave, or disband from this panel.',
    target: 'ship-fleet-section',
    placement: 'right',
  },
  {
    id: 'transfer',
    title: 'Plan a transfer',
    body: 'MOVE TO TARGET lets you click a destination on the map; CHOOSE FROM LIST picks from a menu. Either way you get a preview arc first — nothing is committed yet.',
    target: 'ship-transfer-button',
    placement: 'above',
  },
  {
    id: 'commit',
    title: 'Lock it in',
    body: 'COMMIT schedules the burn — transfers are free, the cost is TIME. The ship slides along the curve from departure to arrival, and you can cancel any time before it fires.',
    target: 'ship-commit-button',
    placement: 'above',
  },
  {
    id: 'ship-maneuver',
    title: 'Orders queue',
    body: 'Every committed burn shows here with an ETA and a cancel button. Chain legs to set long routes — the ship auto-launches each leg as the previous one lands.',
    target: 'ship-maneuver-section',
    placement: 'right',
  },

  // === Big systems ==========================================
  {
    id: 'designer',
    title: 'The Ship Designer',
    body: 'Design your own hulls: drag parts onto sockets — kinetic chews armor, energy melts shields — and watch the ship grow the hardware. Duplicates of a part cost more each time, and every hull bills per-tick upkeep. Saved designs can refit ships already flying, for a fee.',
    target: null,
    placement: 'center',
  },
  {
    id: 'build',
    title: 'Shipyards · rush jobs',
    body: 'Queue ships at any world where you hold a settlement. In a hurry? The ⚡ RUSH button pays the ship’s price again to halve the remaining build time — with a 25% chance the yard cuts corners and delivers it at half hull.',
    target: 'nav-fleet',
    placement: 'below',
  },
  {
    id: 'research',
    title: 'Research',
    body: 'Six tracks, ten levels each. Research unlocks hulls, weapons, buildings, senate powers, and — through Sensors — how much of your rivals you can even see. It doesn’t win the game by itself; it decides what you fight with.',
    target: 'nav-research',
    placement: 'below',
  },
  {
    id: 'senate',
    title: 'The Senate · Chancellor Victory',
    body: 'Propose bills that bend the rules for everyone — build costs, upkeep, combat damage — with votes weighted by worlds held. The Chancellor bill IS a win condition, and each faction only ever gets ONE attempt at it.',
    target: null,
    placement: 'center',
  },
  {
    id: 'dyson-sphere',
    title: 'Dyson Sphere · Engineering Victory',
    body: 'Lay the foundation at a Sol-orbit station (deep Construction research), then park freighters at Sol — each one pumps metal, credits, and science from your treasury into the sphere every tick. Enemies can shoot the progress right back off it.',
    target: null,
    placement: 'center',
  },
  {
    id: 'settlements',
    title: 'Settlements panel',
    body: 'Empire-wide view of every city and station — yields, stockpiles, building queues. Quickest way to spot a settlement leaking income because you forgot to drop a collector.',
    target: 'nav-settlements',
    placement: 'below',
  },

  // === Side controls ========================================
  {
    id: 'layers',
    title: 'Map layers',
    body: 'Toggle overlays — transfer arcs from every faction, incoming hostile trajectories, body ownership rings. Turn them on when the map gets busy.',
    target: 'layers-button',
    placement: 'left',
  },
  {
    id: 'menu',
    title: 'Menu and settings',
    body: 'The logo in the top-left opens settings and account controls. Replay Tutorial lives in here too if you ever want to see this again. The game saves itself — it’s running on the server whether you’re here or not.',
    target: 'menu-button',
    placement: 'below',
  },
  {
    id: 'done',
    title: 'Pick your path',
    body: 'That’s the tour. Win the senate, own the map, or cage the sun — and remember the game keeps moving while you’re gone. Tooltips on hover explain everything else.',
    target: null,
    placement: 'center',
  },
];

/** Total step count, exposed so TutorialProvider can size its index
 *  without importing the steps array (provider should stay generic). */
export const TUTORIAL_STEP_COUNT = TUTORIAL_STEPS.length;
