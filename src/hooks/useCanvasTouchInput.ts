// ============================================================
// useCanvasTouchInput — touch gesture layer for the map canvas.
//
//   • single finger drag  → pan            (normal mode)
//   • single finger drag  → selection box  (selection mode)
//   • two fingers         → pinch-zoom AND pan, together
//   • tap (no drag)       → select         (delegated to onTap)
//   • double-tap          → focus body     (delegated to onDoubleTap)
//   • long-press (400ms)  → onLongPress; keep the finger down and drag
//                           to draw a selection box straight away
//
// Mouse events on the canvas are unaffected — this only handles
// pointers of type 'touch'.
//
// WHY ONE-FINGER DRAG STAYS PAN. Every mobile strategy game that
// shipped multi-select kept the most common gesture for the most
// common job, and moved box-select behind a hold (Rome II, Mindustry)
// or a mode. The one that put a command wheel on hold instead,
// Company of Heroes, was criticised for exactly that: players kept
// triggering it while trying to pan. So a drag only draws a box when
// the player has ASKED for one — by holding first, or by being in
// selection mode — and in selection mode two fingers still pan.
// ============================================================

import { useEffect, useRef } from 'react';
import { getWorldMenuMaxScale } from '../game/worldMenu/store';

interface CameraLike {
  x: number;
  y: number;
  scale: number;
}

/** Callbacks for a touch-drawn selection box, all in canvas-local px. */
export interface TouchBoxHandlers {
  start: (canvasX: number, canvasY: number) => void;
  move: (canvasX: number, canvasY: number) => void;
  end: (canvasX: number, canvasY: number) => void;
  /** A second finger landed, or the gesture was taken away: drop the box
   *  without selecting anything. */
  cancel: () => void;
}

interface TouchInputOptions {
  canvasRef: React.RefObject<HTMLCanvasElement>;
  camera: CameraLike;
  updateCamera: (partial: Partial<CameraLike>) => void;
  /** Fired on a tap (no significant movement, single finger). Canvas-local x/y. */
  onTap: (canvasX: number, canvasY: number) => void;
  /** Fired on a double-tap. Canvas-local x/y. */
  onDoubleTap: (canvasX: number, canvasY: number) => void;
  /** Fired when a finger has been held still for LONG_PRESS_MS. Canvas-
   *  local x/y. Return true if the press was USED (it selected something
   *  or entered a mode): the finger may then drag straight on into a
   *  selection box. Return false to let the gesture fall through to
   *  nothing, as if the finger had just rested there. */
  onLongPress?: (canvasX: number, canvasY: number) => boolean;
  /** Is selection mode on right now? Read on every gesture rather than
   *  bound once, because the long-press that turns it on happens in the
   *  middle of the very gesture that should then draw the box. */
  isSelectMode?: () => boolean;
  /** The selection box. Without it, drags only ever pan. */
  box?: TouchBoxHandlers;
  /** Optional: when the user starts a pan with a focused body set (camera
   *  follows that body each frame), the stored camera.x/y is stale —
   *  usually the pre-focus origin (0,0). Panning from those stale values
   *  jolts the camera to world (0,0), i.e. the Sun. Supply this callback
   *  to return the focused body's CURRENT world position; the hook uses
   *  it as the panning origin instead. Matches the desktop mousedown
   *  path's snapshot-before-release behaviour in MapCanvas. */
  getReleaseFocusPos?: () => { x: number; y: number } | null;
}

/** What a single finger has turned out to be doing. It starts undecided
 *  and commits the first time it moves past the slop or the long-press
 *  timer fires, and never changes its mind after that. */
type Gesture = 'undecided' | 'pan' | 'held' | 'box';

interface ActivePointer {
  id: number;
  startX: number;
  startY: number;
  startTime: number;
  x: number;
  y: number;
  gesture: Gesture;
}

// Android's own ViewConfiguration defaults are a 400ms long press and an
// 8dp touch slop. The slop here is a little wider than 8 because a finger
// on a moving map drifts more than one on a still list, and a tap that
// turns into a pan by accident is the most annoying failure there is.
export const TAP_MOVE_TOLERANCE = 12;   // px — drift allowed before a touch is a drag
export const TAP_MAX_DURATION = 350;    // ms
export const DOUBLE_TAP_GAP = 320;      // ms between taps
export const DOUBLE_TAP_DISTANCE = 32;  // px between tap centres
export const LONG_PRESS_MS = 400;

/**
 * Wire touch gestures onto a canvas element. Returns nothing; cleanup is
 * automatic on unmount. Mouse events are left untouched so desktop behavior
 * is preserved.
 */
