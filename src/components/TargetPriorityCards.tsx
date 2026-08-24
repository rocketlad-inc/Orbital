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
import { hitChanceOf } from '../game/shipParts';
import './TargetPriorityCards.css';

/** Categories the player may NOT rank. Settlements are pinned to the
 *  bottom (Lorne: "too OP to walk right up and blow away someone's
 *  cities") — you have to beat the fleet before you can touch what it
 *  defends. Enforced independently in worker/room.js (the combat loop
 *  skips the entry wherever it sits) and normalized in the orders API;
 *  this constant only drives the UI's lock. */
const PINNED_LAST: ReadonlySet<TargetPriorityKey> = new Set<TargetPriorityKey>(['settlement']);

/** The order with every pinned category forced to the bottom. Applied to
 *  whatever comes back from the server too, so a legacy row that ranked
 *  settlements first still renders them locked at the end. */
function withPinned(order: TargetPriorityKey[]): TargetPriorityKey[] {
  return [...order.filter(k => !PINNED_LAST.has(k)), ...order.filter(k => PINNED_LAST.has(k))];
}

/** How many cards from the bottom are frozen — the drag/nudge clamp. */
const MOVABLE_COUNT = (order: TargetPriorityKey[]) =>
  order.filter(k => !PINNED_LAST.has(k)).length;

const CATEGORY_META: Record<TargetPriorityKey, { label: string; sub: string; glyph: string }> = {
  corvette:   { label: 'CORVETTES',   sub: 'fast screens',          glyph: '▸' },
  frigate:    { label: 'FRIGATES',    sub: 'line warships',         glyph: '▶' },
  destroyer:  { label: 'DESTROYERS',  sub: 'heavy hitters',         glyph: '◆' },
  capital:    { label: 'CAPITALS',    sub: 'mega hulls',            glyph: '✹' },
  civilian:   { label: 'CIVILIANS',   sub: 'freighters + colony',   glyph: '○' },
  settlement: { label: 'SETTLEMENTS', sub: 'stations + cities',     glyph: '⬢' },
};

/** Height of one card INCLUDING its gap — must match the CSS. Drag math
 *  keys off this, so the two files move together or the preview drifts. */
const CARD_STRIDE = 40;

/** Base combat speed per category — mirrors SHIP_COMBAT_STATS /
 *  SETTLEMENT_SPEED in worker/factions.js. Display only: real candidates
 *  carry engine parts, but the class base is what makes the auto ladder
 *  legible. KEEP IN SYNC. */
const CATEGORY_SPEED: Record<TargetPriorityKey, number> = {
  corvette: 0.85, frigate: 0.50, destroyer: 0.30,
  // A capital hull barely moves, which is why everything hits it — and
  // why AUTO ranks it last among warships for a fast screen and first
  // for another slow hull. Mirrors SHIP_COMBAT_STATS.mega_destroyer.
  capital: 0.08,
  civilian: 0.55, settlement: 0.30,
};

/** What AUTO actually does for a ship of the given combat speed, as a
 *  ranked list: warship classes by speed proximity (equal gap → the
 *  slower class first), then civilians, then settlements — the server's
 *  peer targeting inside its tier ladder (worker/room.js). Rendering a
 *  static class-order ladder here made a destroyer look like it hunts
 *  corvettes first, which is exactly backwards. */
export function autoTargetOrderFor(speed: number): TargetPriorityKey[] {
  const warships: TargetPriorityKey[] = ['corvette', 'frigate', 'destroyer', 'capital'];
  warships.sort((a, b) => {
    const ga = Math.abs(speed - CATEGORY_SPEED[a]);
    const gb = Math.abs(speed - CATEGORY_SPEED[b]);
    if (Math.abs(ga - gb) > 1e-9) return ga - gb;
    // Equal gap: below own speed beats above (close, then below, then above).
    return (CATEGORY_SPEED[a] <= speed ? 0 : 1) - (CATEGORY_SPEED[b] <= speed ? 0 : 1);
  });
  return [...warships, 'civilian', 'settlement'];
}

export interface TargetPriorityCardsProps {
  /** Current ranked order; null = auto (server default). */
  value: TargetPriorityKey[] | null;
  /** Fired with the new order on drop/nudge, or null on RESET. */
  onChange: (next: TargetPriorityKey[] | null) => void;
  disabled?: boolean;
  /** Extra line under the header, e.g. "applies to 4 ships". */
  note?: string | null;
  /** What AUTO ranks for THIS ship (autoTargetOrderFor). Omitted on the
   *  bulk surfaces, where the group mixes classes and there is no single
   *  "own speed" — those fall back to the generic ladder. */
  autoOrder?: TargetPriorityKey[];
  /** This ship's combat speed. When present each card shows the per-tick
   *  chance to hit that category's STOCK hull — engines on the real
   *  target shift the true number, so it's a read on the matchup, not a
   *  quote. Omitted on bulk surfaces (no single own speed). */
  ownSpeed?: number;
}

