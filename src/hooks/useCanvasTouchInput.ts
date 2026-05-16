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
}: TouchInputOptions) {
  // Keep camera in a ref so the effect doesn't re-bind on every tiny update.
  const cameraRef = useRef(camera);
  cameraRef.current = camera;

  const updateCameraRef = useRef(updateCamera);
  updateCameraRef.current = updateCamera;

  const callbacksRef = useRef({ onTap, onDoubleTap, onLongPress });
  callbacksRef.current = { onTap, onDoubleTap, onLongPress };

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
          const targetScale = Math.max(0.005, Math.min(50, pinchStartScale * (dist / pinchStartDist)));
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
        const cam = cameraRef.current;
        updateCameraRef.current({
          x: cam.x - dx / cam.scale,
          y: cam.y - dy / cam.scale,
        });
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

    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointercancel', onPointerCancel);
    canvas.addEventListener('touchstart', blockTouch, { passive: false });
    canvas.addEventListener('touchmove', blockTouch, { passive: false });

    return () => {
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerCancel);
      canvas.removeEventListener('touchstart', blockTouch);
      canvas.removeEventListener('touchmove', blockTouch);
      clearLongPress();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canvasRef]);
}