export function useCanvasTouchInput({
  canvasRef,
  camera,
  updateCamera,
  onTap,
  onDoubleTap,
  onLongPress,
  isSelectMode,
  box,
  getReleaseFocusPos,
}: TouchInputOptions) {
  // Keep camera in a ref so the effect doesn't re-bind on every tiny update.
  const cameraRef = useRef(camera);
  cameraRef.current = camera;

  const updateCameraRef = useRef(updateCamera);
  updateCameraRef.current = updateCamera;

  const callbacksRef = useRef({ onTap, onDoubleTap, onLongPress, isSelectMode, box });
  callbacksRef.current = { onTap, onDoubleTap, onLongPress, isSelectMode, box };

  const getReleaseFocusPosRef = useRef(getReleaseFocusPos);
  getReleaseFocusPosRef.current = getReleaseFocusPos;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const pointers = new Map<number, ActivePointer>();
    let pinchStartDist = 0;
    let pinchStartScale = 1;
    /** The two-finger midpoint on the previous move, in canvas px. The
     *  pinch zooms around it AND follows it, so two fingers pan too. */
    let lastMid: { x: number; y: number } | null = null;
    let lastTap: { time: number; x: number; y: number } | null = null;
    let longPressTimer: ReturnType<typeof setTimeout> | null = null;

    const clearLongPress = () => {
      if (longPressTimer) {
        clearTimeout(longPressTimer);
        longPressTimer = null;
      }
    };

    const canvasLocal = (clientX: number, clientY: number) => {
      const rect = canvas.getBoundingClientRect();
      return { x: clientX - rect.left, y: clientY - rect.top };
    };

    const selectModeOn = () => !!callbacksRef.current.isSelectMode?.();

    /** Drop any box in progress on the only finger that could own one. */
    const cancelBoxes = () => {
      for (const p of pointers.values()) {
        if (p.gesture === 'box') {
          callbacksRef.current.box?.cancel();
          p.gesture = 'pan';
        } else if (p.gesture === 'held' || p.gesture === 'undecided') {
          p.gesture = 'pan';
        }
      }
    };

    /** Release a sticky body focus, seeding x/y from where the camera
     *  visually is so the view does not snap to a stale origin. */
    const releaseFocus = () => {
      const cam = cameraRef.current as CameraLike & { focusedBodyId?: string };
      if (!cam.focusedBodyId) return;
      const focusPos = getReleaseFocusPosRef.current?.();
      const next = {
        ...cam,
        ...(focusPos ? { x: focusPos.x, y: focusPos.y } : {}),
        focusedBodyId: undefined,
      };
      cameraRef.current = next;
      updateCameraRef.current({
        ...(focusPos ? { x: focusPos.x, y: focusPos.y } : {}),
        focusedBodyId: undefined,
      } as Partial<CameraLike> & { focusedBodyId?: string | undefined });
    };

    const panBy = (dx: number, dy: number) => {
      // CRITICAL: if a focused body is sticky (initial-focus puts the
      // camera on the player's capital on first load), the renderer's
      // effectiveCamera() overrides cam.x/y with the body's position every
      // frame — so panning silently does nothing until the focus drops.
      // SNAPSHOT-BEFORE-RELEASE: cam.x/y is stale while focused, usually
      // the Sun at (0,0), so release from where the camera visually is.
      releaseFocus();
      const cam = cameraRef.current;
      const newX = cam.x - dx / cam.scale;
      const newY = cam.y - dy / cam.scale;
      // Written into the ref synchronously too, so a second pointermove
      // arriving before React commits this one does not pan from the old
      // value and jitter.
      cameraRef.current = { ...cam, x: newX, y: newY };
      updateCameraRef.current({ x: newX, y: newY });
    };

    const onPointerDown = (e: PointerEvent) => {
      // Only handle touch — leave mouse / pen to the existing handlers.
      if (e.pointerType !== 'touch') return;
      // Prevent the page from interpreting this as scroll / pull-to-refresh.
      e.preventDefault();
      // Capture keeps a drag's moves coming when the finger leaves the
      // canvas. It THROWS if the pointer is no longer active by the time
      // the handler runs (a finger lifted mid-dispatch), and an uncaught
      // throw here dropped the finger from the gesture entirely -- a
      // pinch that silently became a one-finger drag.
      try { canvas.setPointerCapture(e.pointerId); } catch { /* not capturable: track it anyway */ }

      const local = canvasLocal(e.clientX, e.clientY);
      pointers.set(e.pointerId, {
        id: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        startTime: performance.now(),
        x: e.clientX,
        y: e.clientY,
        gesture: 'undecided',
      });

      if (pointers.size === 2) {
        // A SECOND FINGER ENDS ANY SINGLE-FINGER GESTURE. A half-drawn box
        // is dropped rather than committed: the player has moved on to
        // zooming, and selecting whatever the box happened to cover at
        // that instant would be a surprise.
        clearLongPress();
        cancelBoxes();
        const [a, b] = Array.from(pointers.values());
        pinchStartDist = Math.hypot(a.x - b.x, a.y - b.y);
        pinchStartScale = cameraRef.current.scale;
        const ma = canvasLocal(a.x, a.y), mb = canvasLocal(b.x, b.y);
        lastMid = { x: (ma.x + mb.x) / 2, y: (ma.y + mb.y) / 2 };
        releaseFocus();
      } else if (pointers.size === 1 && callbacksRef.current.onLongPress) {
        clearLongPress();
        longPressTimer = setTimeout(() => {
          longPressTimer = null;
          const p = pointers.get(e.pointerId);
          if (!p || p.gesture !== 'undecided' || pointers.size !== 1) return;
          const used = callbacksRef.current.onLongPress?.(local.x, local.y) ?? false;
          // Either way it is no longer a tap. If the press was used, a
          // drag from here draws a box.
          p.gesture = used ? 'held' : 'pan';
        }, LONG_PRESS_MS);
      }
    };

    const onPointerMove = (e: PointerEvent) => {
      if (e.pointerType !== 'touch') return;
      const p = pointers.get(e.pointerId);
      if (!p) return;
      e.preventDefault();

      const dx = e.clientX - p.x;
      const dy = e.clientY - p.y;
      p.x = e.clientX;
      p.y = e.clientY;

      if (pointers.size === 2) {
        const [a, b] = Array.from(pointers.values());
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        const ma = canvasLocal(a.x, a.y), mb = canvasLocal(b.x, b.y);
        const mid = { x: (ma.x + mb.x) / 2, y: (ma.y + mb.y) / 2 };
        if (pinchStartDist > 0 && lastMid) {
          // MIN_SCALE 0.0012 — frames both Centauri (+265K east) and
          // Cygnus X (-340K west) at full zoom-out on a typical viewport.
          // Stay in sync with MapCanvas.tsx wheel-zoom clamp. Max comes
          // from the world-menu store: raised in MP menu dives.
          const targetScale = Math.max(0.0012, Math.min(getWorldMenuMaxScale(),
            pinchStartScale * (dist / pinchStartDist)));
          // ZOOM AND PAN IN ONE STEP. The world point that was under the
          // fingers' midpoint last frame is put under the midpoint where
          // it is now, at the new scale. Zooming "around the midpoint"
          // alone never moved the view, so two fingers could not pan —
          // and in selection mode two fingers are the only way to pan.
          const cam = cameraRef.current;
          const worldX = cam.x + (lastMid.x - canvas.width / 2) / cam.scale;
          const worldY = cam.y + (lastMid.y - canvas.height / 2) / cam.scale;
          const newCamX = worldX - (mid.x - canvas.width / 2) / targetScale;
          const newCamY = worldY - (mid.y - canvas.height / 2) / targetScale;
          cameraRef.current = { ...cam, x: newCamX, y: newCamY, scale: targetScale };
          updateCameraRef.current({ x: newCamX, y: newCamY, scale: targetScale });
        }
        lastMid = mid;
        return;
      }

      if (pointers.size !== 1) return;
      const fromStart = Math.hypot(e.clientX - p.startX, e.clientY - p.startY);

      if (p.gesture === 'undecided') {
        if (selectModeOn() && callbacksRef.current.box) {
          // In selection mode a drag is a box, so nothing moves while the
          // finger is still inside the slop: a wobbling tap must not nudge
          // the map out from under the ship it is aimed at.
          if (fromStart > TAP_MOVE_TOLERANCE) {
            clearLongPress();
            const s = canvasLocal(p.startX, p.startY);
            const c = canvasLocal(e.clientX, e.clientY);
            p.gesture = 'box';
            callbacksRef.current.box.start(s.x, s.y);
            callbacksRef.current.box.move(c.x, c.y);
          }
          return;
        }
        // Normal mode pans from the first pixel, as it always has, and
        // commits to a pan once it is clearly not a tap.
        panBy(dx, dy);
        if (fromStart > TAP_MOVE_TOLERANCE) {
          clearLongPress();
          p.gesture = 'pan';
        }
        return;
      }

      if (p.gesture === 'held') {
        // The long press was used; dragging on from it draws a box from
        // where the finger first went down.
        if (fromStart > TAP_MOVE_TOLERANCE && callbacksRef.current.box) {
          const s = canvasLocal(p.startX, p.startY);
          const c = canvasLocal(e.clientX, e.clientY);
          p.gesture = 'box';
          callbacksRef.current.box.start(s.x, s.y);
          callbacksRef.current.box.move(c.x, c.y);
        }
        return;
      }

      if (p.gesture === 'box') {
        const c = canvasLocal(e.clientX, e.clientY);
        callbacksRef.current.box?.move(c.x, c.y);
        return;
      }

      // 'pan'
      panBy(dx, dy);
    };

    const onPointerUp = (e: PointerEvent) => {
      if (e.pointerType !== 'touch') return;
      const p = pointers.get(e.pointerId);
      if (!p) return;
      clearLongPress();

      const wasSinglePointer = pointers.size === 1;
      pointers.delete(e.pointerId);
      try { canvas.releasePointerCapture(e.pointerId); } catch { /* ignore */ }

      // If a 2-finger pinch just ended with one finger still down, reset
      // the pinch baseline and let the leftover finger pan, not tap.
      if (pointers.size === 1) {
        pinchStartDist = 0;
        lastMid = null;
        for (const rest of pointers.values()) rest.gesture = 'pan';
        return;
      }
      if (pointers.size === 0) lastMid = null;

      if (!wasSinglePointer) return;

      if (p.gesture === 'box') {
        const c = canvasLocal(e.clientX, e.clientY);
        callbacksRef.current.box?.end(c.x, c.y);
        return;
      }
      // A used long press or a committed pan is not a tap.
      if (p.gesture !== 'undecided') return;

      const duration = performance.now() - p.startTime;
      const totalMove = Math.hypot(e.clientX - p.startX, e.clientY - p.startY);
      const isTap = totalMove < TAP_MOVE_TOLERANCE && duration < TAP_MAX_DURATION;
      if (!isTap) return;

      const local = canvasLocal(e.clientX, e.clientY);
      const now = performance.now();
      if (lastTap && now - lastTap.time < DOUBLE_TAP_GAP) {
        const gap = Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y);
        if (gap < DOUBLE_TAP_DISTANCE) {
          callbacksRef.current.onDoubleTap(local.x, local.y);
          lastTap = null;
          return;
        }
      }
      lastTap = { time: now, x: e.clientX, y: e.clientY };
      callbacksRef.current.onTap(local.x, local.y);
    };

    const onPointerCancel = (e: PointerEvent) => {
      if (e.pointerType !== 'touch') return;
      const p = pointers.get(e.pointerId);
      if (p?.gesture === 'box') callbacksRef.current.box?.cancel();
      pointers.delete(e.pointerId);
      clearLongPress();
      if (pointers.size < 2) { pinchStartDist = 0; lastMid = null; }
    };

    // Prevent the page from scrolling / zooming while the user is interacting
    // with the canvas. touchstart on a captured canvas is also a safe default.
    const blockTouch = (e: TouchEvent) => {
      if (e.cancelable) e.preventDefault();
    };

    // iOS Safari sends non-standard `gesture*` events for multi-touch
    // and will hijack a two-finger pinch into a native page zoom even
    // when `touch-action: none` is set on the canvas. Block them so
    // our PointerEvents own the pinch unchallenged.
    const blockGesture = (e: Event) => { e.preventDefault(); };

    // Chrome on Android fires contextmenu on a long press, and if the
    // browser's own menu gets to open it cancels our pointer mid-gesture
    // — which would drop the box the long press is about to start.
    const blockContextMenu = (e: Event) => { e.preventDefault(); };

    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointercancel', onPointerCancel);
    canvas.addEventListener('touchstart', blockTouch, { passive: false });
    canvas.addEventListener('touchmove', blockTouch, { passive: false });
    canvas.addEventListener('contextmenu', blockContextMenu);
    canvas.addEventListener('gesturestart', blockGesture as EventListener, { passive: false });
    canvas.addEventListener('gesturechange', blockGesture as EventListener, { passive: false });
    canvas.addEventListener('gestureend', blockGesture as EventListener, { passive: false });

    return () => {
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerCancel);
      canvas.removeEventListener('touchstart', blockTouch);
      canvas.removeEventListener('touchmove', blockTouch);
      canvas.removeEventListener('contextmenu', blockContextMenu);
      canvas.removeEventListener('gesturestart', blockGesture as EventListener);
      canvas.removeEventListener('gesturechange', blockGesture as EventListener);
      canvas.removeEventListener('gestureend', blockGesture as EventListener);
      clearLongPress();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canvasRef]);
}
