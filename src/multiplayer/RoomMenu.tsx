// ============================================================
// RoomMenu — a small "more" menu: the header's overflow (leave lobby, delete
// room) and each player row's actions (remove from room).
//
// Quiet on purpose: the destructive things used to be loud buttons on the
// main surface. They live behind one icon button now, and each item still
// asks its own confirmation before doing anything.
//
// Keyboard: Enter/Space/ArrowDown on the button opens it and focuses the first
// item; arrows move, Home/End jump, Escape closes and gives the focus back;
// Tab leaves it (and closes). A press outside closes it.
// ============================================================

import React, { useCallback, useEffect, useRef, useState } from 'react';

export interface RoomMenuItem {
  key: string;
  label: string;
  onSelect: () => void;
  danger?: boolean;
  title?: string;
}

export function RoomMenu({ label, icon, items, className, align = 'right' }: {
  /** The icon button's accessible name. */
  label: string;
  icon: React.ReactNode;
  items: RoomMenuItem[];
  className?: string;
  align?: 'left' | 'right';
}) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);

  const close = useCallback((refocus: boolean) => {
    setOpen(false);
    if (refocus) btn.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    list.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const onDown = (e: PointerEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open]);

  const onListKey = (e: React.KeyboardEvent) => {
    const els = Array.from(list.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
    const i = els.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'Escape') { e.preventDefault(); close(true); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); els[(i + 1) % els.length]?.focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); els[(i - 1 + els.length) % els.length]?.focus(); }
    else if (e.key === 'Home') { e.preventDefault(); els[0]?.focus(); }
    else if (e.key === 'End') { e.preventDefault(); els[els.length - 1]?.focus(); }
    else if (e.key === 'Tab') setOpen(false);
  };

  if (items.length === 0) return null;
  return (
    <div className={`rl-menu ${className ?? ''}`} ref={wrap}>
      <button
        ref={btn}
        type="button"
        className="rl-ibtn"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => { if (e.key === 'ArrowDown' && !open) { e.preventDefault(); setOpen(true); } }}
      >
        {icon}
      </button>
      {open && (
        <div
          ref={list}
          role="menu"
          aria-label={label}
          className={`rl-menu__list rl-menu__list--${align}`}
          onKeyDown={onListKey}
        >
          {items.map((it) => (
            <button
              key={it.key}
              type="button"
              role="menuitem"
              title={it.title}
              className={`rl-menu__item ${it.danger ? 'is-danger' : ''}`}
              onClick={() => { close(true); it.onSelect(); }}
            >
              {it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
