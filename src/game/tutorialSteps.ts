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
// Keep bodies short — one or two sentences. The point is to
// orient the player, not lecture them. Players who want details
// can dig into menus on their own.
//
// Steps that target elements which only appear after a click
// (ship panel, body inspector) use a `null` "click prompt" step
// in front so the player knows to open the panel before the next
// coachmark can find its anchor. Without that, the overlay falls
// back to a centered card with no halo, which is confusing.
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
    body: 'Quick tour of the major systems. Use Next / Back to step through, or hit Skip if you’d rather just play.',
    target: null,
    placement: 'center',
  },
  {
    id: 'victory',
    title: 'Three ways to win',
    body: 'SCIENCE — max every tech track. MILITARY — wipe every rival settlement off the map. ENGINEERING — complete the Dyson Sphere at Sol. Pick a path; everything else hangs off that choice.',
    target: null,
    placement: 'center',
  },
  {
    id: 'map',
    title: 'The map',
    body: 'Drag to pan, scroll to zoom. Inside your sensor range renders bright; everything else dims to a grey wash. Double-click a body to follow it.',
    target: null,
    placement: 'center',
  },

  // === Top bar ==============================================
  {
    id: 'resources',
    title: 'Resources',
    body: 'Your faction’s pool — fuel, ore, credits, science. The +X/t under each value is what your settlements deposit each tick. No collector? Your settlements stockpile but never deliver.',
    target: 'topbar-resources',
    placement: 'below',
  },
  {
    id: 'sim-controls',
    title: 'Time controls',
    body: 'Pause, run real-time, or fast-forward up to 100,000×. +10 / +100 / +1K skip ahead a fixed number of ticks. Long transits feel short on 100× — interceptions feel longer on 1×.',
    target: 'sim-controls',
    placement: 'below',
  },

  // === Outliner =============================================
  {
    id: 'outliner',
    title: 'Your holdings',
    body: 'Every body you control and every ship you own — grouped by location. Green/amber/red HP dots, ⛽ flag for low fuel, ★ for owned bodies. Click any row to focus the map.',
    target: 'outliner',
    placement: 'left',
  },
  {
    id: 'outliner-transit',
    title: 'In transit',
    body: 'Ships currently burning between bodies show here with their destination and T-minus ticks to arrival. Click one to jump to its panel and re-plan or cancel mid-burn.',
    target: 'outliner-transit',
    placement: 'left',
  },

  // === Body inspector =======================================
  {
    id: 'select-body',
    title: 'Open a body',
    body: 'Click any body on the map to open its inspector. The next few steps walk through what’s in that panel — open one now if you can.',
    target: null,
    placement: 'center',
  },
  {
    id: 'body-production',
    title: 'Potential yield',
    body: 'Every body lists what it produces per harvest. Higher-yield bodies are worth contesting; barren rocks aren’t. Yields flow into a city or station you deploy here.',
    target: 'body-production',
    placement: 'right',
  },
  {
    id: 'deploy-buttons',
    title: 'Deploy a settlement',
    body: 'Send a freighter to orbit a body, then DEPLOY CITY (extraction + science) or DEPLOY STATION (shipyard + weapons + Dyson foundation). Costs come from your pool.',
    target: 'deploy-buttons',
    placement: 'above',
  },
  {
    id: 'collector-button',
    title: 'Build a collector',
    body: 'A settlement’s stockpile only reaches your pool through a collector link. Your first one is free; subsequent collectors cost ore + credits but unlock new income lines.',
    target: 'collector-button',
    placement: 'right',
  },
  {
    id: 'buildings-strip',
    title: 'Settlement buildings',
    body: 'Cities host FORGE (+ore), MINT (+credits), LAB (+science). Stations host WEAPONS (+station damage) and SHIPYARD (+build slots). Each level past L3 hits diminishing returns.',
    target: 'buildings-strip',
    placement: 'right',
  },
  {
    id: 'dyson-sphere',
    title: 'Dyson Sphere (Engineering Victory)',
    body: 'At a Sol-orbit station you can lay the Dyson foundation. Park freighters at Sol to deliver fuel/ore/credits/science every tick. Fill the four targets and you win — but rivals can blow up your foundation.',
    target: 'dyson-sphere-section',
    placement: 'above',
  },

  // === Ship panel ===========================================
  {
    id: 'select-ship',
    title: 'Open a ship',
    body: 'Click a ship in the outliner or on the map to open its panel. The next steps walk through what’s in there.',
    target: null,
    placement: 'center',
  },
  {
    id: 'ship-stats',
    title: 'Ship stats',
    body: 'Class, HP, fuel, location. Parked at a friendly station? Passive +repair/t and +refuel/t kick in. Fuel runs out mid-transit and the ship drifts dead until rescued.',
    target: 'ship-stats',
    placement: 'right',
  },
  {
    id: 'ship-combat-record',
    title: 'Veterancy',
    body: 'Every kill bumps the ship’s rank — +1% damage and +1% HP cap per rank. The combat record lists every hull it’s killed, who owned it, and where. Veteran ships are worth retreating to heal.',
    target: 'ship-combat-record',
    placement: 'right',
  },
  {
    id: 'ship-fleet-section',
    title: 'Fleets',
    body: 'Group ships into a fleet to move them as one — TRANSFER on any member can move the whole formation. FORM FLEET, ADD SHIPS, LEAVE, or DISBAND from this panel.',
    target: 'ship-fleet-section',
    placement: 'right',
  },
  {
    id: 'transfer',
    title: 'Plan a transfer',
    body: 'TRANSFER drops you into target-pick mode. Click a destination body to draw a dashed preview arc. Nothing’s committed yet — you can re-pick or cancel.',
    target: 'ship-transfer-button',
    placement: 'above',
  },
  {
    id: 'commit',
    title: 'Lock it in',
    body: 'COMMIT flips the planned burn into the schedule. The ship slides along the curve from departure to arrival. Cancel any time before it fires.',
    target: 'ship-commit-button',
    placement: 'above',
  },
  {
    id: 'ship-maneuver',
    title: 'Orders queue',
    body: 'Each committed burn shows here with Δv, ETA, and a cancel button. You can chain legs — queue Earth→Mars→Jupiter and the ship auto-launches each leg as the previous one lands.',
    target: 'ship-maneuver-section',
    placement: 'right',
  },

  // === Big systems on the top bar ===========================
  {
    id: 'build',
    title: 'Build ships (Military Victory)',
    body: 'FLEET opens the shipyard manager — pick a class (corvette / frigate / destroyer / freighter), watch the cost, queue builds at stations. Combat fleets are how you take rival settlements.',
    target: 'nav-fleet',
    placement: 'below',
  },
  {
    id: 'research',
    title: 'Research (Science Victory)',
    body: 'Seven tech tracks — weapons, armor, propulsion, etc. Each caps at L10. Filling every track to L10 wins by Science Victory. Earlier levels are cheap; the last few are punishing.',
    target: 'nav-research',
    placement: 'below',
  },
  {
    id: 'settlements',
    title: 'Settlements panel',
    body: 'Empire-wide view of every city and station — yields, stockpile, building queue. Useful for spotting under-collected stockpiles or empty shipyard slots.',
    target: 'nav-settlements',
    placement: 'below',
  },

  // === Side controls ========================================
  {
    id: 'layers',
    title: 'Map layers',
    body: 'Toggle overlays — transfer arcs from every faction, incoming hostile trajectories, body ownership rings. Default-on layers cover the basics.',
    target: 'layers-button',
    placement: 'left',
  },
  {
    id: 'menu',
    title: 'Save, load, settings',
    body: 'The menu (top-left logo) opens save/load, the admin grant tool, and a Restart Tutorial entry if you want to see this again.',
    target: 'menu-button',
    placement: 'below',
  },
  {
    id: 'done',
    title: 'You’re set',
    body: 'That’s the tour. Click around — everything has tooltips on hover. Have fun out there.',
    target: null,
    placement: 'center',
  },
];

/** Total step count, exposed so TutorialProvider can size its index
 *  without importing the steps array (provider should stay generic). */
export const TUTORIAL_STEP_COUNT = TUTORIAL_STEPS.length;
