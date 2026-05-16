// ============================================================
// BottomSheet — mobile-first panel container. On mobile it
// renders as a slide-up sheet from the bottom of the viewport.
// On desktop it's a no-op pass-through, so existing panels keep
// their original positioning.
// ============================================================

import React, { useEffect, useRef, useState } from 'react';
import { useIsMobile } from '../hooks/useIsMobile';
import './BottomSheet.css';

interface BottomSheetProps {
  open: boolean;
  onClose?: () => void;
  /** Sheet title shown on the drag handle bar. */
  title?: string;
  /** Optional class on the inner content container. */
  className?: string;
  /** Render-as for the inner content container. */
  children: React.ReactNode;
}

const DRAG_DISMISS_THRESHOLD = 80; // px downward swipe required to close

export const BottomSheet: React.FC<BottomSheetProps> = ({
  open,
  onClose,
  title,
  className,
  children,
}) => {
  const isMobile = useIsMobile();
  const sheetRef = useRef<HTMLDivElement>(null);
  const [dragY, setDragY] = useState(0);
  const dragStart = useRef<number | null>(null);

  // Body-scroll lock intentionally NOT applied: the map canvas is the
  // primary content and the sheet is a non-modal dock that the player
  // should be able to interact with WHILE still tapping bodies/ships on
  // the map (e.g. to plan a transfer target while a ship is selected).

  // Esc to close
  useEffect(() => {
    if (!isMobile || !open || !onClose) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isMobile, open, onClose]);

  // Desktop: pass-through. Children render where they always did.
  if (!isMobile) {
    return open ? <>{children}</> : null;
  }
  if (!open) return null;

  const onHandleDown = (e: React.PointerEvent) => {
    dragStart.current = e.clientY;
    setDragY(0);
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onHandleMove = (e: React.PointerEvent) => {
    if (dragStart.current === null) return;
    const delta = e.clientY - dragStart.current;
    setDragY(Math.max(0, delta));
  };
  const onHandleUp = (e: React.PointerEvent) => {
    if (dragStart.current === null) return;
    const delta = e.clientY - dragStart.current;
    dragStart.current = null;
    try { (e.target as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* */ }
    if (delta > DRAG_DISMISS_THRESHOLD && onClose) {
      onClose();
    }
    setDragY(0);
  };

  // No scrim — the map underneath stays fully interactive so the player
  // can keep clicking planets / ships while the sheet is open. aria-modal
  // is false for the same reason: this is a dock, not a modal.
  return (
    <>
      <div
        className="bottom-sheet"
        ref={sheetRef}
        role="dialog"
        aria-modal="false"
        aria-label={title ?? 'Panel'}
        style={{ transform: dragY > 0 ? `translateY(${dragY}px)` : undefined }}
      >
        <div
          className="bottom-sheet__handle-row"
          onPointerDown={onHandleDown}
          onPointerMove={onHandleMove}
          onPointerUp={onHandleUp}
          onPointerCancel={onHandleUp}
        >
          <div className="bottom-sheet__handle" />
          {title && <div className="bottom-sheet__title">{title}</div>}
          {onClose && (
            <button
              className="bottom-sheet__close"
              onClick={onClose}
              aria-label="Close"
            >
              ✕
            </button>
          )}
        </div>
        <div className={`bottom-sheet__body${className ? ` ${className}` : ''}`}>
          {children}
        </div>
      </div>
    </>
  );
};
