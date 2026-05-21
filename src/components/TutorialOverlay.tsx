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
import { TUTORIAL_STEPS, TutorialStep } from '../game/tutorialSteps';

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Walk the DOM for the element matching `data-tutorial-id`. Returns
 *  null if missing (the corresponding component may not be mounted
 *  yet — overlay falls back to a centered card). */
function findTarget(targetId: string | null): Element | null {
  if (!targetId) return null;
  return document.querySelector(`[data-tutorial-id="${targetId}"]`);
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

/** Compute where to place the coachmark card relative to the target.
 *  Falls back to centered when target is null or off-screen. */
function placeCard(
  targetRect: Rect | null,
  placement: TutorialStep['placement'],
  viewport: { width: number; height: number },
  cardSize: { width: number; height: number },
): { x: number; y: number } {
  const GAP = 14;
  if (!targetRect || placement === 'center') {
    return {
      x: Math.max(0, (viewport.width - cardSize.width) / 2),
      y: Math.max(0, (viewport.height - cardSize.height) / 2),
    };
  }
  let x = targetRect.x + targetRect.width / 2 - cardSize.width / 2;
  let y = targetRect.y + targetRect.height / 2 - cardSize.height / 2;
  if (placement === 'above')  y = targetRect.y - cardSize.height - GAP;
  if (placement === 'below')  y = targetRect.y + targetRect.height + GAP;
  if (placement === 'left')   x = targetRect.x - cardSize.width - GAP;
  if (placement === 'right')  x = targetRect.x + targetRect.width + GAP;
  // Clamp to viewport with a small margin so the card never goes off-screen.
  const MARGIN = 8;
  x = Math.max(MARGIN, Math.min(x, viewport.width - cardSize.width - MARGIN));
  y = Math.max(MARGIN, Math.min(y, viewport.height - cardSize.height - MARGIN));
  return { x, y };
}

export const TutorialOverlay: React.FC = () => {
  const { active, index, advance, back, skip, finish, jumpTo } = useTutorial();
  const { gameState, selectBody, selectShip } = useGameContext();
  const [targetRect, setTargetRect] = useState<Rect | null>(null);
  // Extra cutout rects for steps that highlight more than one element
  // (e.g. select-body highlights the Outliner AND the freshly-opened
  // BodyInspector so the inspector doesn't sit dimmed behind the
  // backdrop while the card talks about it).
  const [extraRects, setExtraRects] = useState<Rect[]>([]);
  const [viewport, setViewport] = useState({
    width: typeof window !== 'undefined' ? window.innerWidth : 1280,
    height: typeof window !== 'undefined' ? window.innerHeight : 800,
  });
  const cardRef = useRef<HTMLDivElement>(null);
  const [cardSize, setCardSize] = useState({ width: 360, height: 180 });

  const step = active && index >= 0 ? TUTORIAL_STEPS[index] : null;

  // Auto-select a body / ship when the tour reaches the
  // 'select-body' / 'select-ship' steps so the BodyInspector and
  // ShipPanel actually mount — otherwise the subsequent inspector /
  // panel steps would point at elements that don't exist yet and the
  // overlay would fall back to a centered card with no halo.
  //
  // Picks the first PLAYER-owned target. If the player has nothing
  // (rare — they'd have already lost), we silently skip and the
  // panel-deep-dive steps degrade to centered cards.
  useEffect(() => {
    if (!step) return;
    if (step.id === 'select-body') {
      const mine = gameState.settlements.find(s => s.ownedBy === 'player');
      if (mine) selectBody(mine.bodyId);
    } else if (step.id === 'select-ship') {
      const mine = gameState.ships.find(s => s.ownedBy === 'player');
      if (mine) selectShip(mine.id);
    }
    // gameState.settlements/ships intentionally NOT in deps — we only
    // want this to fire on step change, not whenever the world ticks.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step?.id]);

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
    let lastPrimary: Rect | null = null;
    let lastExtras: Rect[] = [];
    const tick = () => {
      // Primary target — drives card placement + outline halo
      const el = findTarget(step.target);
      const nextPrimary: Rect | null = el ? snapRect(el.getBoundingClientRect()) : null;
      if (rectsDiffer(lastPrimary, nextPrimary)) {
        lastPrimary = nextPrimary;
        setTargetRect(nextPrimary);
      }
      // Extra targets — additional cutouts; placement is not affected.
      // Missing anchors are silently filtered (panel hasn't mounted
      // yet, etc) so a typo or auto-open race doesn't break the step.
      const nextExtras: Rect[] = [];
      for (const id of step.extraTargets ?? []) {
        const ee = findTarget(id);
        if (!ee) continue;
        nextExtras.push(snapRect(ee.getBoundingClientRect()));
      }
      if (rectArraysDiffer(lastExtras, nextExtras)) {
        lastExtras = nextExtras;
        setExtraRects(nextExtras);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [step]);

  useEffect(() => {
    const onResize = () => setViewport({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // Measure the actual card so placement math accounts for the real
  // height (varies by body length). Layout effect ensures we have
  // measurements before paint to avoid a flash.
  useLayoutEffect(() => {
    if (!cardRef.current) return;
    const r = cardRef.current.getBoundingClientRect();
    if (Math.abs(r.width - cardSize.width) > 1 || Math.abs(r.height - cardSize.height) > 1) {
      setCardSize({ width: r.width, height: r.height });
    }
  }, [step, cardSize.width, cardSize.height]);

  // Keyboard: Esc skips, Enter / Right advances, Left goes back.
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
      if (e.key === 'Escape') skip();
      else if (e.key === 'ArrowRight' || e.key === 'Enter') {
        if (index === TUTORIAL_STEPS.length - 1) finish();
        else advance();
      }
      else if (e.key === 'ArrowLeft') back();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, index, advance, back, skip, finish]);

  if (!step) return null;

  const isLast = index === TUTORIAL_STEPS.length - 1;
  const isFirst = index === 0;
  const cardPos = placeCard(targetRect, step.placement, viewport, cardSize);

  return createPortal(
    <div
      role="dialog"
      aria-label="Tutorial"
      aria-live="polite"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 3000,
        pointerEvents: 'none', // backdrop is purely visual; controls handle clicks themselves
        fontFamily: "'JetBrains Mono', monospace",
      }}
    >
      {/* Dim backdrop with the target rect cut out via even-odd fill.
          Click intercepts skip — but only if there's no target (centered
          steps), so target-aware steps don't accidentally dismiss the
          tour when the player tries to click the highlighted element. */}
      <svg
        width={viewport.width}
        height={viewport.height}
        style={{
          position: 'absolute', inset: 0,
          pointerEvents: targetRect ? 'none' : 'auto',
        }}
        onClick={targetRect ? undefined : skip}
      >
        <defs>
          <mask id="tutorial-cutout">
            <rect x={0} y={0} width={viewport.width} height={viewport.height} fill="white" />
            {/* Primary cutout — full halo around the step's main target. */}
            {targetRect && (() => {
              const p = padRect(targetRect);
              return <rect x={p.x} y={p.y} width={p.width} height={p.height} rx={6} fill="black" />;
            })()}
            {/* Extra cutouts — each gets the same un-dimmed treatment so
                a multi-anchor step (e.g. Outliner + freshly-opened
                BodyInspector) doesn't leave half its anchors lurking in
                the dark. */}
            {extraRects.map((r, i) => {
              const p = padRect(r);
              return <rect key={i} x={p.x} y={p.y} width={p.width} height={p.height} rx={6} fill="black" />;
            })}
          </mask>
        </defs>
        <rect
          x={0} y={0}
          width={viewport.width} height={viewport.height}
          fill="rgba(5, 8, 14, 0.66)"
          mask="url(#tutorial-cutout)"
        />
        {/* Outline ring around the primary target — bright amber so it
            reads as "look here." */}
        {targetRect && (() => {
          const p = padRect(targetRect);
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
        {extraRects.map((r, i) => {
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
            TUTORIAL · {index + 1} / {TUTORIAL_STEPS.length}
          </div>
          <button
            onClick={skip}
            title="Skip tour (Esc)"
            style={{
              background: 'transparent', color: '#b8c8d6',
              border: 'none', fontSize: 10, cursor: 'pointer',
              letterSpacing: '0.08em',
            }}
          >SKIP</button>
        </div>
        <div style={{ fontSize: 15, fontWeight: 700, color: '#ffb84d', marginBottom: 6 }}>
          {step.title}
        </div>
        <div style={{ fontSize: 12, lineHeight: 1.45, color: '#d8e4ee' }}>
          {step.body}
        </div>
        <div
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
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
          >‹ BACK</button>

          {/* Progress dots — clickable for jumping (handy for players
              who want to re-read an earlier step). minWidth:0 +
              overflow:hidden lets the strip shrink before the side
              buttons do, so the tour-step pills never push BACK/NEXT
              into wrapping their labels.
              At >18 steps the dot row gets dense — drop to a compact
              "N / TOTAL" pill so the card stays readable instead. */}
          {TUTORIAL_STEPS.length <= 18 ? (
            <div
              style={{
                display: 'flex', gap: 4, flex: '1 1 auto',
                minWidth: 0, justifyContent: 'center',
                flexWrap: 'wrap',
              }}
            >
              {TUTORIAL_STEPS.map((_, i) => (
                <button
                  key={i}
                  onClick={() => jumpTo(i)}
                  title={`Step ${i + 1} of ${TUTORIAL_STEPS.length}`}
                  style={{
                    width: 6, height: 6, borderRadius: '50%', padding: 0,
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
              title="Tutorial progress"
            >
              {index + 1} / {TUTORIAL_STEPS.length}
            </div>
          )}

          <button
            onClick={() => isLast ? finish() : advance()}
            style={{
              padding: '5px 14px',
              background: '#ffb84d', color: '#0a1018',
              border: 'none', borderRadius: 4, cursor: 'pointer',
              fontFamily: 'inherit', fontSize: 11, fontWeight: 700, letterSpacing: '0.08em',
              flexShrink: 0, whiteSpace: 'nowrap',
            }}
          >{isLast ? 'DONE ▸' : 'NEXT ›'}</button>
        </div>
      </div>
    </div>,
    document.body,
  );
};
