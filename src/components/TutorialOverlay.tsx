// ============================================================
// TutorialOverlay — the coachmark renderer.
//
// Reads the current tutorial step from context. For each step:
//   - Finds the target element via data-tutorial-id (or centers
//     the card when target=null).
//   - Paints a dark backdrop over the whole viewport, cutting a
//     hole around the target rect so it stays visible at full
//     brightness (even-odd fill rule, same trick as the sensor
//     fog overlay).
//   - Renders a coachmark card with title + body + Back/Next/Skip,
//     positioned next to the target on the placement side.
//   - Re-measures on resize + every animation frame while active,
//     so the cutout tracks the target if layout shifts.
//
// Portaled to document.body so .top-bar's backdrop-filter doesn't
// confine the overlay to the top bar's box.
// ============================================================

import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTutorial } from '../state/tutorial';
import { useGameContext } from '../state/gameContext';
import {
  stepsFor, TutorialStep, TutorialEffect, TutorialCheckId, Placement,
} from '../game/tutorialSteps';
import { TutorialVisual } from './TutorialVisuals';
import { t, tk } from '../i18n/core';
import { useI18n } from '../i18n/react';
import { getWorldMenuOpenBodyId } from '../game/worldMenu/store';
import { useIsMobile } from '../hooks/useIsMobile';
import type { GameState } from '../types';

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Walk the DOM for the element matching `data-tutorial-id`. Returns
 *  null if missing (the corresponding component may not be mounted
 *  yet — overlay falls back to a centered card). The first one that is
 *  actually on screen wins: a phone and a desktop control can share an
 *  id (nav-research is the top bar's, and the phone rail's), and the
 *  hidden one may come first in the document. */
function findTarget(targetId: string | null): Element | null {
  if (!targetId) return null;
  const all = document.querySelectorAll(`[data-tutorial-id="${targetId}"]`);
  for (const el of Array.from(all)) {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0 && r.right > 0 && r.bottom > 0
      && r.left < window.innerWidth && r.top < window.innerHeight) return el;
  }
  return null;
}

/** Open dialogs the player acts in while a step waits (the destination
 *  list): the card keeps off them as it keeps off its target. */
function openDialogRects(): Rect[] {
  const out: Rect[] = [];
  document.querySelectorAll('.modal-content').forEach(el => {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) out.push(snapRect(r));
  });
  return out;
}

/** The lowest y the card may reach: above a dock rail that runs along the
 *  bottom (phones and tablets), else the window's own edge. */
function bottomLimit(viewportH: number): number {
  const rail = document.querySelector('.dock-rail');
  const r = rail?.getBoundingClientRect();
  if (r && r.width > r.height && r.top > viewportH * 0.6) return Math.round(r.top);
  return viewportH;
}

/** Pad the target rect by a few pixels so the cutout doesn't crowd
 *  the element itself. Keeps a visible "halo" of unscored space. */
function padRect(r: Rect, pad = 6): Rect {
  return { x: r.x - pad, y: r.y - pad, width: r.width + pad * 2, height: r.height + pad * 2 };
}

/** Snap a DOMRect to integer pixel bounds. getBoundingClientRect
 *  returns subpixel floats that drift by fractions of a pixel
 *  frame-to-frame even when the element is visually stationary
 *  (font hinting, transform rounding, etc). Storing the raw values
 *  caused a noticeable wiggle on the highlighted panel — every frame
 *  the SVG outline redrew at a slightly different position. Rounding
 *  collapses that drift so the outline only moves when the element
 *  genuinely moves by a whole pixel or more. */
function snapRect(r: { left: number; top: number; width: number; height: number }): Rect {
  return {
    x: Math.round(r.left),
    y: Math.round(r.top),
    width: Math.round(r.width),
    height: Math.round(r.height),
  };
}

/** True if two rects differ in any field. Used to bail out of state
 *  updates when nothing meaningful changed — prevents the per-frame
 *  re-render cascade. null on either side means "they differ." */
function rectsDiffer(a: Rect | null, b: Rect | null): boolean {
  if (a === null && b === null) return false;
  if (a === null || b === null) return true;
  return a.x !== b.x || a.y !== b.y || a.width !== b.width || a.height !== b.height;
}

function rectArraysDiffer(a: Rect[], b: Rect[]): boolean {
  if (a.length !== b.length) return true;
  for (let i = 0; i < a.length; i++) {
    if (rectsDiffer(a[i], b[i])) return true;
  }
  return false;
}