export const TargetPriorityCards: React.FC<TargetPriorityCardsProps> = ({
  value, onChange, disabled, note, autoOrder, ownSpeed,
}) => {
  const auto = value == null;
  // withPinned is belt and braces: autoTargetOrderFor and the default
  // already end in 'settlement', but a stored row from before the pin
  // could rank it anywhere.
  const order = withPinned(value ?? autoOrder ?? TARGET_PRIORITY_DEFAULT);
  /** Index one past the last card the player may move into or out of. */
  const movable = MOVABLE_COUNT(order);

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
    // A pinned card can neither be moved nor displaced.
    if (from >= movable || to >= movable) return;
    if (from === to) {
      // A no-move drop on an AUTO list is still an opt-in to custom —
      // the player grabbed a card, they meant to take manual control.
      if (auto) onChange(withPinned([...dragOrder.current]));
      return;
    }
    const next = [...dragOrder.current];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    onChange(withPinned(next));
  };

  const onPointerDown = (idx: number) => (e: React.PointerEvent) => {
    if (disabled) return;
    if (idx >= movable) return;   // locked card — never lifts

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
    // Clamp to the movable region so a card can't be dragged past the
    // pinned tail — the preview stops dead at the lock line.
    const proposed = Math.min(
      movable - 1,
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
    if (to < 0 || to >= movable) return;   // can't nudge into the pinned tail
    dragOrder.current = order;
    commit(idx, to);
  };

  return (
    <div className={`tpc${auto ? ' tpc--auto' : ''}${disabled ? ' tpc--disabled' : ''}`}>
      <div className="tpc-head">
        <span className="tpc-title">TARGET PRIORITY</span>
        {auto ? (
          <span className="tpc-badge tpc-badge--auto" title="Peer targeting: closest to this ship's own speed first, slower before faster on a tie; warships before civilians before settlements. Drag a card to take manual control.">AUTO</span>
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
          const locked = idx >= movable;
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
              className={`tpc-card${dragging ? ' tpc-card--drag' : ''}${locked ? ' tpc-card--locked' : ''}`}
              style={{ transform: `translateY(${y}px)` }}
              title={locked
                ? 'Always engaged last — a fleet has to be beaten before what it defends can be shot at.'
                : undefined}
              onPointerDown={onPointerDown(idx)}
              onPointerMove={onPointerMove(idx)}
              onPointerUp={onPointerUp(idx)}
              onPointerCancel={onPointerUp(idx)}
            >
              <span className="tpc-rank">{shownRank}</span>
              <span className="tpc-glyph">{meta.glyph}</span>
              <span className="tpc-labels">
                <span className="tpc-label">
                  {meta.label}
                  {locked && <span className="tpc-lock" aria-hidden="true">🔒</span>}
                </span>
                <span className="tpc-sub">
                  {locked ? 'always last — clear the fleet first' : meta.sub}
                </span>
              </span>
              {ownSpeed !== undefined && (
                <span
                  className="tpc-hit"
                  title={`This ship lands ${Math.round(100 * hitChanceOf(ownSpeed, CATEGORY_SPEED[key]))}% of its shots on a stock ${meta.label.toLowerCase()} hull. Engines on the target lower it.`}
                >
                  {Math.round(100 * hitChanceOf(ownSpeed, CATEGORY_SPEED[key]))}%
                  <span className="tpc-hit__sub">to hit</span>
                </span>
              )}
              {/* Locked cards render no nudges at all — a disabled pair
                  still reads as "maybe later"; absence reads as "not a
                  thing you rank". */}
              {!locked && (
                <span className="tpc-nudges">
                  <button
                    className="tpc-nudge" disabled={disabled || idx === 0}
                    onClick={() => nudge(idx, -1)} title="Raise priority"
                    aria-label={`Raise ${meta.label} priority`}
                  >▲</button>
                  <button
                    className="tpc-nudge" disabled={disabled || idx === movable - 1}
                    onClick={() => nudge(idx, 1)} title="Lower priority"
                    aria-label={`Lower ${meta.label} priority`}
                  >▼</button>
                </span>
              )}
            </div>
          );
        })}
      </div>
      <div className="tpc-foot">
        {auto
          ? (autoOrder
            ? 'Auto: this ship’s actual order — closest speed first, slower before faster. Drag to override.'
            : 'Auto: closest speed first, slower before faster — drag to override.')
          : 'Engages the first ranked category present. Within a rank: closest speed.'}
        {' '}Settlements are always last: clear the defending fleet before
        you can bombard.
      </div>
    </div>
  );
};
