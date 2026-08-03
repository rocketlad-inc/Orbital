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
// Fresh factions seed with 100 metal / 50 credits (worker/factions.js
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
  | 'select-first-ship'    // selectShip(first player ship) → ship panel mounts
  | 'open-panel-research'  // window 'orbital:open-panel' {panel:'research'}
  | 'open-panel-fleet'
  | 'open-panel-settlements'
  | 'open-designer'        // window 'orbital:open-ship-designer'
  | 'close-designer'       // window 'orbital:close-ship-designer'
  | 'close-panels';        // window 'orbital:open-panel' {panel:null}

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
  | 'research-started';     // a research project is running

/** Inline SVG illustration key (TutorialVisuals.tsx). */
export type TutorialVisualId =
  | 'victory' | 'map-controls' | 'economy' | 'upkeep' | 'senate' | 'dyson' | 'herald';

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
  /** Effect executed when the step becomes active. */
  onEnter?: TutorialEffect;
  /** Task gate: NEXT locks until `check` passes, then the step
   *  celebrates and auto-advances. `label` renders as the checklist
   *  line ("⬜ Queue a building upgrade"). */
  task?: { check: TutorialCheckId; label: string };
  /** Illustration for steps with no menu on screen. */
  visual?: TutorialVisualId;
}

