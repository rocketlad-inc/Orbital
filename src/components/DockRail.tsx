// ============================================================
// DockRail
//
// Vertical icon column on the right edge of the game. Owns "which
// side panel is open" — clicking an icon opens its panel; clicking
// the active icon (or pressing Esc) closes it. Other icons remain
// available so you can swap between panels without going back to a
// "neutral" state first.
//
// State is a single union: activePanel = 'situation' | 'multiplayer'
// | null. Changes broadcast via 'dockrail:active' so panel components
// know when to render. Panels dispatch 'dockrail:badge' to report
// their counts; the rail's per-icon badge updates automatically.
//
// Mounted once at the App level. Panels are siblings (SituationLog,
// MultiplayerShell's dock body) and respond to the active state via
// window events — no shared React context needed.
// ============================================================

import React, { useEffect, useState } from 'react';
import './DockRail.css';

export type DockRailKey = 'situation' | 'eventlog' | 'multiplayer';

/** Panels owned by App-level state (TopBar nav). On mobile the rail
 *  surfaces these too — their nav buttons are hidden from the top bar
 *  to free up resource-pill space — and toggles them via the existing
 *  `orbital:open-panel` event. App dispatches `orbital:panel-state`
 *  whenever its activePanel changes so the rail can mirror the active
 *  highlight here. Desktop ignores this column via CSS. */
export type ExternalPanel = 'settlements' | 'fleet' | 'research';

interface Badge {
  count: number;
  hasWarn: boolean;
}

const ICON_KEYS: DockRailKey[] = ['situation', 'eventlog', 'multiplayer'];
const EXTERNAL_KEYS: ExternalPanel[] = ['settlements', 'fleet', 'research'];

export const DockRail: React.FC = () => {
  const [active, setActive] = useState<DockRailKey | null>(null);
  // Mirror of App.tsx's activePanel so the 3 mobile-only rail buttons
  // (settlements / fleet / research) can show the right active state
  // even though the underlying panel state lives in App.
  const [externalActive, setExternalActive] = useState<ExternalPanel | null>(null);
  const [badges, setBadges] = useState<Record<DockRailKey, Badge>>({
    situation:   { count: 0, hasWarn: false },
    eventlog:    { count: 0, hasWarn: false },
    multiplayer: { count: 0, hasWarn: false },
  });

  // Broadcast active changes so SitLog + MP know when to render.
  useEffect(() => {
    try {
      window.dispatchEvent(new CustomEvent('dockrail:active', { detail: { active } }));
    } catch { /* noop */ }
  }, [active]);

  // Panels report their count + warn state via this single channel.
  // Either side may also choose to update the active panel via the
  // 'dockrail:set' event (e.g. SitLog clicking a 'panel' item opens
  // multiplayer's Senate tab).
  useEffect(() => {
    const onBadge = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (!detail || !ICON_KEYS.includes(detail.which)) return;
      setBadges(prev => ({
        ...prev,
        [detail.which as DockRailKey]: {
          count: Math.max(0, Number(detail.count) || 0),
          hasWarn: !!detail.hasWarn,
        },
      }));
    };
    const onSet = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (!detail) return;
      const next = detail.active as DockRailKey | null;
      if (next === null || ICON_KEYS.includes(next)) setActive(next ?? null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setActive(null);
    };
    // External panel state — App.tsx broadcasts whenever its activePanel
    // changes so the mobile rail can mirror the "active" highlight on
    // the settlements / fleet / research buttons.
    const onPanelState = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      const panel = detail?.panel as ExternalPanel | null | undefined;
      if (panel === null || panel === undefined) {
        setExternalActive(null);
      } else if (EXTERNAL_KEYS.includes(panel)) {
        setExternalActive(panel);
      }
    };
    window.addEventListener('dockrail:badge', onBadge as EventListener);
    window.addEventListener('dockrail:set', onSet as EventListener);
    window.addEventListener('orbital:panel-state', onPanelState as EventListener);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('dockrail:badge', onBadge as EventListener);
      window.removeEventListener('dockrail:set', onSet as EventListener);
      window.removeEventListener('orbital:panel-state', onPanelState as EventListener);
      window.removeEventListener('keydown', onKey);
    };
  }, []);

  function toggle(which: DockRailKey) {
    setActive(prev => (prev === which ? null : which));
  }

  /** Toggle one of the App-owned panels. Same dispatch path that
   *  SitLog uses to navigate to senate / trades, except we route
   *  through the 'orbital:open-panel' bridge App mounts in GameUI
   *  — and the bridge now treats a same-key dispatch as a toggle. */
  function toggleExternal(panel: ExternalPanel) {
    const next: ExternalPanel | null = externalActive === panel ? null : panel;
    try {
      window.dispatchEvent(new CustomEvent('orbital:open-panel', { detail: { panel: next } }));
    } catch { /* noop */ }
  }

  return (
    <div className="dock-rail" role="toolbar" aria-label="Side panels">
      <DockButton
        which="situation"
        active={active === 'situation'}
        badge={badges.situation}
        icon={<SitIcon />}
        label="Situation Report"
        onClick={() => toggle('situation')}
      />
      <DockButton
        which="eventlog"
        active={active === 'eventlog'}
        badge={badges.eventlog}
        icon={<EventLogIcon />}
        label="Event Log"
        onClick={() => toggle('eventlog')}
      />
      <DockButton
        which="multiplayer"
        active={active === 'multiplayer'}
        badge={badges.multiplayer}
        icon={<PeopleIcon />}
        label="Multiplayer"
        onClick={() => toggle('multiplayer')}
      />

      {/* Mobile-only buttons: settlements / fleet / research are TopBar
          nav items on desktop. On phones the top bar can't hold both
          the resource pills AND those nav buttons without one of them
          getting clipped, so the three move down here. Hidden on
          desktop via .dock-rail__btn--mobile-only in DockRail.css. */}
      <button
        className={`dock-rail__btn dock-rail__btn--mobile-only${externalActive === 'settlements' ? ' is-active' : ''}`}
        onClick={() => toggleExternal('settlements')}
        title="Settlements"
        aria-label="Settlements"
        aria-pressed={externalActive === 'settlements'}
      >
        <span className="dock-rail__icon"><SettlementsIcon /></span>
      </button>
      <button
        className={`dock-rail__btn dock-rail__btn--mobile-only${externalActive === 'fleet' ? ' is-active' : ''}`}
        onClick={() => toggleExternal('fleet')}
        title="Fleet"
        aria-label="Fleet"
        aria-pressed={externalActive === 'fleet'}
      >
        <span className="dock-rail__icon"><FleetIcon /></span>
      </button>
      <button
        className={`dock-rail__btn dock-rail__btn--mobile-only${externalActive === 'research' ? ' is-active' : ''}`}
        onClick={() => toggleExternal('research')}
        title="Research"
        aria-label="Research"
        aria-pressed={externalActive === 'research'}
      >
        <span className="dock-rail__icon"><ResearchIcon /></span>
      </button>
    </div>
  );
};

