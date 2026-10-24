// ============================================================
// Tutorial steps — the guided FIRST HOUR, rebuilt interactive.
//
// Design rules (Lorne, 2026-08 tutorial overhaul — playtester Ben's
// "big ben mode tutorialization" feedback):
//   1. SHOW, don't tell. If a step explains a menu, that menu is OPEN
//      (the step's `onEnter` effect opens it before the card renders).
//   2. Any step without a menu on screen carries a `visual` — an
//      inline SVG illustration in the card (TutorialVisuals.tsx).
//   3. The player DOES the moves, not reads about them: `task` steps
//      gate NEXT on a real game-state condition (world menu opened,
//      upgrade queued, corvette built, ship sent, research started)
//      and auto-advance when it completes. Every task has a SKIP
//      escape hatch so nobody can hard-stuck the tour.
//
// Affordability contract: the task arc costs ≤60 metal + ≤16 credits.
// Fresh factions seed with 100 metal / 100 credits (worker/factions.js
// STARTING_RESOURCES), so a first-game player can always complete
// every task. Replaying players own at least a capital + ships, so
// the checks complete against whatever they already have.
//
// Each step targets a UI element via data-tutorial-id and shows a
// coachmark card. The overlay (src/components/TutorialOverlay.tsx)
// reads this array, finds the target via document.querySelector,
// positions the card adjacent to it, and dims the rest.
//
// Voice notes (be ruthless when editing copy):
//   - Each body is one or two sentences, max. The card is a glance,
//     not a manual.
//   - Lead with the WHY before the HOW.
//   - Task labels are imperative and specific: "Queue a FORGE
//     upgrade", never "try upgrading things".
// ============================================================

export type Placement = 'above' | 'below' | 'left' | 'right' | 'center';

/** Side effect the overlay runs when a step becomes active — the
 *  "if you're explaining a menu, the menu is open" rule. */
export type TutorialEffect =
  | 'open-capital-menu'    // selectBody(player capital) → world menu flies in
  | 'open-sol-menu'        // selectBody(sol) → the sun's menu (Dyson card)
  | 'select-first-ship'    // selectShip(first player ship) → ship panel mounts
  | 'open-panel-research'  // window 'orbital:open-panel' {panel:'research'}
  | 'open-panel-fleet'
  | 'open-panel-settlements'
  | 'open-designer'        // window 'orbital:open-ship-designer'
  | 'close-designer'       // window 'orbital:close-ship-designer'
  | 'close-panels'         // window 'orbital:open-panel' {panel:null}
  // The ship panel is tabbed, so an anchor can be mounted-but-hidden. A step
  // pointing at a control on another tab would cut a hole in the backdrop
  // around nothing, so steps that target one declare the tab they need and
  // the panel switches to it on entry. Same shape as the open-panel effects
  // above: fire a window event, let the owning component react.
  | 'ship-tab-orders'      // window 'orbital:ship-panel-tab' {tab:'orders'}
  | 'ship-tab-ship'
  | 'ship-tab-cargo'
  | 'ship-tab-log'
  // The trial track (TRIAL_TUTORIAL_STEPS): the private offers tab of the
  // trade dock (where a pact offer waits) and the empires panel.
  | 'open-panel-trades'    // window 'orbital:open-panel' {panel:'trades'}
  | 'open-panel-empires'   // window 'dockrail:set' {active:'multiplayer'}
  | 'close-dock'           // window 'dockrail:set' {active:null}: the right-hand docks
  | 'close-world-menu';    // window 'orbital:close-world-menu': the map back

/** Game-state condition a task step waits on. Evaluated by the overlay
 *  a few times a second; baselines are snapshotted at step entry so a
 *  replaying player's EXISTING queue/orders don't auto-complete the
 *  task — they have to do the thing now. */
