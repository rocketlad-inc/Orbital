// ============================================================
// useCanvasTouchInput — touch gesture layer for the map canvas.
//   • single finger drag  → pan
//   • two-finger pinch    → zoom (around the gesture midpoint)
//   • tap (no drag)       → select (delegated to onTap)
//   • double-tap          → focus body (delegated to onDoubleTap)
//
// Mouse events on the canvas are unaffected — this only handles
// pointers of type 'touch'.
// ============================================================

import { useEffect, useRef } from 'react';

interface CameraLike {
  x: number;
  y: number;
  scale: number;
}

interface TouchInputOptions {
  canvasRef: React.RefObject<HTMLCanvasElement>;
  camera: CameraLike;
  updateCamera: (partial: Partial<CameraLike>) => void;
  /** Fired on a tap (no significant movement, single finger). Canvas-local x/y. */
  onTap: (canvasX: number, canvasY: number) => void;
  /** Fired on a double-tap. Canvas-local x/y. */
  onDoubleTap: (canvasX: number, canvasY: number) => void;
  /** Optional: fired on long-press (~500ms hold, no movement). */
  onLongPress?: (canvasX: number, canvasY: number) => void;
  /** Optional: when the user starts a pan with a focused body set (camera
   *  follows that body each frame), the stored camera.x/y is stale —
   *  usually the pre-focus origin (0,0). Panning from those stale values
   *  jolts the camera to world (0,0), i.e. the Sun. Supply this callback
   *  to return the focused body's CURRENT world position; the hook uses
   *  it as the panning origin instead. Matches the desktop mousedown
   *  path's snapshot-before-release behaviour in MapCanvas. */
  getReleaseFocusPos?: () => { x: number; y: number } | null;
}

interface ActivePointer {
  id: number;
  startX: number;
  startY: number;
  startTime: number;
  x: number;
  y: number;
  /** Cumulative movement since pointerdown (px). Used to disambiguate tap vs drag. */
  moved: number;
}

