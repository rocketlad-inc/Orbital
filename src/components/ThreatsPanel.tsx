// ============================================================
// ThreatsPanel — top-right HUD listing incoming hostile ships
// whose trajectories arrive at player-owned bodies.
// ============================================================

import React, { useEffect, useRef, useState } from 'react';
import { useGameContext } from '../state/gameContext';
import { computeIncomingThreats, IncomingThreat } from '../game/threats';
import { ShipIcon, ShipIconClass } from './ShipIcons';

/** Urgency by ticks-until-arrival → label + color */
function urgency(ticks: number): { label: string; color: string; bg: string } {
  if (ticks <= 10) return { label: 'IMMINENT', color: '#ff3030', bg: 'rgba(255, 48, 48, 0.15)' };
  if (ticks <= 30) return { label: 'INCOMING', color: '#ff8a4d', bg: 'rgba(255, 138, 77, 0.12)' };
  return { label: 'DETECTED', color: '#ffb84d', bg: 'rgba(255, 184, 77, 0.08)' };
}

export const ThreatsPanel: React.FC = () => {
  const { gameState, focusBody } = useGameContext();
  const allThreats = computeIncomingThreats(gameState, 'player');

  // Faction lookup for displaying the attacker's empire name + color, so
  // the player can instantly tell whose ship is incoming rather than
  // squinting at a 3-letter suffix on the ship name (e.g. "Hauler-OUT").
  const factionsById = React.useMemo(() => {
    const m = new Map<string, { name: string; color: string }>();
    for (const f of gameState.factions) m.set(f.id, { name: f.name, color: f.color });
    return m;
  }, [gameState.factions]);

  // Per-threat dismissal. Stores `threatKey()` strings the player has
  // explicitly silenced. Self-prunes when the underlying threat goes
  // away (ship destroyed, retargeted, arrived) so a re-occurring threat
  // re-surfaces instead of staying invisible forever.
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  useEffect(() => {
    const active = new Set(allThreats.map(threatKey));
    setDismissed(prev => {
      let changed = false;
      const next = new Set<string>();
      for (const k of prev) {
        if (active.has(k)) next.add(k);
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [allThreats]);
  const threats = allThreats.filter(t => !dismissed.has(threatKey(t)));

  // Pulse animation for newly-detected threats. We diff the set of threat ids
  // each render; ids absent last time get a brief flash via CSS.
  const seenRef = useRef<Set<string>>(new Set());
  const [newIds, setNewIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    const current = new Set(threats.map(threatKey));
    const fresh = new Set<string>();
    for (const id of current) if (!seenRef.current.has(id)) fresh.add(id);
    seenRef.current = current;
    if (fresh.size > 0) {
      setNewIds(fresh);
      const t = setTimeout(() => setNewIds(new Set()), 2400);
      return () => clearTimeout(t);
    }
  // re-run when the active threat set changes
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threats.map(threatKey).join('|')]);

  const dismissThreat = (key: string) => {
    setDismissed(prev => {
      const next = new Set(prev);
      next.add(key);
      return next;
    });
  };

  const dismissAll = () => {
    setDismissed(new Set(allThreats.map(threatKey)));
  };

  if (threats.length === 0) return null;

  return (
    <div
      className="threats-panel"
      style={{
        position: 'fixed',
        top: 56,
        right: 20,
        zIndex: 1100,
        width: 280,
        maxHeight: '60vh',
        overflowY: 'auto',
        background: 'rgba(10, 14, 20, 0.92)',
        border: '1px solid #ff5e5e',
        borderRadius: 4,
        padding: '8px 10px',
        fontFamily: "'JetBrains Mono', monospace",
        color: '#d8e4ee',
        boxShadow: '0 0 12px rgba(255, 94, 94, 0.25)',
      }}
    >
      <div style={{
        fontSize: 10, letterSpacing: '0.12em', color: '#ff5e5e',
        marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6,
      }}>
        <span style={{ fontSize: 12 }}>⚠</span>
        <span>THREATS · {threats.length}</span>
        {threats.length > 1 && (
          <button
            onClick={dismissAll}
            title="Dismiss all threats"
            style={{
              marginLeft: 'auto',
              background: 'transparent',
              border: '1px solid #2a3d50',
              borderRadius: 3,
              color: '#8a9fb3',
              fontFamily: 'inherit',
              fontSize: 9,
              letterSpacing: '0.08em',
              padding: '2px 6px',
              cursor: 'pointer',
            }}
          >
            CLEAR ALL
          </button>
        )}
      </div>
      {threats.map(t => (
        <ThreatRow
          key={threatKey(t)}
          threat={t}
          faction={factionsById.get(t.attackerFaction) ?? null}
          isNew={newIds.has(threatKey(t))}
          onClick={() => focusBody(t.targetBodyId)}
          onDismiss={() => dismissThreat(threatKey(t))}
        />
      ))}
    </div>
  );
};

function threatKey(t: IncomingThreat): string {
  // Unique by attacker + target — re-targeted transfers count as a new threat.
  return `${t.attackerShipId}→${t.targetBodyId}`;
}

interface ThreatRowProps {
  threat: IncomingThreat;
  faction: { name: string; color: string } | null;
  isNew: boolean;
  onClick: () => void;
  onDismiss: () => void;
}

const ThreatRow: React.FC<ThreatRowProps> = ({ threat, faction, isNew, onClick, onDismiss }) => {
  const u = urgency(threat.ticksUntilArrival);
  const factionColor = faction?.color ?? '#ff5e5e';
  const factionName = faction?.name ?? threat.attackerFaction;
  return (
    <div
      onClick={onClick}
      style={{
        padding: '6px 8px',
        marginBottom: 4,
        border: `1px solid ${u.color}`,
        borderRadius: 3,
        background: u.bg,
        cursor: 'pointer',
        animation: isNew ? 'threatBlink 0.6s ease-in-out 0s 3' : undefined,
        position: 'relative',
      }}
      title="Click to focus on the threatened body"
    >
      <div style={{
        display: 'flex', alignItems: 'center', gap: 6,
        fontSize: 9, letterSpacing: '0.08em', color: u.color, marginBottom: 3,
      }}>
        <span>{u.label}</span>
        <span style={{ marginLeft: 'auto', color: '#d8e4ee', fontWeight: 'bold' }}>
          T-{threat.ticksUntilArrival.toFixed(0)}
        </span>
        <button
          onClick={(e) => { e.stopPropagation(); onDismiss(); }}
          title="Dismiss this threat"
          aria-label="Dismiss"
          style={{
            background: 'transparent',
            border: 'none',
            color: '#8a9fb3',
            cursor: 'pointer',
            padding: 0,
            marginLeft: 4,
            fontSize: 12,
            lineHeight: 1,
            width: 16,
            height: 16,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          ✕
        </button>
      </div>
      {/* Attacker faction line — explicit so "Hauler-OUT" reads as
          "Outer Alliance — Hauler", not "is that one of MY haulers?" */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 5,
        fontSize: 9, letterSpacing: '0.05em', marginBottom: 3,
      }}>
        <span style={{
          width: 8, height: 8, borderRadius: 2,
          background: factionColor, flexShrink: 0,
        }} />
        <span style={{ color: factionColor, textTransform: 'uppercase', fontWeight: 600 }}>
          {factionName}
        </span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11 }}>
        <span style={{ color: factionColor, display: 'inline-flex' }}>
          <ShipIcon shipClass={threat.attackerClass as ShipIconClass} size={16} />
        </span>
        <span style={{ flex: 1 }}>
          <span style={{ color: '#d8e4ee', fontWeight: 'bold' }}>{threat.attackerName}</span>
          <span style={{ color: '#8a9fb3' }}> → </span>
          <span style={{ color: '#ffb84d' }}>{threat.targetBodyName.toUpperCase()}</span>
        </span>
      </div>
      <div style={{ fontSize: 9, color: '#8aa0b4', marginTop: 2, paddingLeft: 22 }}>
        Defending: {threat.threatenedShipCount > 0 && `${threat.threatenedShipCount} ship${threat.threatenedShipCount === 1 ? '' : 's'}`}
        {threat.threatenedShipCount > 0 && threat.threatenedSettlementCount > 0 && ' · '}
        {threat.threatenedSettlementCount > 0 && `${threat.threatenedSettlementCount} settlement${threat.threatenedSettlementCount === 1 ? '' : 's'}`}
      </div>
    </div>
  );
};