export type TutorialCheckId =
  | 'world-menu-open-owned' // world menu open on a player-owned body
  | 'building-queued'       // a player settlement gained a building order
  | 'ship-queued'           // a player build order appeared in the yard
  | 'ship-selected'         // a player ship is selected (panel open)
  | 'transfer-committed'    // a player ship gained a maneuver order
  | 'research-started'      // a research project is running
  | 'pact-signed'           // the player gained a peace partner (a pact)
  | 'clock-running';        // a solo game's clock is running (not paused)

/** Inline SVG illustration key (TutorialVisuals.tsx). */
export type TutorialVisualId =
  | 'victory' | 'map-controls' | 'economy' | 'upkeep' | 'senate' | 'dyson' | 'herald' | 'expand'
  | 'terraform';

export interface TutorialStep {
  id: string;
  /** Short title shown in bold at the top of the coachmark. */
  title: string;
  /** Body text — one to two sentences. Plain string, no markdown. */
  body: string;
  /** data-tutorial-id of the element to point at. null means
   *  center-of-screen. */
  target: string | null;
  /** Additional elements cut out of the backdrop. Missing anchors are
   *  silently skipped. */
  extraTargets?: string[];
  /** Which side of the primary target to place the card. */
  placement: Placement;
  /** Effect(s) run when the step becomes active. An array runs in order —
   *  needed when a step must both open something AND switch to the tab its
   *  target lives on. */
  onEnter?: TutorialEffect | TutorialEffect[];
  /** Task gate: NEXT locks until `check` passes, then the step
   *  celebrates and auto-advances. `label` renders as the checklist
   *  line ("⬜ Queue a building upgrade"). */
  task?: { check: TutorialCheckId; label: string };
  /** Illustration for steps with no menu on screen. */
  visual?: TutorialVisualId;
  /** 'light': barely dim the screen, for steps played ON THE MAP (the
   *  player has to see the worlds to click one; Lorne, 2026-10-24: "screen
   *  is blacked out"). */
  dim?: 'light';
}