interface DockButtonProps {
  which: DockRailKey;
  active: boolean;
  badge: Badge;
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}

const DockButton: React.FC<DockButtonProps> = ({ active, badge, icon, label, onClick }) => {
  const hasBadge = badge.count > 0;
  return (
    <button
      className={`dock-rail__btn${active ? ' is-active' : ''}${badge.hasWarn ? ' has-warn' : ''}`}
      onClick={onClick}
      title={hasBadge ? `${label} · ${badge.count}` : label}
      aria-label={label}
      aria-pressed={active}
    >
      <span className="dock-rail__icon">{icon}</span>
      {hasBadge && (
        <span className="dock-rail__badge">
          {badge.count > 99 ? '99+' : badge.count}
          {badge.hasWarn && <span className="dock-rail__warn" aria-hidden />}
        </span>
      )}
      {/* Tail nub points toward the open panel when active — gives the
          visual "the panel comes from this button" cue. */}
      {active && <span className="dock-rail__nub" aria-hidden />}
    </button>
  );
};

// ----- Icons -----

const SitIcon: React.FC = () => (
  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M5 6h14M5 10h14M5 14h9M5 18h9" />
  </svg>
);

/** Event Log — timeline-with-bullet-dots. Distinct from SitIcon's
 *  plain hamburger so the two adjacent rail buttons read as
 *  different concepts ("attention items now" vs "history of events"). */
const EventLogIcon: React.FC = () => (
  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <circle cx="6" cy="6" r="1.4" fill="currentColor" stroke="none" />
    <circle cx="6" cy="12" r="1.4" fill="currentColor" stroke="none" />
    <circle cx="6" cy="18" r="1.4" fill="currentColor" stroke="none" />
    <path d="M11 6h9M11 12h9M11 18h6" />
  </svg>
);

const PeopleIcon: React.FC = () => (
  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <circle cx="9" cy="8" r="3.1" />
    <path d="M3.5 19.5a5.5 5.5 0 0 1 11 0" />
    <path d="M16 5.3a3.1 3.1 0 0 1 0 5.7" />
    <path d="M17.2 14.5a5.5 5.5 0 0 1 3.3 5" />
  </svg>
);

const SettlementsIcon: React.FC = () => (
  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M4 20V11l8-6 8 6v9" />
    <path d="M9 20v-6h6v6" />
  </svg>
);

const FleetIcon: React.FC = () => (
  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M3 13h18l-2 5H5z" />
    <path d="M7 13V8l5-4 5 4v5" />
    <path d="M12 4v9" />
  </svg>
);

const ResearchIcon: React.FC = () => (
  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <circle cx="12" cy="12" r="2" />
    <ellipse cx="12" cy="12" rx="9" ry="3.5" />
    <ellipse cx="12" cy="12" rx="9" ry="3.5" transform="rotate(60 12 12)" />
    <ellipse cx="12" cy="12" rx="9" ry="3.5" transform="rotate(120 12 12)" />
  </svg>
);
