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

export type DockRailKey = 'situation' | 'multiplayer';

interface Badge {
  count: number;
  hasWarn: boolean;
}

const ICON_KEYS: DockRailKey[] = ['situation', 'multiplayer'];

export const DockRail: React.FC = () => {
  const [active, setActive] = useState<DockRailKey | null>(null);
  const [badges, setBadges] = useState<Record<DockRailKey, Badge>>({
    situation:   { count: 0, hasWarn: false },
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
    window.addEventListener('dockrail:badge', onBadge as EventListener);
    window.addEventListener('dockrail:set', onSet as EventListener);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('dockrail:badge', onBadge as EventListener);
      window.removeEventListener('dockrail:set', onSet as EventListener);
      window.removeEventListener('keydown', onKey);
    };
  }, []);

  function toggle(which: DockRailKey) {
    setActive(prev => (prev === which ? null : which));
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
        which="multiplayer"
        active={active === 'multiplayer'}
        badge={badges.multiplayer}
        icon={<PeopleIcon />}
        label="Multiplayer"
        onClick={() => toggle('multiplayer')}
      />
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

const PeopleIcon: React.FC = () => (
  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <circle cx="9" cy="8" r="3.1" />
    <path d="M3.5 19.5a5.5 5.5 0 0 1 11 0" />
    <path d="M16 5.3a3.1 3.1 0 0 1 0 5.7" />
    <path d="M17.2 14.5a5.5 5.5 0 0 1 3.3 5" />
  </svg>
);
