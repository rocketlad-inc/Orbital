// ============================================================
// SituationLog
//
// Panel content for the "Situation Report" rail icon. The rail
// (DockRail) owns the open/closed state and the icon; this component
// just renders the panel body when active, and reports its count
// back to the rail so the icon's badge stays current.
//
// Renders the hook's THREE URGENCY TIERS (now / needs a decision /
// opportunities) rather than nine category headers — see
// useSituationItems for the tier model and cross-item rules.
//
// Badge semantics: the rail badge counts only the now+decision tiers,
// and the warn dot means "the NOW tier is non-empty". Opportunities
// never inflate the number — the badge answers "do I need to look",
// not "how long is the list". (Old behaviour counted everything, so
// the badge read 30 in a healthy game and players tuned it out.)
//
// "New since last glance": rows that appeared since the panel was
// last open get a dot. Seen-ids persist in localStorage (same pattern
// as EventLog's read tracking); the snapshot freezes when the panel
// opens so dots don't vanish while you're looking at them.
// ============================================================

import React, { useEffect, useRef, useState } from 'react';
import { useGameContext } from '../state/gameContext';
import {
  useSituationItems,
  groupByTier,
  TIER_LABEL,
  type SituationItem,
  type SituationMpData,
} from '../hooks/useSituationItems';
import './SituationLog.css';
import './DockRail.css';

const PLAYER_TOKEN = 'player';

// Seen-row tracking for the "new" dot. One global key: item ids embed
// game-scoped entity ids, so cross-game collisions are effectively nil.
const SEEN_KEY = 'orbital.sitreport.seen.v1';
const SEEN_CAP = 600;

function loadSeen(): Set<string> {
  try {
    const raw = localStorage.getItem(SEEN_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr : []);
  } catch { return new Set(); }
}

function saveSeen(ids: Set<string>) {
  try {
    // Cap by dropping oldest (Set preserves insertion order).
    const arr = Array.from(ids);
    localStorage.setItem(SEEN_KEY, JSON.stringify(arr.slice(-SEEN_CAP)));
  } catch { /* storage full/blocked — dots just reset next session */ }
}

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
  const grouped = groupByTier(items);

  // Badge: count what needs attention, flag red when something is
  // being shot RIGHT NOW. Opportunities are excluded on purpose.
  const urgentCount = items.filter(i => i.tier !== 'opportunity').length;
  const hasNow = items.some(i => i.tier === 'now');

  const [open, setOpen] = useState(false);
  // We keep the panel mounted for one transition cycle after `open`
  // flips off, so the slide-out animation gets to play. After ~250 ms
  // the element unmounts.
  const [mounted, setMounted] = useState(false);
  const unmountTimerRef = useRef<number | null>(null);

  // Seen-snapshot for the "new" dot. Frozen at panel-open; persisted
  // at panel-close with everything currently visible.
  const seenSnapshotRef = useRef<Set<string>>(loadSeen());
  const itemsRef = useRef<SituationItem[]>(items);
  itemsRef.current = items;

  // First-ever run (no stored key): stamp the current list so the
  // player's very first open isn't a wall of dots.
  const initializedRef = useRef(false);
  useEffect(() => {
    if (initializedRef.current) return;
    initializedRef.current = true;
    if (localStorage.getItem(SEEN_KEY) == null && items.length > 0) {
      const ids = new Set(items.map(i => i.id));
      saveSeen(ids);
      seenSnapshotRef.current = ids;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items.length]);

  // Rail tells us which panel is active.
  useEffect(() => {
    const onActive = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      setOpen(detail?.active === 'situation');
    };
    window.addEventListener('dockrail:active', onActive as EventListener);
    return () => window.removeEventListener('dockrail:active', onActive as EventListener);
  }, []);

  // Manage mount/unmount around the open flag so the CSS transition
  // runs, and drive the seen-tracking off the same transitions:
  // open → freeze the snapshot dots render against;
  // close → everything on screen has now been seen.
  useEffect(() => {
    if (open) {
      if (unmountTimerRef.current != null) {
        window.clearTimeout(unmountTimerRef.current);
        unmountTimerRef.current = null;
      }
      seenSnapshotRef.current = loadSeen();
      setMounted(true);
    } else if (mounted) {
      const merged = loadSeen();
      for (const it of itemsRef.current) merged.add(it.id);
      saveSeen(merged);
      unmountTimerRef.current = window.setTimeout(() => setMounted(false), 250);
    }
    return () => {
      if (unmountTimerRef.current != null) {
        window.clearTimeout(unmountTimerRef.current);
        unmountTimerRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Report our count to the rail so the badge stays current. Fires on
  // every change in the urgent subset.
  useEffect(() => {
    try {
      window.dispatchEvent(new CustomEvent('dockrail:badge', {
        detail: { which: 'situation', count: urgentCount, hasWarn: hasNow },
      }));
    } catch { /* noop */ }
  }, [urgentCount, hasNow]);

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

  const totalCount = items.length;

  return (
    <div className={`dock-panel sit-panel-shell${open ? ' is-open' : ''}`} role="region" aria-label="Situation Report">
      <div className="sit-panel__head">
        <span className="sit-panel__title">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M5 6h14M5 10h14M5 14h9M5 18h9" />
          </svg>
          SITUATION REPORT
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
            <section key={g.tier} className={`sit-tier sit-tier--${g.tier}`}>
              <header className="sit-tier__head">
                <span className="sit-tier__label">{TIER_LABEL[g.tier]}</span>
                <span className="sit-tier__count">{g.items.length}</span>
              </header>
              <ul className="sit-tier__list">
                {g.items.map(it => {
                  const isNew = !seenSnapshotRef.current.has(it.id);
                  return (
                    <li key={it.id}>
                      <button
                        className={`sit-item sit-item--${it.severity}`}
                        onClick={() => handleClick(it)}
                        title="Click to focus"
                      >
                        <span className="sit-item__title">
                          {isNew && <span className="sit-item__new" aria-label="New" />}
                          {it.title}
                        </span>
                        {it.subtitle && <span className="sit-item__sub">{it.subtitle}</span>}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  );
};
