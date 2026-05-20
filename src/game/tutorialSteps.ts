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
  {
    id: 'welcome',
    title: 'Welcome to Orbital',
    body: 'Quick tour of the major systems. Use Next / Back to step through, or hit Skip if you’d rather just play.',
    target: null,
    placement: 'center',
  },
  {
    id: 'map',
    title: 'The map',
    body: 'Drag to pan, scroll to zoom. Areas inside your sensor range render at full brightness; everything else dims to a grey wash. Double-click a body to follow it.',
    target: null,
    placement: 'center',
  },
  {
    id: 'resources',
    title: 'Resources',
    body: 'Your faction’s pool — fuel, ore, credits, science. The +X/t under each value is what your settlements deposit per tick. Cities directly fuel your pool now, no freighter ferrying required.',
    target: 'topbar-resources',
    placement: 'below',
  },
  {
    id: 'outliner',
    title: 'Your holdings',
    body: 'Every body you control, every ship you own — grouped by location. Click an entry to focus the map on it.',
    target: 'outliner',
    placement: 'left',
  },
  {
    id: 'select-body',
    title: 'Inspect a body',
    body: 'Click any body on the map to open its inspector. From there you can deploy a city or station to start extracting resources.',
    target: null,
    placement: 'center',
  },
  {
    id: 'select-ship',
    title: 'Select a ship',
    body: 'Click a ship to open its panel — fuel, HP, orders queue, and the TRANSFER button to send it to another body.',
    target: null,
    placement: 'center',
  },
  {
    id: 'transfer',
    title: 'Plan a transfer',
    body: 'TRANSFER drops you into target-pick mode. Click a destination body to draw a dashed preview arc. Nothing’s committed yet.',
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
    id: 'build',
    title: 'Build ships',
    body: 'Open a body you own to see the SHIPYARD panel. Pick a class, watch the cost — red numbers mean you’re short, green means you can afford it. Builds go into a queue at the body.',
    target: 'nav-fleet',
    placement: 'below',
  },
  {
    id: 'research',
    title: 'Research',
    body: 'The Research panel queues up tech upgrades. Each tech caps at +3 science per tick on the bar — pick what to research now and queue up what comes next.',
    target: 'nav-research',
    placement: 'below',
  },
  {
    id: 'settlements',
    title: 'Settlements',
    body: 'Cities and stations across your empire. Each one extracts the body’s yield and feeds it into your pool. Buildings here boost output further.',
    target: 'nav-settlements',
    placement: 'below',
  },
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
    body: 'The menu button (top-left logo) opens save/load, the admin grant tool, and a Restart Tutorial entry if you want to see this again.',
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
