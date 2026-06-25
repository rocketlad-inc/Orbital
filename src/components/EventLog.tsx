// ============================================================
// EventLog
//
// Slide-in chronicle of every server-pushed game event for the
// match. Mounted as a DockRail sibling — the rail owns the open
// state and which icon is highlighted; this component renders the
// panel body when active and reports its row count back to the
// rail so the icon's badge stays current. Replaces the top-bar
// "alert chips + ☰ Log (N)" pattern, which crowded the top bar
// and split the player's attention between two surfaces showing
// the same data.
//
// Click a row → opens AlertDetailsModal (a portaled centred
// popover) with the full untruncated text + per-type icon/colour
// classified by logEntryIcon.
// ============================================================

import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useGameContext } from '../state/gameContext';
import './DockRail.css';
import './EventLog.css';

interface Alert {
  id: string;
  icon: string;
  color: string;
  category: string;
  /** Full untruncated entry text used by the modal body. */
  detail: string;
  /** Optional action shown as a footer button when applicable
   *  (e.g. "Go to ship"). Historical log entries have no target. */
  onClick?: () => void;
  actionLabel?: string;
}

/**
 * Classify a free-text chronicle line into an icon + color + label
 * by keyword. The log is just strings (combat.ts / secrets.ts /
 * dysonSphere push pre-formatted messages), so we sniff the text
 * rather than carry a structured kind. Order matters: more specific
 * categories (Dyson, discovery) are checked before the generic
 * "destroyed"/"hits" buckets so e.g. "The Dyson Sphere … destroyed"
 * reads as a Dyson event, not a plain destruction. Glyphs stay in
 * the unicode family the rest of the UI uses (◆ ■ ⚛ …) so they
 * render without an icon font.
 */
function logEntryIcon(entry: string): { icon: string; color: string; label: string } {
  const s = entry.toLowerCase();
  if (s.includes('dyson')) return { icon: '☀', color: '#fbbf24', label: 'Megaproject' };
  if (s.includes('victory') || s.includes(' wins')) return { icon: '♛', color: '#6ee7b7', label: 'Victory' };
  if (s.includes('discovery') || s.includes('databank') || s.includes('warp gate') || s.includes('stargate')) {
    return { icon: '✦', color: '#67e8f9', label: 'Discovery' };
  }
  // Diplomacy buckets — order matters: 'broke ... pact' must match
  // before the generic 'pact' word in 'signed Defense Pact'.
  if (s.includes('broke') && s.includes('pact'))   return { icon: '⚔', color: '#ff5e5e', label: 'Pact broken' };
  // Text-presentation peace symbol (☮ + VS15) so it honours the cyan color
  // and stays monochrome like the other glyphs — the dove emoji rendered
  // colour-locked and inconsistent across OSes.
  if (s.includes('signed') && s.includes('pact'))  return { icon: '☮︎', color: '#67e8f9', label: 'Pact signed' };
  if (s.includes('traded') && s.includes(' → '))   return { icon: '⚖', color: '#fbbf24', label: 'Trade' };
  if (s.includes('captured')) return { icon: '⚑', color: '#ffd700', label: 'Capture' };
  if (s.includes('destroyed') || s.includes('collapsed')) return { icon: '✖', color: '#ff5e5e', label: 'Destruction' };
  if (s.includes(' hits ')) return { icon: '⚔', color: '#ffb84d', label: 'Combat' };
  return { icon: '›', color: '#8a9fb3', label: 'Event' };
}

/** Build a synthetic Alert for a log row click so AlertDetailsModal
 *  can show the full untruncated text + per-type icon/color. */
function alertFromLogEntry(entry: string, index: number): Alert {
  const cls = logEntryIcon(entry);
  return {
    id: `logrow-${index}`,
    icon: cls.icon,
    color: cls.color,
    category: cls.label,
    detail: entry,
  };
}

/** Click-to-open details for a log row. Portaled centred popover —
 *  same pattern as SaveLoadModal: backdrop + Esc + close button. */
