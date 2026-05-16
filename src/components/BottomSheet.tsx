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

  // Lock body scroll while a sheet is open on mobile so the page doesn't
  // bounce behind the sheet.
  useEffect(() => {
    if (!isMobile || !open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [isMobile, open]);

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

  return (
    <>
      <div
        className="bottom-sheet__scrim"
        onClick={onClose}
        aria-hidden
      />
      <div
        className="bottom-sheet"
        ref={sheetRef}
        role="dialog"
        aria-modal="true"
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
