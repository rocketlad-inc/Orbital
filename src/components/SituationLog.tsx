// ============================================================
// SituationLog
//
// Panel content for the "Situation Log" rail icon. The rail
// (DockRail) owns the open/closed state and the icon; this component
// just renders the panel body when active, and reports its count
// back to the rail so the icon's badge stays current.
//
// Sections are GROUPED HEADERS per Sean's mental model.
// ============================================================

import React, { useEffect, useRef, useState } from 'react';
import { useGameContext } from '../state/gameContext';
import {
  useSituationItems,
  groupByCategory,
  CATEGORY_LABEL,
  type SituationItem,
  type SituationMpData,
} from '../hooks/useSituationItems';
import './SituationLog.css';
import './DockRail.css';

const PLAYER_TOKEN = 'player';

interface Props {
  /** Caller's faction id. SP = 'player'. MP also normalises to
   *  'player' via MultiplayerGameProvider's remap. */
  factionId?: string;
  /** Optional MP-only category data. */
  mpData?: SituationMpData;
}

export const SituationLog: React.FC<Props> = ({ factionId = PLAYER_TOKEN, mpData }) => {
  const { gameState, selectShip, selectBody, focusBody } = useGameContext();
  const items = useSituationItems(gameState, factionId, mpData);
  const grouped = groupByCategory(items);
  const totalCount = items.length;
  const hasWarn = items.some(i => i.severity === 'warn');

  const [open, setOpen] = useState(false);
  // We keep the panel mounted for one transition cycle after `open`
  // flips off, so the slide-out animation gets to play. After ~250 ms
  // the element unmounts.
  const [mounted, setMounted] = useState(false);
  const unmountTimerRef = useRef<number | null>(null);

  // Rail tells us which panel is active.
  useEffect(() => {
    const onActive = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      setOpen(detail?.active === 'situation');
    };
    window.addEventListener('dockrail:active', onActive as EventListener);
    return () => window.removeEventListener('dockrail:active', onActive as EventListener);
  }, []);

  // Manage mount/unmount around the open flag so the CSS transition runs.
  useEffect(() => {
    if (open) {
      if (unmountTimerRef.current != null) {
        window.clearTimeout(unmountTimerRef.current);
        unmountTimerRef.current = null;
      }
      setMounted(true);
    } else if (mounted) {
      unmountTimerRef.current = window.setTimeout(() => setMounted(false), 250);
    }
    return () => {
      if (unmountTimerRef.current != null) {
        window.clearTimeout(unmountTimerRef.current);
        unmountTimerRef.current = null;
      }
    };
  }, [open, mounted]);

  // Report our count to the rail so the badge stays current. Fires on
  // every change in items.
  useEffect(() => {
    try {
      window.dispatchEvent(new CustomEvent('dockrail:badge', {
        detail: { which: 'situation', count: totalCount, hasWarn },
      }));
    } catch { /* noop */ }
  }, [totalCount, hasWarn]);

  function close() {
    try {
      window.dispatchEvent(new CustomEvent('dockrail:set', { detail: { active: null } }));
    } catch { /* noop */ }
  }

  function handleClick(item: SituationItem) {
    close();
    if (!item.focus) return;
    if (item.focus.kind === 'ship') {
      const shipId = item.focus.shipId;
      selectShip(shipId);
      const ship = gameState.ships.find(s => s.id === shipId);
      if (ship?.orbit.parentBodyId) focusBody(ship.orbit.parentBodyId);
    } else if (item.focus.kind === 'body') {
      selectBody(item.focus.bodyId);
      focusBody(item.focus.bodyId);
    } else if (item.focus.kind === 'panel') {
      try {
        window.dispatchEvent(new CustomEvent('orbital:open-panel', { detail: { panel: item.focus.panel } }));
      } catch { /* ignore */ }
    }
  }

  if (!mounted) return null;

  return (
    <div className={`dock-panel sit-panel-shell${open ? ' is-open' : ''}`} role="region" aria-label="Situation Log">
      <div className="sit-panel__head">
        <span className="sit-panel__title">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M5 6h14M5 10h14M5 14h9M5 18h9" />
          </svg>
          SITUATION LOG
        </span>
        <button onClick={close} className="sit-panel__close" aria-label="Close">×</button>
      </div>

      {totalCount === 0 ? (
        <div className="sit-panel__empty">
          <div className="sit-panel__empty-icon">✓</div>
          <div>Nothing requires your attention.</div>
          <div className="sit-panel__empty-sub">
            Items appear here when a ship arrives, a build queue runs dry, a vote opens, or threats are inbound.
          </div>
        </div>
      ) : (
        <div className="sit-panel__body">
          {grouped.map(g => (
            <section key={g.category} className="sit-group">
              <header className="sit-group__head">
                <span className="sit-group__label">{CATEGORY_LABEL[g.category]}</span>
                <span className="sit-group__count">{g.items.length}</span>
              </header>
              <ul className="sit-group__list">
                {g.items.map(it => (
                  <li key={it.id}>
                    <button
                      className={`sit-item sit-item--${it.severity}`}
                      onClick={() => handleClick(it)}
                      title="Click to focus"
                    >
                      <span className="sit-item__title">{it.title}</span>
                      {it.subtitle && <span className="sit-item__sub">{it.subtitle}</span>}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  );
};
