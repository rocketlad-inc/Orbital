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
//
// Manual dismissal: every row carries a ✕. Dismissing hides the row
// (and drops it from the rail badge) for as long as its condition
// holds CONTINUOUSLY — the moment the underlying condition clears,
// the stored dismissal is pruned, so the next occurrence of the same
// situation surfaces fresh. "Stop telling me about THIS one", not
// "never mention this ship again".
// ============================================================

import React, { useEffect, useRef, useState } from 'react';
import { useGameContext } from '../state/gameContext';
import {
  useSituationItems,
  groupByTier,
  TIER_LABEL,
  type SituationItem,
  type SituationMpData,
  type SituationFocus,
} from '../hooks/useSituationItems';
// From game/combat, NOT game/visibility — both export a
// shipWorldPosition and this must be the one ShipPanel's LOCATE uses, so
// "Show me" lands the camera in exactly the place that button would.
import { shipWorldPosition } from '../game/combat';
import { ShipIcon } from './ShipIcons';
import type { ShipClassName } from '../game/shipClasses';
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

// Dismissed-row ids. No cap needed: the prune effect keeps this to a
// subset of the CURRENT item list, which is dozens at most.
const DISMISSED_KEY = 'orbital.sitreport.dismissed.v1';

function loadDismissed(): Set<string> {
  try {
    const raw = localStorage.getItem(DISMISSED_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr : []);
  } catch { return new Set(); }
}

function saveDismissed(ids: Set<string>) {
  try {
    localStorage.setItem(DISMISSED_KEY, JSON.stringify(Array.from(ids)));
  } catch { /* storage blocked — dismissals just reset next session */ }
}

interface Props {
  /** Caller's faction id. SP = 'player'. MP also normalises to
   *  'player' via MultiplayerGameProvider's remap. */
  factionId?: string;
  /** Optional MP-only category data. */
  mpData?: SituationMpData;
}