export const TUTORIAL_STEPS: TutorialStep[] = [
  // === Orientation ==========================================
  {
    id: 'welcome',
    title: 'Welcome to Orbital',
    body: 'Build an empire across the Solar System, in real time, one tick an hour.',
    target: null,
    placement: 'center',
    visual: 'map-controls',
  },
  {
    id: 'victory',
    title: 'Three ways to win',
    body: 'Win by Senate vote, by owning 60% of the worlds, or by finishing the Dyson Sphere.',
    target: null,
    placement: 'center',
    visual: 'victory',
  },

  // === Act 1: your homeworld =================================
  {
    id: 'open-world',
    title: 'Open your homeworld',
    body: 'Click your capital (★ in the Outliner, or the planet) to open its menu.',
    target: 'outliner',
    placement: 'left',
    task: { check: 'world-menu-open-owned', label: 'Open the menu on a world you own' },
    dim: 'light',
  },
  {
    id: 'world-readout',
    title: 'This is your base',
    body: 'OUTPUT/t is what this world earns every tick.',
    target: 'world-menu',
    placement: 'below',
    onEnter: 'open-capital-menu',
  },
  {
    id: 'terraform-status',
    title: 'Terraformed worlds pay; raw worlds hoard',
    body: 'Terraformed worlds send all their output home; raw worlds keep most of it.',
    target: 'terraform-section',
    placement: 'right',
    onEnter: 'open-capital-menu',
  },
  {
    id: 'terraform-how',
    title: 'Terraforming is a delivery',
    body: 'Claim a raw world with a station, then run a freighter route to it to terraform it.',
    target: null,
    placement: 'center',
    visual: 'terraform',
  },
  {
    id: 'queue-building',
    title: 'Upgrade something',
    body: 'Upgrade a building: FORGE makes metal, MINT credits, LAB science.',
    target: 'wm-columns',
    extraTargets: ['wm-columns-orbit'],
    placement: 'right',
    onEnter: 'open-capital-menu',
    task: { check: 'building-queued', label: 'Queue a building upgrade' },
  },
  {
    id: 'build-ship',
    title: 'Build a ship',
    body: 'Open SHIPYARD, then BUILD a CORVETTE: cheap, fast, and armed.',
    target: 'wm-build',
    placement: 'above',
    onEnter: 'open-capital-menu',
    task: { check: 'ship-queued', label: 'Queue a corvette at your shipyard' },
  },

  // === Act 2: your fleet =====================================
  {
    id: 'select-ship',
    title: 'This is a ship',
    body: 'Click one of your ships, in the Outliner or on the map.',
    target: 'outliner',
    extraTargets: ['ship-panel'],
    placement: 'left',
    onEnter: 'close-world-menu',
    dim: 'light',
    task: { check: 'ship-selected', label: 'Select one of your ships' },
  },
  {
    id: 'ship-stats',
    title: 'Hull and status',
    body: 'Its hull, loadout and orders; it repairs while parked at a friendly station.',
    target: 'ship-stats',
    placement: 'right',
    onEnter: ['select-first-ship', 'ship-tab-ship'],
  },
  {
    id: 'ship-veterancy',
    title: 'Captains and rank',
    body: 'Kills earn rank, and the captain keeps it.',
    target: 'ship-combat-record',
    placement: 'right',
    onEnter: ['select-first-ship', 'ship-tab-log'],
  },
  {
    id: 'send-ship',
    title: 'Send it somewhere',
    body: 'CHOOSE FROM LIST, pick a world, then COMMIT.',
    target: 'ship-transfer-button',
    extraTargets: ['ship-commit-button'],
    placement: 'right',
    onEnter: ['close-world-menu', 'select-first-ship', 'ship-tab-orders'],
    dim: 'light',
    task: { check: 'transfer-committed', label: 'Send a ship somewhere' },
  },
  {
    id: 'orders-queue',
    title: 'Orders queue',
    body: 'Your trip and its arrival; chain more legs to fly them in a row.',
    target: 'ship-maneuver-section',
    placement: 'right',
    onEnter: 'ship-tab-orders',
  },
  {
    id: 'fleets',
    title: 'Fleets move as one',
    body: 'Ships in a fleet move together.',
    target: 'ship-fleet-section',
    placement: 'right',
    onEnter: ['select-first-ship', 'ship-tab-ship'],
  },
  {
    id: 'expand',
    title: 'Claim more worlds',
    body: 'Fly a COLONY SHIP to a world and found a city or station to claim it.',
    target: null,
    placement: 'center',
    visual: 'expand',
  },
  {
    id: 'freighters',
    title: 'Freighters do the hauling',
    body: 'Freighters haul resources home, terraform worlds and deliver trades.',
    target: null,
    placement: 'center',
    visual: 'economy',
  },

  // === Act 3: the designer ===================================
  {
    id: 'designer',
    title: 'Design your own hulls',
    body: 'Drag parts onto your ship: shields stop kinetic, armor stops energy, engines add speed.',
    target: 'designer-canvas',
    extraTargets: ['designer-stats'],
    placement: 'right',
    onEnter: 'open-designer',
  },
  {
    id: 'designer-stats',
    title: 'The bill, before you pay it',
    body: 'The price and the upkeep this design costs every tick.',
    target: 'designer-stats',
    placement: 'left',
  },

  // === Act 4: research + economy =============================
  {
    id: 'research',
    title: 'Research decides what you fight with',
    body: 'Start a research project; science fills it automatically.',
    target: 'nav-research',
    placement: 'below',
    onEnter: 'open-panel-research',
    task: { check: 'research-started', label: 'Start (or queue) a research project' },
  },
  {
    id: 'upkeep',
    title: 'Fleets cost rent',
    body: 'Every ship costs upkeep each tick; an empty treasury cuts damage by 25%.',
    target: 'topbar-resources',
    placement: 'below',
    onEnter: 'close-panels',
    visual: 'upkeep',
  },

  // === Act 5: the wider war ==================================
  {
    id: 'senate',
    title: 'The Senate · Chancellor Victory',
    body: 'Senate bills change the rules for everyone, and electing a Chancellor wins the game.',
    target: null,
    placement: 'center',
    visual: 'senate',
  },
  {
    id: 'dyson',
    title: 'The Dyson Sphere · Engineering Victory',
    body: 'Even the Sun has a menu: build the Dyson Sphere here.',
    target: 'dyson-sphere-section',
    placement: 'below',
    onEnter: 'open-sol-menu',
    visual: 'dyson',
  },
  {
    id: 'situation-report',
    title: 'Your inbox for the war',
    body: 'The Situation Report lists what needs you now.',
    target: null,
    placement: 'center',
    visual: 'herald',
  },
  {
    id: 'done',
    title: 'You’ve already started',
    body: 'Your first moves are under way; the game keeps running.',
    target: null,
    placement: 'center',
    visual: 'victory',
  },
];

