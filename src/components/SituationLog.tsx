// ============================================================
// SituationLog
//
// Stellaris-style attention dock. Lives on the right edge as a sibling
// of the multiplayer dock; clicking it opens the panel and dispatches
// 'mp:situation-open' so the MP dock collapses (mutex). Listening for
// 'mp:dock-open' the other direction means MP opens close us too.
//
// Sections are GROUPED HEADERS — Sean's mental model. The pill shows
// total count + an amber dot when any item is severity 'warn'.
// ============================================================

import React, { useEffect, useState } from 'react';
import { useGameContext } from '../state/gameContext';
import {
  useSituationItems,
  groupByCategory,
  CATEGORY_LABEL,
  type SituationItem,
  type SituationMpData,
} from '../hooks/useSituationItems';
import './SituationLog.css';

const PLAYER_TOKEN = 'player';

interface Props {
  /** Caller's faction id. In SP this is 'player'; in MP the
   *  GameContext also identifies the local player as 'player' after
   *  remapping (see MultiplayerGameProvider). */
  factionId?: string;
  /** Optional MP data (open trades + senate votes). When omitted the
   *  hook just skips those categories. */
  mpData?: SituationMpData;
}

export const SituationLog: React.FC<Props> = ({ factionId = PLAYER_TOKEN, mpData }) => {
  const { gameState, selectShip, selectBody, focusBody } = useGameContext();
  const items = useSituationItems(gameState, factionId, mpData);
  const grouped = groupByCategory(items);
  const totalCount = items.length;
  const hasWarn = items.some(i => i.severity === 'warn');

  const [open, setOpen] = useState(false);

  // Mutex with the MP dock. Open: tell MP to close. Listen: if MP
  // opens, we close. Single shared 'active dock' state without a
  // context.
  useEffect(() => {
    const onMpOpen = () => setOpen(false);
    window.addEventListener('mp:dock-open', onMpOpen);
    return () => window.removeEventListener('mp:dock-open', onMpOpen);
  }, []);

  function toggleOpen() {
    const next = !open;
    setOpen(next);
    if (next) {
      try { window.dispatchEvent(new CustomEvent('mp:situation-open')); } catch { /* ignore */ }
    }
  }

  function handleClick(item: SituationItem) {
    setOpen(false);
    if (!item.focus) return;
    if (item.focus.kind === 'ship') {
      const shipId = item.focus.shipId;
      selectShip(shipId);
      // Also focus the body the ship is parked at, since that's the
      // useful framing for "give this ship orders."
      const ship = gameState.ships.find(s => s.id === shipId);
      if (ship?.orbit.parentBodyId) focusBody(ship.orbit.parentBodyId);
    } else if (item.focus.kind === 'body') {
      selectBody(item.focus.bodyId);
      focusBody(item.focus.bodyId);
    } else if (item.focus.kind === 'panel') {
      // Cross-dock navigation: dispatch a window event that the
      // MultiplayerShell / TopBar listens for and switches to the
      // requested panel.
      try {
        window.dispatchEvent(new CustomEvent('orbital:open-panel', { detail: { panel: item.focus.panel } }));
      } catch { /* ignore */ }
    }
  }

  return (
    <div className={`sit-dock ${open ? 'sit-dock--open' : 'sit-dock--collapsed'}`}>
      {!open ? (
        <button
          className="sit-pill"
          onClick={toggleOpen}
          title={totalCount > 0 ? `${totalCount} situation${totalCount === 1 ? '' : 's'} to review` : 'Situation Log (nothing pending)'}
          aria-label="Open situation log"
        >
          <SitIcon />
          {totalCount > 0 && (
            <span className="sit-pill__count">
              {totalCount}
              {hasWarn && <span className="sit-pill__warn-dot" aria-hidden />}
            </span>
          )}
        </button>
      ) : (
        <div className="sit-panel">
          <div className="sit-panel__head">
            <span className="sit-panel__title"><SitIcon /> SITUATION LOG</span>
            <button onClick={() => setOpen(false)} className="sit-panel__close" aria-label="Close">×</button>
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
      )}
    </div>
  );
};

const SitIcon: React.FC = () => (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M12 3v3" />
    <path d="M5 8h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2z" />
    <path d="M8 13h8" />
    <path d="M8 17h5" />
    <circle cx="12" cy="3" r="1" fill="currentColor" />
  </svg>
);