export const SituationLog: React.FC<Props> = ({ factionId = PLAYER_TOKEN, mpData }) => {
  const { gameState, selectShip, selectBody, focusBody, updateCamera } = useGameContext();
  const items = useSituationItems(gameState, factionId, mpData);

  // Manual dismissal. A dismissal lives exactly as long as its row's
  // condition holds continuously: the prune below drops stored ids the
  // moment they leave the derived list, so a recurrence surfaces fresh.
  const [dismissed, setDismissed] = useState<Set<string>>(loadDismissed);
  useEffect(() => {
    const present = new Set(items.map(i => i.id));
    let changed = false;
    const next = new Set<string>();
    for (const id of dismissed) {
      if (present.has(id)) next.add(id);
      else changed = true;
    }
    if (changed) {
      setDismissed(next);
      saveDismissed(next);
    }
  }, [items, dismissed]);

  const dismissItem = (id: string) => {
    const next = new Set(dismissed);
    next.add(id);
    setDismissed(next);
    saveDismissed(next);
  };

  const visibleItems = items.filter(i => !dismissed.has(i.id));
  const grouped = groupByTier(visibleItems);

  // Badge: count what needs attention, flag red when something is
  // being shot RIGHT NOW. Opportunities are excluded on purpose, and
  // dismissed rows don't count — dismissing IS "I've seen this".
  const urgentCount = visibleItems.filter(i => i.tier !== 'opportunity').length;
  const hasNow = visibleItems.some(i => i.tier === 'now');

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

  /** Send the camera somewhere. One implementation for the row click and
   *  for a row's optional secondary button, so the two cannot drift. */
  function applyFocus(f: SituationFocus) {
    if (f.kind === 'ship') {
      const shipId = f.shipId;
      selectShip(shipId);
      const ship = gameState.ships.find(s => s.id === shipId);
      if (!ship) return;
      // A SHIP HAS TWO STATES, and this only ever handled one. Focusing
      // orbit.parentBodyId is right for a parked hull — focus mode keeps
      // the camera glued as the body orbits — but a hull IN TRANSIT has
      // no meaningful parent, so that line sent you to the world it left
      // rather than to the ship. Every intercept warning is about a ship
      // in flight, which made the one row that most needed this the one
      // it served worst. Same two-state move as ShipPanel's LOCATE.
      if (ship.transit) {
        const pos = shipWorldPosition(ship, gameState.currentTick, gameState.bodies);
        if (pos) updateCamera({ x: pos.x, y: pos.y, focusedBodyId: undefined });
      } else if (ship.orbit?.parentBodyId) {
        focusBody(ship.orbit.parentBodyId);
      }
    } else if (f.kind === 'body') {
      selectBody(f.bodyId);
      focusBody(f.bodyId);
    } else if (f.kind === 'panel') {
      try {
        window.dispatchEvent(new CustomEvent('orbital:open-panel', { detail: { panel: f.panel } }));
      } catch { /* ignore */ }
    }
  }

  function handleClick(item: SituationItem) {
    close();
    if (!item.focus) return;
    applyFocus(item.focus);
  }

  if (!mounted) return null;

  const totalCount = visibleItems.length;

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
                    <li key={it.id} className="sit-row">
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
                      {/* Secondary target — a sibling button, not nested
                          inside the row button, which would be invalid
                          and unreachable by keyboard. */}
                      {it.alt && (
                        <button
                          className="sit-item__alt"
                          onClick={() => { close(); applyFocus(it.alt!.focus); }}
                          title={it.alt.title ?? it.alt.label}
                          aria-label={`${it.alt.label}: ${it.title}`}
                        >{it.alt.label}</button>
                      )}
                      <button
                        className="sit-item__dismiss"
                        onClick={() => dismissItem(it.id)}
                        title="Dismiss"
                        aria-label={`Dismiss: ${it.title}`}
                      >×</button>
                      {/* ORDER OF BATTLE. A fight is the one situation
                          where the useful thing is not a sentence but a
                          picture of who is present — both sides, in
                          their own liveries, with the hulls you can
                          actually see. Everything drawn here is already
                          in state, which the server filtered by fog of
                          war before it reached us. */}
                      {it.battle && (() => {
                        const sides = it.battle.sides;
                        // HULLS WEAR THEIR HEALTH, not their flag. The
                        // side already carries its empire's colour on
                        // the rail, the label and the bar, so spending
                        // the silhouettes on it too said the same thing
                        // three times — while the one fact you scan a
                        // battle for, who is dying, was a dimmed icon.
                        // Same ramp as the outliner's hull dots, so a
                        // colour means one thing everywhere.
                        const hpColor = (pct: number | null) => (pct == null
                          ? '#8aa0b4'
                          : pct <= 33 ? '#ff5e5e' : pct <= 66 ? '#ffb84d' : '#6ee7b7');
                        const hpColor2 = (pct: number | null) => (pct == null
                          ? '#5a7080'
                          : pct <= 33 ? '#a63636' : pct <= 66 ? '#a67430' : '#3f8f78');
                        const totalDmg = sides.reduce((n, x) => n + x.damage, 0) || 1;
                        return (
                        <div className="sit-battle">
                          {/* THE SHAPE OF THE FIGHT, first. "7 vs 56" is
                              the story, and it was buried in text — this
                              is the same numbers as a bar you read in one
                              glance. Weighted by DAMAGE, not hull count:
                              fifty freighters are not a fleet. */}
                          <div className="sit-battle__bar" aria-hidden="true">
                            {sides.map(side => (
                              <i
                                key={side.factionId}
                                style={{
                                  width: `${Math.max(2, (side.damage / totalDmg) * 100)}%`,
                                  background: side.color,
                                }}
                              />
                            ))}
                          </div>
                          {sides.map(side => (
                            <div
                              key={side.factionId}
                              className={`sit-battle__side${side.mine ? ' is-mine' : ''}`}
                              style={{ borderLeftColor: side.color }}
                            >
                              <div className="sit-battle__who">
                                <span
                                  className="sit-battle__flag"
                                  style={{ color: side.color }}
                                  title={side.mine ? 'Your forces' : side.factionName}
                                >{side.mine ? 'YOU' : side.factionName}</span>
                                <span className="sit-battle__count">
                                  {side.total} · {Math.round(side.damage)} dmg/t
                                </span>
                              </div>
                              {/* ICONS, NOT A ROSTER. Forty names is a
                                  wall; forty silhouettes is a force you
                                  can size up. Names are earned below by
                                  being a casualty. */}
                              <div className="sit-battle__hulls">
                                {side.ships.map(sh => (
                                  <button
                                    key={sh.id}
                                    type="button"
                                    className="sit-battle__hull"
                                    onClick={() => { close(); selectShip(sh.id); }}
                                    title={`${sh.name} — ${sh.shipClass}${sh.hpPct != null ? ` · ${sh.hpPct}% hull` : ''}`}
                                    aria-label={sh.name}
                                  >
                                    <ShipIcon
                                      shipClass={sh.shipClass as ShipClassName}
                                      variant={sh.iconVariant as never}
                                      size={17}
                                      color={hpColor(sh.hpPct)}
                                      color2={hpColor2(sh.hpPct)}
                                    />
                                  </button>
                                ))}
                                {side.hidden > 0 && (
                                  <span className="sit-battle__more">+{side.hidden}</span>
                                )}
                              </div>
                              {side.hurt.length > 0 && (
                                <div className="sit-battle__hurt">
                                  {side.hurt.map(h => (
                                    <button
                                      key={h.id}
                                      type="button"
                                      className={`sit-battle__casualty${h.hpPct <= 33 ? ' is-low' : ''}`}
                                      onClick={() => { close(); selectShip(h.id); }}
                                    >{h.name} <b>{h.hpPct}%</b></button>
                                  ))}
                                </div>
                              )}
                            </div>
                          ))}
                        </div>
                        );
                      })()}
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