/** Total step count, exposed so TutorialProvider can size its index
 *  without importing the steps array (provider should stay generic). */
export const TUTORIAL_STEP_COUNT = TUTORIAL_STEPS.length;

// ============================================================
// THE TRIAL TRACK — Play for Free's first ten minutes (Lorne,
// 2026-10-24: "really think through a smooth transition and education").
//
// Starts on its own the moment a trial game opens (no "New to Orbital?"
// prompt: they came to play). Short on purpose: the opening moves from
// the full tour, as tasks, then the two things only a trial has: its
// neighbours (the Ally's pact, the Warlord's coming war, about ten
// minutes in) and saving the empire. The full tour stays in the menu.
//
// Order is the order a player meets things: their world, a ship, moving
// it, the bigger map, research, then the politics, then keeping it.
// ============================================================
const byId = (id: string): TutorialStep => {
  const step = TUTORIAL_STEPS.find(x => x.id === id);
  if (!step) throw new Error(`tutorial: no step ${id}`);
  return step;
};

export const TRIAL_TUTORIAL_STEPS: TutorialStep[] = [
  {
    id: 'trial-welcome',
    title: 'Welcome, Commander',
    body: 'Your world, a few ships, and two neighbours; a tick every 30 seconds.',
    target: null,
    placement: 'center',
    visual: 'map-controls',
  },
  byId('open-world'),
  byId('world-readout'),
  byId('build-ship'),
  byId('select-ship'),
  byId('send-ship'),
  byId('expand'),
  byId('research'),
  {
    id: 'trial-neighbours',
    title: 'Meet your neighbours',
    body: 'The ALLY will offer you peace; the WARLORD attacks about ten minutes after the clock starts.',
    target: 'mp-dock',
    placement: 'left',
    onEnter: ['close-panels', 'open-panel-empires'],
  },
  {
    id: 'trial-defend',
    title: 'Get ready for the Warlord',
    body: 'Ships parked at home defend it: build more before the Warlord comes.',
    target: 'wm-build',
    placement: 'left',
    onEnter: ['close-dock', 'close-panels', 'open-capital-menu'],
    task: { check: 'ship-queued', label: 'Queue another warship' },
  },
  {
    id: 'trial-save',
    title: 'Keep your empire',
    body: 'Save your empire here to keep it.',
    target: 'menu-button',
    placement: 'below',
    onEnter: ['close-dock', 'close-panels', 'close-world-menu'],
  },
  {
    id: 'trial-clock',
    title: 'Start the clock',
    body: 'Press START: time runs, and your neighbours start moving.',
    target: 'solo-start',
    placement: 'below',
    onEnter: ['close-dock', 'close-panels', 'close-world-menu'],
    task: { check: 'clock-running', label: 'Start the clock' },
  },
];

export const TRIAL_TUTORIAL_STEP_COUNT = TRIAL_TUTORIAL_STEPS.length;

/** The steps a track walks. */
export function stepsFor(track: 'full' | 'trial'): TutorialStep[] {
  return track === 'trial' ? TRIAL_TUTORIAL_STEPS : TUTORIAL_STEPS;
}