function overlapArea(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

/** Compute where to place the coachmark card. THE CARD NEVER SITS ON
 *  WHAT IT POINTS AT (playtest, 2026-10-24: it covered the list, the
 *  COMMIT button, "save here" and the home planet itself). The asked-for
 *  side is tried first, then the others; when no side is clear (a phone,
 *  a full-width panel), the top or bottom edge that covers least. A step
 *  with nothing to point at sits low, off the middle of the map, where
 *  the player's home world is. */
function placeCard(
  targetRect: Rect | null,
  avoid: Rect[],
  placement: TutorialStep['placement'],
  viewport: { width: number; height: number },
  cardSize: { width: number; height: number },
  floorY: number,
  /** A step played on the map: keep off its middle too (the home world). */
  onMap = false,
  /** Top of the free area: under the top bar, whose clock and resources
   *  the edge positions used to cover. */
  ceilY = 8,
): { x: number; y: number } {
  const GAP = 14;
  const MARGIN = 8;
  const topY = Math.max(MARGIN, ceilY);
  const maxY = Math.max(MARGIN, floorY - cardSize.height - MARGIN);
  const clamp = (x: number, y: number) => ({
    x: Math.max(MARGIN, Math.min(x, viewport.width - cardSize.width - MARGIN)),
    y: Math.max(MARGIN, Math.min(y, maxY)),
  });
  const centreX = (viewport.width - cardSize.width) / 2;
  const home = { x: viewport.width / 2 - 70, y: viewport.height / 2 - 70, width: 140, height: 140 };
  const cost = (p: { x: number; y: number }, keepOff: Rect[]) => {
    const card = { x: p.x, y: p.y, width: cardSize.width, height: cardSize.height };
    return keepOff.reduce((n, r) => n + overlapArea(card, r), 0);
  };
  if (!targetRect || placement === 'center') {
    // Off the middle of the map, where the camera puts the player's own
    // world: low if that clears it, else high (a tall card on a phone).
    const low = clamp(centreX, maxY);
    const high = clamp(centreX, topY);
    return cost(low, [home]) <= cost(high, [home]) ? low : high;
  }
  const keepOff = [padRect(targetRect, 8), ...avoid.map(r => padRect(r, 4)), ...(onMap ? [home] : [])];
  const at = (side: Exclude<Placement, 'center'>) => {
    let x = targetRect.x + targetRect.width / 2 - cardSize.width / 2;
    let y = targetRect.y + targetRect.height / 2 - cardSize.height / 2;
    if (side === 'above') y = targetRect.y - cardSize.height - GAP;
    if (side === 'below') y = targetRect.y + targetRect.height + GAP;
    if (side === 'left')  x = targetRect.x - cardSize.width - GAP;
    if (side === 'right') x = targetRect.x + targetRect.width + GAP;
    return clamp(x, y);
  };
  const order: Exclude<Placement, 'center'>[] = [placement, 'below', 'above', 'right', 'left'];
  const tried = order.filter((s, i) => order.indexOf(s) === i).map(at);
  tried.push(clamp(centreX, topY), clamp(centreX, maxY));
  let best = tried[0];
  let bestCost = cost(best, keepOff);
  for (const p of tried) {
    if (bestCost === 0) break;
    const c = cost(p, keepOff);
    if (c < bestCost) { best = p; bestCost = c; }
  }
  return best;
}

// ---- Task baselines + checks (show-don't-tell tutorial) --------------
//
// Counts snapshotted when a task step becomes active, so replaying
// players' EXISTING queues/orders don't auto-complete the task — the
// tour asks them to do the thing NOW. `research-started` deliberately
// has no baseline: a project already running counts as done.

interface TaskBaseline {
  /** The step these counts were taken for. */
  stepId: string;
  buildOrders: number;
  orders: number;
  buildingQueues: number;
  /** Peace partners at step entry (the trial's pact task). */
  peace: number;
  /** Research levels held at step entry: UNLOCK NOW finishes a level at
   *  once and never leaves a project running (playtest, 2026-10-24). */
  techLevels: number;
}

function techLevelSum(gs: GameState): number {
  const levels = gs.factionTech?.player?.levels ?? {};
  return Object.values(levels).reduce((a: number, n) => a + (Number(n) || 0), 0);
}

function playerBuildOrderCount(gs: GameState): number {
  return gs.buildOrders.filter(o => o.ownedBy === 'player').length;
}
function playerBuildingQueueCount(gs: GameState): number {
  return gs.settlements.filter(s => s.ownedBy === 'player' && s.buildingQueue != null).length;
}
function playerOrderCount(gs: GameState): number {
  const mine = new Set(gs.ships.filter(s => s.ownedBy === 'player').map(s => s.id));
  // Any state counts — the check is a DELTA against the step-entry
  // baseline, so only orders the player just placed complete the task.
  return gs.orders.filter(o => mine.has(o.shipId)).length;
}

/** Labels a step's {vars} stand for, read from the controls' own catalog
 *  keys so the card says exactly what the button says, in either language
 *  (playtest, 2026-10-24: "ESCOLHER DA LISTA" beside a button reading
 *  "ESCOLHER NA LISTA"). */
function stepVars(): Record<string, string> {
  const bare = (s: string) => s.replace(/^[▲▶\s]+/, '');
  return {
    yard: t('worldmenu.bar.yard'),
    build: t('worldmenu.build'),
    corvette: t('data.ship.corvette.name').toUpperCase(),
    colony: t('data.ship.colony.name').toUpperCase(),
    list: t('ship.panel.chooseFromList'),
    commit: t('ship.panel.commit'),
    city: bare(t('worldmenu.found.btnCity')),
    station: bare(t('worldmenu.found.btnStation')),
    sitrep: t('dock.situation'),
  };
}

export const TutorialOverlay: React.FC = () => {
  useI18n();
  const { active, index, back, skip, finish, jumpTo, track } = useTutorial();
  const isMobile = useIsMobile();
  const TUTORIAL_STEPS = stepsFor(track);
  const { gameState, uiState, selectBody, selectShip } = useGameContext();
  const [targetRect, setTargetRect] = useState<Rect | null>(null);
  // Extra cutout rects for steps that highlight more than one element
  // (e.g. select-body highlights the Outliner AND the freshly-opened
  // BodyInspector so the inspector doesn't sit dimmed behind the
  // backdrop while the card talks about it).
  const [extraRects, setExtraRects] = useState<Rect[]>([]);
  // Dialogs open over the map (the destination list): kept clear too.
  const [dialogRects, setDialogRects] = useState<Rect[]>([]);
  const [floorY, setFloorY] = useState(typeof window !== 'undefined' ? window.innerHeight : 800);
  const [viewport, setViewport] = useState({
    width: typeof window !== 'undefined' ? window.innerWidth : 1280,
    height: typeof window !== 'undefined' ? window.innerHeight : 800,
  });
  const cardRef = useRef<HTMLDivElement>(null);
  const [cardSize, setCardSize] = useState({ width: 360, height: 180 });

  const step = active && index >= 0 ? TUTORIAL_STEPS[index] : null;

  // --- onEnter effects: "if you're explaining a menu, the menu is
  // OPEN." Each step may declare an effect that opens the surface it
  // talks about before the card renders. Missing prerequisites (no
  // owned settlement, no ship) degrade silently to a centered card.
  const runEffect = (effect: TutorialEffect) => {
    switch (effect) {
      case 'open-capital-menu': {
        // Prefer the CAPITAL (first owned settlement's body). selectBody
        // is what the world menu keys its fly-in on, so this both
        // selects and opens.
        const mine = gameState.settlements.find(s => s.ownedBy === 'player');
        if (mine) selectBody(mine.bodyId);
        break;
      }
      case 'open-sol-menu': {
        // The sun has a menu too (Dyson foundation site). Body ids are
        // client-local after the deserializer strips the game prefix.
        const sol = gameState.bodies.find(b => b.type === 'star');
        if (sol) selectBody(sol.id);
        break;
      }
      case 'select-colony-ship': {
        const mine = gameState.ships.filter(s => s.ownedBy === 'player');
        const colony = mine.find(s => s.class === 'colony' && !s.transit)
          ?? mine.find(s => !s.transit) ?? mine[0];
        if (colony) selectShip(colony.id);
        break;
      }
      case 'select-first-ship': {
        // Prefer a PARKED ship — the transfer task needs one that can
        // take a fresh order and shows the full panel.
        const mine = gameState.ships.find(s => s.ownedBy === 'player' && !s.transit)
          ?? gameState.ships.find(s => s.ownedBy === 'player');
        if (mine) selectShip(mine.id);
        break;
      }
      case 'open-panel-research':
        window.dispatchEvent(new CustomEvent('orbital:open-panel', { detail: { panel: 'research' } }));
        break;
      case 'open-panel-fleet':
        window.dispatchEvent(new CustomEvent('orbital:open-panel', { detail: { panel: 'fleet' } }));
        break;
      case 'open-panel-settlements':
        window.dispatchEvent(new CustomEvent('orbital:open-panel', { detail: { panel: 'settlements' } }));
        break;
      case 'open-designer':
        window.dispatchEvent(new CustomEvent('orbital:open-ship-designer'));
        break;
      case 'close-designer':
        window.dispatchEvent(new CustomEvent('orbital:close-ship-designer'));
        break;
      case 'close-panels':
        window.dispatchEvent(new CustomEvent('orbital:open-panel', { detail: { panel: null } }));
        window.dispatchEvent(new CustomEvent('orbital:close-ship-designer'));
        break;
      case 'open-panel-trades':
        window.dispatchEvent(new CustomEvent('orbital:open-panel', { detail: { panel: 'trades' } }));
        break;
      case 'open-panel-empires':
        window.dispatchEvent(new CustomEvent('dockrail:set', { detail: { active: 'multiplayer' } }));
        break;
      case 'close-world-menu':
        window.dispatchEvent(new CustomEvent('orbital:close-world-menu'));
        break;
      case 'close-dock':
        window.dispatchEvent(new CustomEvent('dockrail:set', { detail: { active: null } }));
        break;
      case 'ship-tab-orders':
      case 'ship-tab-ship':
      case 'ship-tab-cargo':
      case 'ship-tab-log':
        // 'ship-tab-log' -> 'log'. Derived from the effect name rather than
        // written twice, so adding a tab can't leave a stale mapping behind.
        window.dispatchEvent(new CustomEvent('orbital:ship-panel-tab', {
          detail: { tab: effect.slice('ship-tab-'.length) },
        }));
        break;
    }
  };
  useEffect(() => {
    // A step may need more than one effect — "select a ship" AND "switch the
    // panel to the tab this step points at". Run them in order; the array
    // form is what lets a tab switch compose with an existing effect instead
    // of replacing it.
    if (step?.onEnter) {
      for (const fx of Array.isArray(step.onEnter) ? step.onEnter : [step.onEnter]) {
        runEffect(fx);
      }
    }
    // A target inside a scrolled panel (the ship panel's MOVE TO TARGET sat
    // below the fold) gets scrolled into view once its panel has opened.
    const targetId = step?.target;
    const scrollTimer = targetId
      ? setTimeout(() => {
          const el = document.querySelector(`[data-tutorial-id="${targetId}"]`) as HTMLElement | null;
          // Vertically only, in the nearest scrolling panel: scrollIntoView
          // also scrolled the ship panel sideways and cut its buttons off.
          for (let p = el?.parentElement ?? null; el && p; p = p.parentElement) {
            const oy = getComputedStyle(p).overflowY;
            if ((oy === 'auto' || oy === 'scroll') && p.scrollHeight > p.clientHeight) {
              const er = el.getBoundingClientRect();
              const pr = p.getBoundingClientRect();
              if (er.top < pr.top) p.scrollTop -= pr.top - er.top + 12;
              else if (er.bottom > pr.bottom) p.scrollTop += er.bottom - pr.bottom + 12;
              break;
            }
          }
          // ...and sideways only inside a row built to scroll sideways (a
          // phone's world-menu cards put SHIPYARD half off the edge).
          for (let p = el?.parentElement ?? null; el && p; p = p.parentElement) {
            const ox = getComputedStyle(p).overflowX;
            if ((ox === 'auto' || ox === 'scroll') && p.scrollWidth > p.clientWidth) {
              const er = el.getBoundingClientRect();
              const pr = p.getBoundingClientRect();
              // Bring its START into view: these rows snap to each card's
              // left edge, and a nudge short of that snapped straight back.
              if (er.left < pr.left || er.right > pr.right) p.scrollLeft += er.left - pr.left - 12;
              break;
            }
          }
        }, 450)
      : null;
    return () => { if (scrollTimer) clearTimeout(scrollTimer); };
    // gameState intentionally NOT in deps — effects fire on step change
    // only, not whenever the world ticks.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step?.id]);

  // --- Task engine: snapshot baselines on step entry, evaluate the
  // check every render (a low-rate ticker forces re-evaluation for
  // checks reading non-reactive sources like the world-menu store),
  // and mark it done when it passes (NEXT then lights up).
  const baselineRef = useRef<TaskBaseline | null>(null);
  // Done is kept per STEP: a plain boolean carried the last step's tick
  // into the first render of the next one (playtest, 2026-10-24).
  const [doneStepId, setDoneStepId] = useState<string | null>(null);
  const taskDone = !!step && doneStepId === step.id;
  const [, forceTick] = useState(0);
  useEffect(() => {
    if (!step?.task) { baselineRef.current = null; return; }
    baselineRef.current = {
      stepId: step.id,
      buildOrders: playerBuildOrderCount(gameState),
      orders: playerOrderCount(gameState),
      buildingQueues: playerBuildingQueueCount(gameState),
      peace: gameState.peaceFactionIds?.length ?? 0,
      techLevels: techLevelSum(gameState),
    };
    const iv = setInterval(() => forceTick(n => n + 1), 400);
    return () => clearInterval(iv);
    // Baselines snapshot once per step by design.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step?.id]);

  const evalCheck = (check: TutorialCheckId): boolean => {
    const base = baselineRef.current;
    switch (check) {
      case 'world-menu-open-owned': {
        // Ticks the moment an owned world is picked: the menu itself
        // flies in a second later, and a player who saw nothing happen
        // thought the tap had missed.
        const picked = uiState.selectedBodyId;
        if (picked && gameState.bodies.find(b => b.id === picked)?.ownedBy === 'player') return true;
        const id = getWorldMenuOpenBodyId();
        if (!id) return false;
        const body = gameState.bodies.find(b => b.id === id);
        return body?.ownedBy === 'player';
      }
      case 'building-queued':
        return playerBuildingQueueCount(gameState) > (base?.buildingQueues ?? 0);
      case 'ship-queued':
        return playerBuildOrderCount(gameState) > (base?.buildOrders ?? 0);
      case 'ship-selected': {
        const sel = uiState.selectedShipId;
        return !!sel && gameState.ships.some(s => s.id === sel && s.ownedBy === 'player');
      }
      case 'transfer-committed':
        return playerOrderCount(gameState) > (base?.orders ?? 0);
      case 'research-started':
        return gameState.factionTech?.player?.researching != null
          || techLevelSum(gameState) > (base?.techLevels ?? Infinity);
      case 'pact-signed':
        return (gameState.peaceFactionIds?.length ?? 0) > (base?.peace ?? 0);
      case 'clock-running':
        return !!gameState.solo && !gameState.solo.paused;
    }
  };
  // Only against THIS step's baseline. The first render of a step runs
  // before its baseline is taken, and judged "one more build order than
  // before" against the last step's (or none): "Queue another warship"
  // ticked itself on arrival (three testers, 2026-10-24).
  const baselineReady = !!step && baselineRef.current?.stepId === step.id;
  const checkPassed = step?.task ? (taskDone || (baselineReady && evalCheck(step.task.check))) : false;
  // Done stays done: the tick lands and NEXT lights up. No auto-advance:
  // it shut the research panel and the shipyard while the player was
  // still using them, and raced a NEXT click into skipping a whole step.
  useEffect(() => {
    if (step?.task && checkPassed && !taskDone) setDoneStepId(step.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checkPassed, step?.id]);

  // Moving on always names the step it goes TO, so two calls for one move
  // (a click and a key, a double tap) land on the same step.
  const goNext = () => {
    if (index >= TUTORIAL_STEPS.length - 1) finish();
    else jumpTo(index + 1);
  };
  // The trial's last task is the clock: the card starts it itself, since
  // a phone's top bar can push START off the screen.
  const startClock = () => {
    window.dispatchEvent(new CustomEvent('orbital:solo-clock', { detail: { action: 'resume' } }));
  };
  const activeTarget = step ? (taskDone && step.doneTarget ? step.doneTarget : step.target) : null;

  // Re-measure target on every animation frame while active. Cheap —
  // getBoundingClientRect is fast and the overlay is short-lived. Avoids
  // a tower of ResizeObservers / MutationObservers to catch layout
  // shifts (panels opening, drawers sliding, etc).
  useEffect(() => {
    if (!step) {
      setTargetRect(null);
      setExtraRects([]);
      return;
    }
    let raf = 0;
    // Local "last known" rects — compared against the next measurement
    // so we only fire setState when the snapped (integer) rects
    // actually changed. State-by-reference would re-render every frame
    // and was the cause of the highlighted-panel wiggle.
    // Nothing measured yet in THIS step: the first frame always writes, or
    // a step with no target kept the last step's ring up ("the highlight
    // frames an empty area": playtest, 2026-10-24).
    let lastPrimary: Rect | null | undefined;
    let lastExtras: Rect[] | undefined;
    let lastDialogs: Rect[] = [];
    let lastFloor = -1;
    const tick = () => {
      // Primary target — drives card placement + outline halo. A step's
      // next control takes over once it is live (COMMIT after a pick).
      const then = !taskDone && step.thenTarget ? findTarget(step.thenTarget) as HTMLButtonElement | null : null;
      const el = then && !then.disabled ? then : findTarget(activeTarget);
      const nextPrimary: Rect | null = el ? snapRect(el.getBoundingClientRect()) : null;
      if (lastPrimary === undefined || rectsDiffer(lastPrimary, nextPrimary)) {
        lastPrimary = nextPrimary;
        setTargetRect(nextPrimary);
      }
      // Extra targets — additional cutouts; placement is not affected.
      // Missing anchors are silently filtered (panel hasn't mounted
      // yet, etc) so a typo or auto-open race doesn't break the step.
      const nextExtras: Rect[] = [];
      for (const id of step.extraTargets ?? []) {
        const ee = findTarget(id);
        if (!ee || ee === el) continue;
        nextExtras.push(snapRect(ee.getBoundingClientRect()));
      }
      if (lastExtras === undefined || rectArraysDiffer(lastExtras, nextExtras)) {
        lastExtras = nextExtras;
        setExtraRects(nextExtras);
      }
      const nextDialogs = openDialogRects();
      if (rectArraysDiffer(lastDialogs, nextDialogs)) {
        lastDialogs = nextDialogs;
        setDialogRects(nextDialogs);
      }
      const nextFloor = bottomLimit(window.innerHeight);
      if (nextFloor !== lastFloor) {
        lastFloor = nextFloor;
        setFloorY(nextFloor);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [step, activeTarget, taskDone]);

  useEffect(() => {
    const onResize = () => setViewport({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // A tall dialog (the destination list on a phone) leaves no room beside
  // it: the card shrinks to its title and task along the bottom edge.
  const compact = dialogRects.some(d => d.height > viewport.height * 0.5);

  // Measure the actual card so placement math accounts for the real
  // height (varies by body length). Layout effect ensures we have
  // measurements before paint to avoid a flash.
  useLayoutEffect(() => {
    if (!cardRef.current) return;
    const r = cardRef.current.getBoundingClientRect();
    if (Math.abs(r.width - cardSize.width) > 1 || Math.abs(r.height - cardSize.height) > 1) {
      setCardSize({ width: r.width, height: r.height });
    }
  }, [step, cardSize.width, cardSize.height, compact, taskDone]);

  // Keyboard: Esc skips, Enter / Right advances (unless a task is
  // gating the step), Left goes back.
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
      if (e.key === 'Escape') skip();
      else if (e.key === 'ArrowRight' || e.key === 'Enter') {
        const cur = TUTORIAL_STEPS[index];
        if (cur?.task && !taskDone) return; // do the thing, don't skim past it
        goNext();
      }
      else if (e.key === 'ArrowLeft') back();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, index, back, skip, finish, taskDone]);

  if (!step) return null;

  const isLast = index === TUTORIAL_STEPS.length - 1;
  const isFirst = index === 0;
  const cardPos = compact
    ? { x: Math.max(8, (viewport.width - cardSize.width) / 2), y: viewport.height - cardSize.height - 8 }
    : placeCard(targetRect, [...extraRects, ...dialogRects], step.placement, viewport, cardSize, floorY,
      step.dim === 'light', Math.round((document.querySelector('.top-bar')?.getBoundingClientRect().bottom ?? 0) + 8));
  // A ring around a control a dialog now covers floated over the dialog.
  const covered = (r: Rect) => dialogRects.some(d => overlapArea(d, r) > 0.5 * r.width * r.height);
  const ringTarget = targetRect && !covered(targetRect) ? targetRect : null;
  const ringExtras = extraRects.filter(r => !covered(r));
  const vars = stepVars();
  const bodyText = taskDone && step.doneBody
    ? tk(`tutorial.step.${step.id}.doneBody`, step.doneBody, vars)
    : isMobile && step.bodyTouch
      ? tk(`tutorial.step.${step.id}.bodyTouch`, step.bodyTouch, vars)
      : tk(`tutorial.step.${step.id}.body`, step.body, vars);
  const clockStep = step.task?.check === 'clock-running';

  return createPortal(
    <div
      role="dialog"
      aria-label={t('tutorial.aria')}
      aria-live="polite"
      style={{
        position: 'fixed',
        inset: 0,
        // Over the dock rail (3200) and the ship designer, which is a
        // desktop modal above the rail (3250, ShipDesigner.css): a step
        // walks the player through the designer.
        zIndex: 3300,
        pointerEvents: 'none', // backdrop is purely visual; controls handle clicks themselves
        fontFamily: 'var(--font-body)',
      }}
    >
      {/* Dim backdrop with the target rect cut out via even-odd fill.
          ALWAYS click-through: the interactive tutorial asks the player
          to click real UI (world menu, build strip, transfer buttons),
          so the backdrop must never eat those clicks — and a stray
          backdrop click silently killing the whole tour was a footgun.
          Skip lives on the button and Esc. */}
      <svg
        width={viewport.width}
        height={viewport.height}
        style={{
          position: 'absolute', inset: 0,
          pointerEvents: 'none',
        }}
      >
        <defs>
          <mask id="tutorial-cutout">
            <rect x={0} y={0} width={viewport.width} height={viewport.height} fill="white" />
            {/* Primary cutout — full halo around the step's main target. */}
            {ringTarget && (() => {
              const p = padRect(ringTarget);
              return <rect x={p.x} y={p.y} width={p.width} height={p.height} rx={6} fill="black" />;
            })()}
            {/* Extra cutouts — each gets the same un-dimmed treatment so
                a multi-anchor step (e.g. Outliner + freshly-opened
                BodyInspector) doesn't leave half its anchors lurking in
                the dark. */}
            {ringExtras.map((r, i) => {
              const p = padRect(r);
              return <rect key={i} x={p.x} y={p.y} width={p.width} height={p.height} rx={6} fill="black" />;
            })}
          </mask>
        </defs>
        <rect
          x={0} y={0}
          width={viewport.width} height={viewport.height}
          fill={step?.dim === 'light' ? 'rgba(5, 8, 14, 0.22)' : 'rgba(5, 8, 14, 0.66)'}
          mask="url(#tutorial-cutout)"
        />
        {/* Outline ring around the primary target — bright amber so it
            reads as "look here." */}
        {ringTarget && (() => {
          const p = padRect(ringTarget);
          return (
            <rect
              x={p.x} y={p.y} width={p.width} height={p.height}
              rx={6}
              fill="none"
              stroke="#ffb84d"
              strokeWidth={2}
              style={{ filter: 'drop-shadow(0 0 8px rgba(255, 184, 77, 0.6))' }}
            />
          );
        })()}
        {/* Extra targets get a softer ring so the player's eye still
            lands on the primary first, but they read as "this is also
            relevant" rather than fading into the cutout. */}
        {ringExtras.map((r, i) => {
          const p = padRect(r);
          return (
            <rect
              key={`extra-${i}`}
              x={p.x} y={p.y} width={p.width} height={p.height}
              rx={6}
              fill="none"
              stroke="rgba(255, 184, 77, 0.45)"
              strokeWidth={1.5}
              strokeDasharray="4 3"
            />
          );
        })}
      </svg>

      {/* Coachmark card — re-enables pointer events for its own area
          so the player can click Back / Next / Skip. */}
      <div
        ref={cardRef}
        style={{
          position: 'absolute',
          left: cardPos.x, top: cardPos.y,
          width: 360, maxWidth: 'calc(100vw - 16px)',
          background: 'linear-gradient(180deg, #131c27 0%, #070b13 100%)',
          border: '1px solid #ffb84d',
          borderRadius: 8,
          padding: '14px 16px',
          color: '#d8e4ee',
          boxShadow: '0 12px 32px rgba(0, 0, 0, 0.6)',
          pointerEvents: 'auto',
        }}
      >
        <div
          style={{
            display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
            marginBottom: 6,
          }}
        >
          <div style={{ fontSize: 10, color: '#b8c8d6', letterSpacing: '0.14em' }}>
            {t('tutorial.header', { n: index + 1, total: TUTORIAL_STEPS.length })}
          </div>
          <button
            onClick={skip}
            title={t('tutorial.skipTour')}
            style={{
              background: 'transparent', color: '#b8c8d6',
              border: 'none', fontSize: 10, cursor: 'pointer',
              letterSpacing: '0.08em',
            }}
          >{t('tutorial.skip')}</button>
        </div>
        <div style={{ fontSize: 15, fontWeight: 700, color: '#ffb84d', marginBottom: 6 }}>
          {tk(`tutorial.step.${step.id}.title`, step.title)}
        </div>
        {!compact && (
          <div style={{ fontSize: 12, lineHeight: 1.45, color: '#d8e4ee' }}>
            {bodyText}
          </div>
        )}
        {/* Illustration for menu-less concept steps (Lorne's rule:
            every step either points at a live surface or shows one). */}
        {step.visual && !compact && <TutorialVisual id={step.visual} />}
        {/* Task checklist — the show-don't-tell gate. Pending: amber
            checkbox + the imperative label. Done: green ✓, and NEXT
            lights up for when the player is ready. */}
        {step.task && (
          <div
            role="status"
            style={{
              display: 'flex', alignItems: 'center', gap: 8,
              marginTop: 10, padding: '7px 10px',
              borderRadius: 6,
              border: `1px solid ${taskDone ? 'rgba(127, 255, 161, 0.7)' : 'rgba(255, 184, 77, 0.55)'}`,
              background: taskDone ? 'rgba(127, 255, 161, 0.1)' : 'rgba(255, 184, 77, 0.07)',
              transition: 'border-color 0.25s, background 0.25s',
            }}
          >
            <span style={{ fontSize: 14, lineHeight: 1, color: taskDone ? '#7fffa1' : '#ffb84d' }}>
              {taskDone ? '✓' : '▢'}
            </span>
            <span style={{ fontSize: 12, fontWeight: 600, color: taskDone ? '#7fffa1' : '#ffd98a' }}>
              {tk(`tutorial.step.${step.id}.task`, step.task.label)}{taskDone ? t('tutorial.taskDone') : ''}
            </span>
          </div>
        )}
        <div
          style={{
            display: compact ? 'none' : 'flex', alignItems: 'center', justifyContent: 'space-between',
            marginTop: 12, gap: 10,
          }}
        >
          <button
            onClick={back}
            disabled={isFirst}
            style={{
              padding: '5px 12px',
              background: 'transparent', color: isFirst ? '#4a5564' : '#d8e4ee',
              border: `1px solid ${isFirst ? '#2a3d50' : '#4a6275'}`,
              borderRadius: 4, cursor: isFirst ? 'default' : 'pointer',
              fontFamily: 'inherit', fontSize: 11, letterSpacing: '0.08em',
              // flexShrink:0 + whiteSpace:nowrap keep "‹ BACK" / "NEXT ›"
              // on a single line — at 26 steps the dot strip below was
              // eating enough width to wrap the labels onto two lines.
              flexShrink: 0, whiteSpace: 'nowrap',
            }}
          >{t('tutorial.back')}</button>

          {/* Progress dots — clickable for jumping (handy for players
              who want to re-read an earlier step). minWidth:0 +
              overflow:hidden lets the strip shrink before the side
              buttons do, so the tour-step pills never push BACK/NEXT
              into wrapping their labels.
              At >18 steps the dot row gets dense — drop to a compact
              "N / TOTAL" pill so the card stays readable instead. */}
          {/* The clock step's wide START leaves no room for the dots, and
              the header already says 12 / 12. */}
          {clockStep && !taskDone ? <span style={{ flex: '1 1 auto' }} /> : TUTORIAL_STEPS.length <= 18 ? (
            <div
              style={{
                display: 'flex', gap: 3, flex: '1 1 auto',
                minWidth: 0, justifyContent: 'center',
                // One row: PT's longer BACK / skip labels wrapped it.
                flexWrap: 'nowrap', overflow: 'hidden',
              }}
            >
              {TUTORIAL_STEPS.map((_, i) => (
                <button
                  key={i}
                  onClick={() => jumpTo(i)}
                  title={t('tutorial.stepOf', { n: i + 1, total: TUTORIAL_STEPS.length })}
                  style={{
                    // min-* beat the phone shell's 40px floor on every
                    // button, which drew these as tall ovals.
                    width: 6, height: 6, minWidth: 6, minHeight: 6, flex: '0 0 6px',
                    borderRadius: '50%', padding: 0,
                    background: i === index ? '#ffb84d' : '#2a3d50',
                    border: 'none', cursor: 'pointer',
                    transition: 'background 0.18s',
                  }}
                />
              ))}
            </div>
          ) : (
            <div
              style={{
                flex: '1 1 auto', minWidth: 0, textAlign: 'center',
                fontSize: 10, color: '#b8c8d6', letterSpacing: '0.1em',
                fontVariantNumeric: 'tabular-nums',
              }}
              title={t('tutorial.progress')}
            >
              {index + 1} / {TUTORIAL_STEPS.length}
            </div>
          )}

          {clockStep && !taskDone ? (
            // The clock step's own START: the top bar's can sit off the
            // edge of a phone (playtest, 2026-10-24).
            <button
              onClick={startClock}
              data-testid="tutorial-start-clock"
              style={{
                padding: '5px 14px',
                background: '#ffb84d', color: '#0a1018',
                border: 'none', borderRadius: 4, cursor: 'pointer',
                fontFamily: 'inherit', fontSize: 11, fontWeight: 700, letterSpacing: '0.08em',
                flexShrink: 0, whiteSpace: 'nowrap',
              }}
            >{t('tutorial.startClock')}</button>
          ) : step.task && !taskDone ? (
            // Task pending: NEXT is replaced by a quiet escape hatch so
            // nobody hard-stucks (broke, weird state, just not feeling
            // it) — but the loud affordance is DOING the task.
            <button
              onClick={goNext}
              title={t('tutorial.skipTaskTitle')}
              style={{
                padding: '5px 12px',
                background: 'transparent', color: '#8fa8bf',
                border: '1px solid #2a3d50', borderRadius: 4, cursor: 'pointer',
                fontFamily: 'inherit', fontSize: 10, letterSpacing: '0.06em',
                flexShrink: 0, whiteSpace: 'nowrap',
              }}
            >{t('tutorial.skipTask')}</button>
          ) : (
            <button
              onClick={goNext}
              style={{
                padding: '5px 14px',
                background: taskDone ? '#7fffa1' : '#ffb84d', color: '#0a1018',
                border: 'none', borderRadius: 4, cursor: 'pointer',
                fontFamily: 'inherit', fontSize: 11, fontWeight: 700, letterSpacing: '0.08em',
                flexShrink: 0, whiteSpace: 'nowrap',
                transition: 'background 0.25s',
              }}
            >{isLast ? t('tutorial.done') : t('tutorial.next')}</button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
};
