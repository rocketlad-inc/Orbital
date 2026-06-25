// ============================================================
// EventLog
//
// Slide-in chronicle of every server-pushed game event for the
// match. Mounted as a DockRail sibling — the rail owns the open
// state and which icon is highlighted; this component renders the
// panel body when active and reports its row count back to the
// rail so the icon's badge stays current.
//
// Phase-1 chrome shipped: click a row to expand inline (replaces
// the AlertDetailsModal pop-out — chips elsewhere still use that
// pattern), per-category left border via logEntryIcon, gold glow +
// soft pulse on entries newer than the player's last-read
// bookmark, and the rail badge counts NEW entries instead of total
// so the player knows there's fresh content without opening.
//
// Phase 2 will swap the placeholder flavor body for real prose via
// a template engine. Phase 3 layers editability + server-side sync.
// ============================================================

import React, { useEffect, useRef, useState } from 'react';
import { useGameContext } from '../state/gameContext';
import type { ChronicleFocus } from '../types';
import './DockRail.css';
import './EventLog.css';

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
    return { icon: '✦', color: '#e879f9', label: 'Discovery' };
  }
  // Diplomacy buckets — order matters: 'broke ... pact' must match
  // before the generic 'pact' word in 'signed Defense Pact'.
  if (s.includes('broke') && s.includes('pact'))   return { icon: '⚔', color: '#ff5e5e', label: 'Pact broken' };
  // Text-presentation peace symbol (☮ + VS15) so it honours the cyan color
  // and stays monochrome like the other glyphs — the dove emoji rendered
  // colour-locked and inconsistent across OSes.
  if (s.includes('signed') && s.includes('pact'))  return { icon: '☮︎', color: '#a78bfa', label: 'Pact signed' };
  if (s.includes('traded') && s.includes(' → '))   return { icon: '⚖', color: '#ffb84d', label: 'Trade' };
  if (s.includes('captured')) return { icon: '⚑', color: '#ffd700', label: 'Capture' };
  if (s.includes('founded')) return { icon: '⌂', color: '#6ee7b7', label: 'Settlement' };
  if (s.includes('launched') || s.includes('rolled out') || s.includes('built')) {
    return { icon: '✦', color: '#4ecdc4', label: 'Industry' };
  }
  if (s.includes('destroyed') || s.includes('collapsed')) return { icon: '✖', color: '#ff5e5e', label: 'Destruction' };
  if (s.includes(' hits ')) return { icon: '⚔', color: '#ffb84d', label: 'Combat' };
  return { icon: '›', color: '#8a9fb3', label: 'Event' };
}

/** localStorage bucket per game route (so MP rooms + SP don't share a
 *  bookmark). `window.location.pathname` is stable per game; if the
 *  client side-routes to a new game the key naturally flips. SSR safe. */
function readBookmarkKey(): string {
  if (typeof window === 'undefined') return 'eventLog:lastReadCount:default';
  return `eventLog:lastReadCount:${window.location.pathname}`;
}

/**
 * EventLog panel — slides out of the DockRail's third button.
 * Listens for 'dockrail:active' to toggle visibility; reports its
 * NEW-entry count back via 'dockrail:badge' so the rail icon shows
 * only what's actually unread (clears when the player opens it).
 * Pattern mirrors SituationLog exactly so the two panels feel cohesive.
 */
