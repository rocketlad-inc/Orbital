// ============================================================
// TargetPriorityCards
//
// The ranked-card control for combat TARGET PRIORITY (migration 0064).
// Five categories, drag to reorder; rank 1 is engaged first. Shared by
// the ship card (single ship), the Fleet panel bulk bar, and the on-map
// group action bar — one drag model everywhere so the interaction only
// has to be learned once.
//
// Interaction: pointer-based drag (mouse AND touch — no HTML5 DnD,
// which doesn't exist on mobile). The lifted card follows the pointer
// raw (no transition); every other card slides to its proposed slot on
// a CSS transition, so the list continuously previews the drop. Small
// ▲▼ nudge buttons ride on each card as the keyboard/fallback path.
//
// AUTO vs CUSTOM: null priority means the server's peer-targeting
// default (match speed, tier ladder). The control renders the ladder
// greyed with an AUTO badge; the first drag or nudge commits a custom
// order. RESET returns to auto.
// ============================================================

import React, { useRef, useState } from 'react';
import type { TargetPriorityKey } from '../types';
import { TARGET_PRIORITY_DEFAULT } from '../types';
import './TargetPriorityCards.css';

const CATEGORY_META: Record<TargetPriorityKey, { label: string; sub: string; glyph: string }> = {
  corvette:   { label: 'CORVETTES',   sub: 'fast screens',          glyph: '▸' },
  frigate:    { label: 'FRIGATES',    sub: 'line warships',         glyph: '▶' },
  destroyer:  { label: 'DESTROYERS',  sub: 'heavy hitters',         glyph: '◆' },
  civilian:   { label: 'CIVILIANS',   sub: 'freighters + colony',   glyph: '○' },
  settlement: { label: 'SETTLEMENTS', sub: 'stations + cities',     glyph: '⬢' },
};

/** Height of one card INCLUDING its gap — must match the CSS. Drag math
 *  keys off this, so the two files move together or the preview drifts. */
const CARD_STRIDE = 40;

export interface TargetPriorityCardsProps {
  /** Current ranked order; null = auto (server default). */
  value: TargetPriorityKey[] | null;
  /** Fired with the new order on drop/nudge, or null on RESET. */
  onChange: (next: TargetPriorityKey[] | null) => void;
  disabled?: boolean;
  /** Extra line under the header, e.g. "applies to 4 ships". */
  note?: string | null;
}

export const TargetPriorityCards: React.FC<TargetPriorityCardsProps> = ({
  value, onChange, disabled, note,
}) => {
  const auto = value == null;
  const order = value ?? TARGET_PRIORITY_DEFAULT;

  // Drag state. dragIdx = which card is lifted; dy = raw pointer delta;
  // overIdx = the slot the card would land in if dropped now.
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [dy, setDy] = useState(0);
  const [overIdx, setOverIdx] = useState<number | null>(null);
  const startY = useRef(0);
  // The order at drag start — commit reorders against this so a re-render
  // mid-drag can't double-apply.
  const dragOrder = useRef<TargetPriorityKey[]>(order);

  const commit = (from: number, to: number) => {
    if (from === to) {
      // A no-move drop on an AUTO list is still an opt-in to custom —
      // the player grabbed a card, they meant to take manual control.
      if (auto) onChange([...dragOrder.current]);
      return;
    }
    const next = [...dragOrder.current];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    onChange(next);
  };

  const onPointerDown = (idx: number) => (e: React.PointerEvent) => {
    if (disabled) return;
    // Nudge buttons handle their own clicks — don't lift the card under them.
    if ((e.target as HTMLElement).closest('.tpc-nudge')) return;
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    dragOrder.current = order;
    startY.current = e.clientY;
    setDragIdx(idx);
    setOverIdx(idx);
    setDy(0);
  };

  const onPointerMove = (idx: number) => (e: React.PointerEvent) => {
    if (dragIdx !== idx) return;
    const delta = e.clientY - startY.current;
    setDy(delta);
    const proposed = Math.min(
      order.length - 1,
      Math.max(0, idx + Math.round(delta / CARD_STRIDE)),
    );
    setOverIdx(proposed);
  };

  const onPointerUp = (idx: number) => (e: React.PointerEvent) => {
    if (dragIdx !== idx) return;
    (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    const to = overIdx ?? idx;
    setDragIdx(null);
    setOverIdx(null);
    setDy(0);
    commit(idx, to);
  };

  const nudge = (idx: number, dir: -1 | 1) => {
    if (disabled) return;
    const to = idx + dir;
    if (to < 0 || to >= order.length) return;
    dragOrder.current = order;
    commit(idx, to);
  };

  return (
    <div className={`tpc${auto ? ' tpc--auto' : ''}${disabled ? ' tpc--disabled' : ''}`}>
      <div className="tpc-head">
        <span className="tpc-title">TARGET PRIORITY</span>
        {auto ? (
          <span className="tpc-badge tpc-badge--auto" title="Peer targeting: engages whoever is closest to this ship's own speed, warships before civilians before settlements. Drag a card to take manual control.">AUTO</span>
        ) : (
          <button
            className="tpc-badge tpc-badge--reset"
            disabled={disabled}
            onClick={() => onChange(null)}
            title="Back to auto — peer targeting by speed, warships first."
          >RESET</button>
        )}
      </div>
      {note && <div className="tpc-note">{note}</div>}
      <div
        className="tpc-list"
        style={{ height: order.length * CARD_STRIDE - 6 }}
      >
        {order.map((key, idx) => {
          const meta = CATEGORY_META[key];
          const dragging = dragIdx === idx;
          // Where this card should SIT right now: its own slot, shifted
          // one stride when the lifted card's proposed slot displaces it.
          let slot = idx;
          if (dragIdx !== null && overIdx !== null && !dragging) {
            if (dragIdx < idx && overIdx >= idx) slot = idx - 1;
            else if (dragIdx > idx && overIdx <= idx) slot = idx + 1;
          }
          const y = dragging ? idx * CARD_STRIDE + dy : slot * CARD_STRIDE;
          // Displayed rank tracks the preview so the numbers re-count
          // live while a card is in flight.
          const shownRank = (dragging ? (overIdx ?? idx) : slot) + 1;
          return (
            <div
              key={key}
              className={`tpc-card${dragging ? ' tpc-card--drag' : ''}`}
              style={{ transform: `translateY(${y}px)` }}
              onPointerDown={onPointerDown(idx)}
              onPointerMove={onPointerMove(idx)}
              onPointerUp={onPointerUp(idx)}
              onPointerCancel={onPointerUp(idx)}
            >
              <span className="tpc-rank">{shownRank}</span>
              <span className="tpc-glyph">{meta.glyph}</span>
              <span className="tpc-labels">
                <span className="tpc-label">{meta.label}</span>
                <span className="tpc-sub">{meta.sub}</span>
              </span>
              <span className="tpc-nudges">
                <button
                  className="tpc-nudge" disabled={disabled || idx === 0}
                  onClick={() => nudge(idx, -1)} title="Raise priority"
                  aria-label={`Raise ${meta.label} priority`}
                >▲</button>
                <button
                  className="tpc-nudge" disabled={disabled || idx === order.length - 1}
                  onClick={() => nudge(idx, 1)} title="Lower priority"
                  aria-label={`Lower ${meta.label} priority`}
                >▼</button>
              </span>
            </div>
          );
        })}
      </div>
      <div className="tpc-foot">
        {auto
          ? 'Auto: fights its speed peers first — drag to override.'
          : 'Engages the first ranked category present. Within a rank: closest speed.'}
      </div>
    </div>
  );
};