export const TUTORIAL_STEPS: TutorialStep[] = [
  // === Orientation ==========================================
  {
    id: 'welcome',
    title: 'Welcome to Orbital',
    body: 'Build an interplanetary empire across the Sol system — in real time, one tick an hour, running whether you’re watching or not. This tour has you make your real opening moves; nothing is wasted.',
    target: null,
    placement: 'center',
    visual: 'map-controls',
  },
  {
    id: 'victory',
    title: 'Three ways to win',
    body: 'CHANCELLOR — get the senate to elect you. DOMINATION — own more than 60% of the worlds on the map. ENGINEERING — finish the Dyson Sphere around the sun. Everything you do should serve one of these.',
    target: null,
    placement: 'center',
    visual: 'victory',
  },

  // === Act 1: your homeworld =================================
  {
    id: 'open-world',
    title: 'Open your homeworld',
    body: 'The map is the menu: click a world to run it. Your capital is marked ★ in the Outliner on the right — click it there, or click the planet itself.',
    target: 'outliner',
    placement: 'left',
    task: { check: 'world-menu-open-owned', label: 'Open the menu on a world you own' },
  },
  {
    id: 'world-readout',
    title: 'This is your base',
    body: 'Name, integrity, population, defense — and OUTPUT/t, what this world produces every tick. The stockpile line is what’s banked locally, waiting to reach your treasury.',
    target: 'world-menu',
    placement: 'below',
    onEnter: 'open-capital-menu',
  },
  {
    id: 'collector',
    title: 'The collector is the pipeline',
    body: 'Income only reaches your treasury through a collector — your capital’s came free. Every settlement you found later needs its own, or its harvest just piles up on-site.',
    target: 'collector-button',
    placement: 'right',
    onEnter: 'open-capital-menu',
  },
  {
    id: 'queue-building',
    title: 'Upgrade something',
    body: 'The SURFACE column upgrades your city: FORGE makes metal, MINT makes credits, LAB makes science — and yields compound per level. Click one now (a FORGE is a great first pick).',
    target: 'wm-columns',
    extraTargets: ['wm-columns-orbit'],
    placement: 'right',
    onEnter: 'open-capital-menu',
    task: { check: 'building-queued', label: 'Queue a building upgrade' },
  },
  {
    id: 'build-ship',
    title: 'Build a ship',
    body: 'The strip at the bottom is your shipyard. Name it if you like, then hit BUILD on a CORVETTE — cheap, fast, and it can shoot. The ⚡ button on a queued ship rushes it for the ship’s price again (25% risk of a half-hull delivery).',
    target: 'wm-build',
    placement: 'above',
    onEnter: 'open-capital-menu',
    task: { check: 'ship-queued', label: 'Queue a corvette at your shipyard' },
  },

  // === Act 2: your fleet =====================================
  {
    id: 'select-ship',
    title: 'This is a ship',
    body: 'You already command a small fleet. Click any of your ships — in the Outliner or out on the map — to take the conn.',
    target: 'outliner',
    extraTargets: ['ship-panel'],
    placement: 'left',
    task: { check: 'ship-selected', label: 'Select one of your ships' },
  },
  {
    id: 'ship-stats',
    title: 'Hull and status',
    body: 'Class, HP, loadout, and what it’s doing right now. Parked at a friendly station it quietly repairs each tick — damaged ships even have a one-tap “send to shipyard” order. You can rename it with the pencil.',
    target: 'ship-stats',
    placement: 'right',
    onEnter: 'select-first-ship',
  },
  {
    id: 'ship-veterancy',
    title: 'Captains and rank',
    body: 'Kills raise rank — more damage, more hull. Captains carry the rank and their own traits, and may survive a lost ship to be rescued. Veterans are worth pulling back to heal.',
    target: 'ship-combat-record',
    placement: 'right',
    onEnter: 'select-first-ship',
  },
  {
    id: 'send-ship',
    title: 'Move ship to Y',
    body: 'Hit MOVE TO TARGET, click any world, and COMMIT. Transfers are free — the cost is time, and the game keeps flying it while you’re gone.',
    target: 'ship-transfer-button',
    extraTargets: ['ship-commit-button'],
    placement: 'above',
    onEnter: 'select-first-ship',
    task: { check: 'transfer-committed', label: 'Send a ship somewhere' },
  },
  {
    id: 'orders-queue',
    title: 'Orders queue',
    body: 'There’s your burn — ETA and a cancel button until it fires. Chain more legs and the ship flies them back to back. That’s the whole movement system.',
    target: 'ship-maneuver-section',
    placement: 'right',
  },

  // === Act 3: the designer ===================================
  {
    id: 'designer',
    title: 'Design your own hulls',
    body: 'Drag parts onto the sockets: kinetic chews armor, energy melts shields, engines make it faster — and the ship visibly grows the hardware. Duplicates of a part cost more each time.',
    target: 'designer-canvas',
    extraTargets: ['designer-stats'],
    placement: 'right',
    onEnter: 'open-designer',
  },
  {
    id: 'designer-stats',
    title: 'The bill, before you pay it',
    body: 'The sidebar shows before→after stats, the total price, and the per-tick UPKEEP this design bills you forever. SAVE & SET ACTIVE makes every shipyard build this design; saved designs can also REFIT ships already flying, for a fee.',
    target: 'designer-stats',
    placement: 'left',
  },

  // === Act 4: research + economy =============================
  {
    id: 'research',
    title: 'Research decides what you fight with',
    body: 'Six tracks, ten levels. Hulls, weapons, buildings, senate powers, and — through Sensors — how much of your rivals you can even see. Start a project now; science flows into it automatically.',
    target: 'nav-research',
    placement: 'below',
    onEnter: 'open-panel-research',
    task: { check: 'research-started', label: 'Start (or queue) a research project' },
  },
  {
    id: 'upkeep',
    title: 'Fleets cost rent',
    body: 'Every hull bills upkeep each tick — the top bar’s +X/t is NET of it. Run the treasury dry and the fleet goes into ARREARS: −25% damage until you’re solvent. Big navies need big economies.',
    target: 'topbar-resources',
    placement: 'below',
    onEnter: 'close-panels',
    visual: 'upkeep',
  },

  // === Act 5: the wider war ==================================
  {
    id: 'senate',
    title: 'The Senate · Chancellor Victory',
    body: 'Bills bend the rules for everyone — build costs, upkeep, combat damage — with votes weighted by worlds held. The Chancellor bill IS a win condition, and each faction gets exactly ONE attempt at it. Ever.',
    target: null,
    placement: 'center',
    visual: 'senate',
  },
  {
    id: 'dyson',
    title: 'The Dyson Sphere · Engineering Victory',
    body: 'Deep Construction research unlocks the foundation at a Sol-orbit station. Freighters parked at Sol pump your treasury into the sphere every tick — and rivals can shoot the progress right back off it.',
    target: null,
    placement: 'center',
    visual: 'dyson',
  },
  {
    id: 'situation-report',
    title: 'Your inbox for the war',
    body: 'The Situation Report ranks everything: what’s in combat NOW, what needs a decision, what’s sitting idle. Every row is a link straight to the problem. Check it first when you log in — and read the HERALD tab on the Event Log for the war’s front page.',
    target: null,
    placement: 'center',
    visual: 'herald',
  },
  {
    id: 'done',
    title: 'You’ve already started',
    body: 'A building rising, a hull in the yard, a ship under way, a lab running — those were your real opening moves. Win the senate, own the map, or cage the sun. The game is running either way.',
    target: null,
    placement: 'center',
    visual: 'victory',
  },
];

/** Total step count, exposed so TutorialProvider can size its index
 *  without importing the steps array (provider should stay generic). */
export const TUTORIAL_STEP_COUNT = TUTORIAL_STEPS.length;
