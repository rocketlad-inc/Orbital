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
   *  center-of-screen (used for intro / outro steps). */
  target: string | null;
  /** Which side of the target to place the card. Ignored when
   *  target is null. */
  placement: Placement;
}

export const TUTORIAL_STEPS: TutorialStep[] = [
  // === Orientation ==========================================
  {
    id: 'welcome',
    title: 'Welcome to Orbital',
    body: 'Build an interplanetary empire across the Sol system. Sixty-second tour of the major systems — hit Skip if you’d rather just play.',
    target: null,
    placement: 'center',
  },
  {
    id: 'victory',
    title: 'Three ways to win',
    body: 'SCIENCE — research every tech track to the top. MILITARY — destroy every rival settlement. ENGINEERING — finish the Dyson Sphere around the sun. Pick a path; the rest of the game answers to that choice.',
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

  // === Top bar ==============================================
  {
    id: 'resources',
    title: 'Your treasury',
    body: 'Fuel, ore, credits, science — everything you spend comes from here. The +X/t line is what your settlements deposit per tick. Without a collector, those harvests pile up and never reach you.',
    target: 'topbar-resources',
    placement: 'below',
  },

  // === Outliner =============================================
  {
    id: 'outliner',
    title: 'Your holdings',
    body: 'Every body and ship you own, grouped by location. HP dots show damage at a glance, ⛽ flags low fuel, ★ marks bodies you control. Click any row to focus the map.',
    target: 'outliner',
    placement: 'left',
  },

  // === Body inspector =======================================
  {
    id: 'select-body',
    title: 'Inspect a body',
    body: 'Click any body — here in the Outliner or out on the map — to open its inspector. We’ve opened one of yours for you.',
    target: 'outliner',
    placement: 'left',
  },
  {
    id: 'body-production',
    title: 'What this body yields',
    body: 'Every body advertises what it can produce per harvest. Rich bodies are worth fighting for; barren rocks aren’t. Those yields only start flowing once you settle here.',
    target: 'body-production',
    placement: 'right',
  },
  {
    id: 'deploy-buttons',
    title: 'Found a city or station',
    body: 'Send a freighter into orbit, then deploy. Cities harvest the body and host labs. Stations build ships, mount guns, and can host the Dyson foundation if they’re at Sol.',
    target: 'deploy-buttons',
    placement: 'above',
  },
  {
    id: 'collector-button',
    title: 'Plug it into the network',
    body: 'Income from a settlement only reaches your treasury through a collector. Your first one comes free with your starting city; every new settlement needs its own.',
    target: 'collector-button',
    placement: 'right',
  },
  {
    id: 'buildings-strip',
    title: 'Upgrade buildings',
    body: 'Cities take FORGE (more ore), MINT (more credits), LAB (more science). Stations take WEAPONS (heavier guns) and SHIPYARD (more parallel builds). Costs ramp with every level.',
    target: 'buildings-strip',
    placement: 'right',
  },
  {
    id: 'dyson-sphere',
    title: 'Dyson Sphere · Engineering Victory',
    body: 'At a Sol-orbit station you can lay the megaproject foundation. Park freighters at Sol to pipe fuel, ore, credits, and science into it every tick. Fill all four targets and you win — but enemies who blow up the foundation collapse the whole project.',
    target: 'dyson-sphere-section',
    placement: 'above',
  },

  // === Ship panel ===========================================
  {
    id: 'select-ship',
    title: 'Inspect a ship',
    body: 'Click any of your ships — here in the Outliner or out on the map — to open its panel. We’ve opened one for you.',
    target: 'outliner',
    placement: 'left',
  },
  {
    id: 'ship-stats',
    title: 'Hull and tank',
    body: 'Class, HP, fuel, and where the ship currently is. Parked at any of your settlements? It quietly repairs and refuels each tick. Run dry mid-burn and the ship drifts dead until someone tows it home.',
    target: 'ship-stats',
    placement: 'right',
  },
  {
    id: 'ship-combat-record',
    title: 'Veterancy',
    body: 'Every confirmed kill bumps this ship’s rank — +1% damage and +1% HP per rank, no cap. The combat record below lists who it’s killed and where. A veteran is worth pulling back to heal rather than losing.',
    target: 'ship-combat-record',
    placement: 'right',
  },
  {
    id: 'ship-fleet-section',
    title: 'Fleets',
    body: 'Group several ships into a fleet to move them as one — a transfer ordered for any member sweeps the whole group along. Form, leave, or disband from this panel.',
    target: 'ship-fleet-section',
    placement: 'right',
  },
  {
    id: 'transfer',
    title: 'Plan a transfer',
    body: 'TRANSFER drops you into target-pick mode. Click a destination body to draw a dashed preview arc. Nothing’s spent yet — re-pick or cancel as much as you want.',
    target: 'ship-transfer-button',
    placement: 'above',
  },
  {
    id: 'commit',
    title: 'Lock it in',
    body: 'COMMIT spends the fuel and schedules the burn. The ship slides along the curve from departure to arrival. You can still cancel any time before it fires.',
    target: 'ship-commit-button',
    placement: 'above',
  },
  {
    id: 'ship-maneuver',
    title: 'Orders queue',
    body: 'Every committed burn shows here with Δv, ETA, and a cancel button. Chain legs to set long routes — queue Earth→Mars→Jupiter and the ship auto-launches each leg as the previous one lands.',
    target: 'ship-maneuver-section',
    placement: 'right',
  },

  // === Big systems on the top bar ===========================
  {
    id: 'build',
    title: 'Fleet · Military Victory',
    body: 'Open the shipyard manager here. Pick a class — corvette, frigate, destroyer, freighter — and queue it at one of your stations. Combat fleets are how you take rival settlements.',
    target: 'nav-fleet',
    placement: 'below',
  },
  {
    id: 'research',
    title: 'Research · Science Victory',
    body: 'Seven tech tracks, capped at level 10 each. Filling every track wins you the Science Victory. Early levels are cheap and you’ll fly through them; the last few are punishing.',
    target: 'nav-research',
    placement: 'below',
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
    title: 'Save, load, settings',
    body: 'The logo in the top-left opens save/load and game settings. Restart Tutorial lives in here too if you ever want to see this again.',
    target: 'menu-button',
    placement: 'below',
  },
  {
    id: 'done',
    title: 'Pick your path',
    body: 'That’s the tour. Decide whether you’re going for Science, Military, or the Sphere — and start building. Tooltips on hover explain everything else.',
    target: null,
    placement: 'center',
  },
];

/** Total step count, exposed so TutorialProvider can size its index
 *  without importing the steps array (provider should stay generic). */
export const TUTORIAL_STEP_COUNT = TUTORIAL_STEPS.length;