export const EventLog: React.FC = () => {
  const { gameState, selectShip, selectBody, focusBody } = useGameContext();
  const entries = gameState.combatLog;
  const flavors = gameState.chronicleFlavor;
  const focuses = gameState.chronicleFocus;
  const totalCount = entries.length;

  // "Take me there" — center the camera on the event's body/ship if it
  // still exists. Re-validate against live state so a button never
  // sends the camera to a ship that's since been destroyed or a body
  // that was wiped. Returns false when the target is gone (the caller
  // hides the button).
  const resolveFocus = (f: ChronicleFocus | null | undefined): (() => void) | null => {
    if (!f) return null;
    if (f.kind === 'ship') {
      const ship = gameState.ships.find(s => s.id === f.shipId);
      if (!ship) return null;
      return () => {
        selectShip(ship.id);
        if (ship.orbit?.parentBodyId) focusBody(ship.orbit.parentBodyId);
        close();
      };
    }
    const body = gameState.bodies.find(b => b.id === f.bodyId);
    if (!body) return null;
    return () => {
      selectBody(body.id);
      focusBody(body.id);
      close();
    };
  };

  const [open, setOpen] = useState(false);
  // Keep the panel mounted for one transition cycle after `open`
  // flips off so the slide-out animation gets to play. After ~250 ms
  // the element unmounts.
  const [mounted, setMounted] = useState(false);
  const unmountTimerRef = useRef<number | null>(null);

  // Track how many entries the player had ALREADY seen the last time
  // they opened the panel. Persisted per game-route so coming back
  // after a break shows you what's new since you logged off.
  const bookmarkKey = readBookmarkKey();
  const [lastReadCount, setLastReadCount] = useState<number>(() => {
    try {
      const raw = typeof window !== 'undefined' ? window.localStorage.getItem(bookmarkKey) : null;
      const n = raw != null ? parseInt(raw, 10) : 0;
      return Number.isFinite(n) && n >= 0 ? n : 0;
    } catch { return 0; }
  });
  // Re-read when the bookmark key changes (e.g. URL-based route swap).
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(bookmarkKey);
      const n = raw != null ? parseInt(raw, 10) : 0;
      setLastReadCount(Number.isFinite(n) && n >= 0 ? n : 0);
    } catch { /* ignore */ }
  }, [bookmarkKey]);
  // combatLog is bounded server-side; if it gets trimmed below the
  // stored bookmark the new-count math would go negative without this.
  const clampedLastRead = Math.min(lastReadCount, totalCount);
  const newCount = Math.max(0, totalCount - clampedLastRead);

  // Which rows are expanded. Multiple can be open at once — the
  // player might want to compare two combat results side-by-side.
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const toggleExpand = (i: number) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i); else next.add(i);
      return next;
    });
  };

  // Rail tells us which panel is active.
  useEffect(() => {
    const onActive = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      setOpen(detail?.active === 'eventlog');
    };
    window.addEventListener('dockrail:active', onActive as EventListener);
    return () => window.removeEventListener('dockrail:active', onActive as EventListener);
  }, []);

  // Mark-read fires the moment the panel becomes visible. The pulse
  // + badge clear immediately; the bookmark write persists across
  // reloads. Reset expanded set so a fresh open doesn't reveal what
  // was last clicked.
  useEffect(() => {
    if (!open) return;
    setLastReadCount(totalCount);
    setExpanded(new Set());
    try { window.localStorage.setItem(bookmarkKey, String(totalCount)); } catch { /* ignore */ }
  }, [open, totalCount, bookmarkKey]);

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

  // Report NEW count to the rail (was total). When newCount > 0 the
  // pip lights up; once the player opens (which sets lastReadCount
  // = totalCount), newCount drops to 0 and the pip disappears.
  // hasWarn=false because combat-log entries are mixed-severity;
  // a literal "warn" dot would always be on for any non-empty log.
  useEffect(() => {
    try {
      window.dispatchEvent(new CustomEvent('dockrail:badge', {
        detail: { which: 'eventlog', count: newCount, hasWarn: false },
      }));
    } catch { /* noop */ }
  }, [newCount]);

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
              // Render newest-first — combatLog is append-only so the
              // last index is the most recent. Reversed via a copy so
              // we don't mutate the live state.
              entries.map((entry, i) => ({ entry, originalIndex: i }))
                .slice().reverse()
                .map(({ entry, originalIndex: i }) => {
                  const { icon, color, label } = logEntryIcon(entry);
                  const isNew = i >= clampedLastRead;
                  const isOpen = expanded.has(i);
                  return (
                    <div
                      key={i}
                      className={
                        'event-log__row'
                        + (isOpen ? ' is-open' : '')
                        + (isNew ? ' is-new' : '')
                      }
                      style={{ borderLeftColor: color } as React.CSSProperties}
                    >
                      <button
                        type="button"
                        className="event-log__row__headline"
                        onClick={() => toggleExpand(i)}
                        title={isOpen ? 'Collapse' : 'Expand'}
                      >
                        <span
                          className="event-log__icon"
                          style={{ color }}
                          aria-hidden="true"
                        >{icon}</span>
                        <span className="event-log__text">{entry}</span>
                        <span
                          className="event-log__chevron"
                          aria-hidden="true"
                        >{isOpen ? '▾' : '▸'}</span>
                      </button>
                      {isOpen && (() => {
                        const onFocus = resolveFocus(focuses?.[i]);
                        return (
                          <div className="event-log__row__body">
                            <div className="event-log__row__category" style={{ color }}>
                              {label}
                            </div>
                            <div className="event-log__row__flavor">
                              {/* Prose flavor resolved from the structured
                                  chronicle event (flavorEngine). Falls back
                                  to echoing the headline when the event kind
                                  has no bank or its payload couldn't be
                                  enriched. Editing lands in phase 3. */}
                              {flavors?.[i] ?? entry}
                            </div>
                            {onFocus && (
                              <button
                                type="button"
                                className="event-log__row__focus"
                                style={{ borderColor: color, color }}
                                onClick={onFocus}
                                title="Center the camera on this location"
                              >
                                ◎ Take me there
                              </button>
                            )}
                          </div>
                        );
                      })()}
                    </div>
                  );
                })
            )}
          </div>
          <footer className="event-log__foot">
            {totalCount} {totalCount === 1 ? 'entry' : 'entries'} · Press <kbd>Esc</kbd> to close
          </footer>
        </div>
      )}
    </>
  );
};