const TAP_MOVE_TOLERANCE = 12;     // px — how much you can drift and still count as a tap
const TAP_MAX_DURATION = 350;       // ms
const DOUBLE_TAP_GAP = 320;         // ms between taps
const DOUBLE_TAP_DISTANCE = 32;     // px between tap centers
const LONG_PRESS_MS = 500;

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
  getReleaseFocusPos,
}: TouchInputOptions) {
  // Keep camera in a ref so the effect doesn't re-bind on every tiny update.
  const cameraRef = useRef(camera);
  cameraRef.current = camera;

  const updateCameraRef = useRef(updateCamera);
  updateCameraRef.current = updateCamera;

  const callbacksRef = useRef({ onTap, onDoubleTap, onLongPress });
  callbacksRef.current = { onTap, onDoubleTap, onLongPress };

  const getReleaseFocusPosRef = useRef(getReleaseFocusPos);
  getReleaseFocusPosRef.current = getReleaseFocusPos;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const pointers = new Map<number, ActivePointer>();
    let pinchStartDist = 0;
    let pinchStartScale = 1;
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

    const onPointerDown = (e: PointerEvent) => {
      // Only handle touch — leave mouse / pen to the existing handlers.
      if (e.pointerType !== 'touch') return;
      // Prevent the page from interpreting this as scroll / pull-to-refresh.
      e.preventDefault();
      canvas.setPointerCapture(e.pointerId);

      const local = canvasLocal(e.clientX, e.clientY);
      pointers.set(e.pointerId, {
        id: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        startTime: performance.now(),
        x: e.clientX,
        y: e.clientY,
        moved: 0,
      });

      if (pointers.size === 2) {
        const [a, b] = Array.from(pointers.values());
        pinchStartDist = Math.hypot(a.x - b.x, a.y - b.y);
        pinchStartScale = cameraRef.current.scale;
        // Release any sticky body focus so the renderer's
        // effectiveCamera() stops overriding cam.x/y. Without this, the
        // pinch math happens correctly but the visual stays locked on
        // the focused body and the player only sees zoom, never the
        // pan-toward-midpoint that pinch is supposed to feel like.
        const cam2 = cameraRef.current as CameraLike & { focusedBodyId?: string };
        if (cam2.focusedBodyId) {
          updateCameraRef.current({ focusedBodyId: undefined } as Partial<CameraLike> & { focusedBodyId?: string | undefined });
        }
        clearLongPress();
      } else if (pointers.size === 1 && callbacksRef.current.onLongPress) {
        clearLongPress();
        longPressTimer = setTimeout(() => {
          const p = pointers.get(e.pointerId);
          if (p && p.moved < TAP_MOVE_TOLERANCE) {
            callbacksRef.current.onLongPress?.(local.x, local.y);
            // Mark so the upcoming pointerup doesn't also fire onTap.
            p.moved = TAP_MOVE_TOLERANCE + 1;
          }
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
      p.moved += Math.hypot(dx, dy);
      if (p.moved > TAP_MOVE_TOLERANCE) clearLongPress();

      if (pointers.size === 2) {
        // Pinch-zoom around the gesture midpoint, in canvas-local coords.
        const [a, b] = Array.from(pointers.values());
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        if (pinchStartDist > 0) {
          // MIN_SCALE 0.0012 — frames both Centauri (+265K east) and
          // Cygnus X (-340K west) at full zoom-out on a typical
          // viewport. Stay in sync with MapCanvas.tsx wheel-zoom
          // clamp; see the longer comment there for the history.
          const targetScale = Math.max(0.0012, Math.min(50, pinchStartScale * (dist / pinchStartDist)));
          // Zoom around the midpoint so the part of the world under the
          // gesture stays under the gesture.
          const midClientX = (a.x + b.x) / 2;
          const midClientY = (a.y + b.y) / 2;
          const rect = canvas.getBoundingClientRect();
          const midCanvasX = midClientX - rect.left;
          const midCanvasY = midClientY - rect.top;
          const cam = cameraRef.current;
          const worldX = cam.x + (midCanvasX - canvas.width / 2) / cam.scale;
          const worldY = cam.y + (midCanvasY - canvas.height / 2) / cam.scale;
          const newCamX = worldX - (midCanvasX - canvas.width / 2) / targetScale;
          const newCamY = worldY - (midCanvasY - canvas.height / 2) / targetScale;
          updateCameraRef.current({ x: newCamX, y: newCamY, scale: targetScale });
        }
      } else if (pointers.size === 1) {
        // One-finger drag = pan. Translate the camera in world units.
        //
        // CRITICAL: if a focused body is sticky (initial-focus puts the
        // camera on the player's capital on first load), the renderer's
        // effectiveCamera() overrides cam.x/y with the body's position
        // every frame — so panning silently does nothing until we drop
        // the focus. The desktop handler does this same release in
        // MapCanvas's mousedown; the touch handler was missing it,
        // which is why the player could pinch-zoom but couldn't pan.
        //
        // SNAPSHOT-BEFORE-RELEASE: when focusedBodyId is set, cam.x/y is
        // usually the stale pre-focus origin (0, 0) — the Sun. Panning
        // off `cam.x - dx/scale` from there yanked the camera straight
        // to the origin. Ask the consumer (MapCanvas) for the focused
        // body's CURRENT world position and pan from THAT instead, so
        // releasing focus is seamless — the screen continues from where
        // it was, not from a stored value that hasn't been touched all
        // game. Mirror of the desktop mousedown fix in MapCanvas.tsx
        // (search: "Snapshot the focused-body world pos instead").
        const cam = cameraRef.current as CameraLike & { focusedBodyId?: string };
        let originX = cam.x;
        let originY = cam.y;
        let releasingFocus = false;
        if (cam.focusedBodyId && getReleaseFocusPosRef.current) {
          const snap = getReleaseFocusPosRef.current();
          if (snap) { originX = snap.x; originY = snap.y; }
          releasingFocus = true;
        }
        const newX = originX - dx / cam.scale;
        const newY = originY - dy / cam.scale;
        const updates: Partial<CameraLike> & { focusedBodyId?: string | undefined } = {
          x: newX,
          y: newY,
        };
        if (releasingFocus) updates.focusedBodyId = undefined;
        // Write into the ref synchronously too so a follow-up pointermove
        // arriving before React commits this update doesn't see the stale
        // focused/origin values and re-snapshot (causing a small jitter
        // on the second move of the drag). React's prop will overwrite
        // this on next render — same end state.
        cameraRef.current = {
          ...cam,
          x: newX,
          y: newY,
          ...(releasingFocus ? { focusedBodyId: undefined } : {}),
        };
        updateCameraRef.current(updates);
      }
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
      // pinch baseline (don't immediately pan from the leftover finger).
      if (pointers.size === 1) {
        pinchStartDist = 0;
        return;
      }

      if (!wasSinglePointer) return;

      // Tap detection
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
      pointers.delete(e.pointerId);
      clearLongPress();
      if (pointers.size < 2) pinchStartDist = 0;
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

    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointercancel', onPointerCancel);
    canvas.addEventListener('touchstart', blockTouch, { passive: false });
    canvas.addEventListener('touchmove', blockTouch, { passive: false });
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
      canvas.removeEventListener('gesturestart', blockGesture as EventListener);
      canvas.removeEventListener('gesturechange', blockGesture as EventListener);
      canvas.removeEventListener('gestureend', blockGesture as EventListener);
      clearLongPress();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canvasRef]);
}