const AlertDetailsModal: React.FC<{ alert: Alert; onClose: () => void }> = ({ alert, onClose }) => {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    // Capture-phase + stopImmediatePropagation so Esc closes ONLY this
    // modal even when a deeper overlay (the EventLog dock panel) also
    // has its own listener — otherwise pressing Esc would close both
    // and dump the player back to the map after a single row peek.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopImmediatePropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    closeRef.current?.focus();
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  return createPortal(
    <div className="alert-detail__backdrop" onClick={onClose}>
      <div
        className="alert-detail"
        style={{ borderColor: alert.color }}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={`${alert.category} details`}
      >
        <header className="alert-detail__head">
          <span className="alert-detail__icon" style={{ color: alert.color }} aria-hidden="true">{alert.icon}</span>
          <span className="alert-detail__category" style={{ color: alert.color }}>{alert.category}</span>
          <button ref={closeRef} className="alert-detail__close" onClick={onClose} title="Close (Esc)">×</button>
        </header>
        <div className="alert-detail__body">{alert.detail}</div>
        {alert.onClick && (
          <footer className="alert-detail__foot">
            <button
              className="alert-detail__action"
              onClick={() => { alert.onClick?.(); onClose(); }}
            >{alert.actionLabel ?? 'Select ship'}</button>
          </footer>
        )}
      </div>
    </div>,
    document.body,
  );
};

/**
 * EventLog panel — slides out of the DockRail's third button.
 * Listens for 'dockrail:active' to toggle visibility; reports its
 * row count back via 'dockrail:badge' so the rail icon's badge
 * stays current. Pattern mirrors SituationLog exactly so the two
 * panels feel cohesive.
 */
export const EventLog: React.FC = () => {
  const { gameState } = useGameContext();
  const entries = gameState.combatLog;
  const totalCount = entries.length;

  const [open, setOpen] = useState(false);
  // Keep the panel mounted for one transition cycle after `open`
  // flips off so the slide-out animation gets to play. After ~250 ms
  // the element unmounts.
  const [mounted, setMounted] = useState(false);
  const unmountTimerRef = useRef<number | null>(null);

  // Click-to-open details popover.
  const [detailAlert, setDetailAlert] = useState<Alert | null>(null);

  // Rail tells us which panel is active.
  useEffect(() => {
    const onActive = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      setOpen(detail?.active === 'eventlog');
    };
    window.addEventListener('dockrail:active', onActive as EventListener);
    return () => window.removeEventListener('dockrail:active', onActive as EventListener);
  }, []);

  // Mount/unmount around the open flag so the CSS transition runs.
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

  // Report count to the rail so the badge stays current. The rail
  // colours the badge red when hasWarn is true; combat-log entries
  // are mixed-severity so we leave hasWarn false (a literal "warn"
  // dot would always be on for any non-empty log).
  useEffect(() => {
    try {
      window.dispatchEvent(new CustomEvent('dockrail:badge', {
        detail: { which: 'eventlog', count: totalCount, hasWarn: false },
      }));
    } catch { /* noop */ }
  }, [totalCount]);

  function close() {
    try {
      window.dispatchEvent(new CustomEvent('dockrail:set', { detail: { active: null } }));
    } catch { /* noop */ }
  }

  return (
    <>
      {mounted && (
        <div
          className={`dock-panel event-log-shell${open ? ' is-open' : ''}`}
          role="region"
          aria-label="Event Log"
        >
          <div className="event-log__head">
            <span className="event-log__title">EVENT LOG</span>
            <button className="event-log__close" onClick={close} title="Close (Esc)">×</button>
          </div>
          <div className="event-log__body">
            {totalCount === 0 ? (
              <div className="event-log__empty">No events yet. Combat results and game milestones will appear here.</div>
            ) : (
              entries.map((entry, i) => {
                const { icon, color } = logEntryIcon(entry);
                return (
                  <button
                    key={i}
                    type="button"
                    className="event-log__row event-log__row--clickable"
                    onClick={() => setDetailAlert(alertFromLogEntry(entry, i))}
                    title="Show details"
                  >
                    <span
                      className="event-log__icon"
                      style={{ color }}
                      aria-hidden="true"
                    >{icon}</span>
                    <span className="event-log__text">{entry}</span>
                  </button>
                );
              })
            )}
          </div>
          <footer className="event-log__foot">
            {totalCount} {totalCount === 1 ? 'entry' : 'entries'} · Press <kbd>Esc</kbd> to close
          </footer>
        </div>
      )}

      {detailAlert && (
        <AlertDetailsModal alert={detailAlert} onClose={() => setDetailAlert(null)} />
      )}
    </>
  );
};
