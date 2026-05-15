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
  const threats = computeIncomingThreats(gameState, 'player');

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

  if (threats.length === 0) return null;

  return (
    <div
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
      </div>
      {threats.map(t => (
        <ThreatRow
          key={threatKey(t)}
          threat={t}
          isNew={newIds.has(threatKey(t))}
          onClick={() => focusBody(t.targetBodyId)}
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
  isNew: boolean;
  onClick: () => void;
}

const ThreatRow: React.FC<ThreatRowProps> = ({ threat, isNew, onClick }) => {
  const u = urgency(threat.ticksUntilArrival);
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
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11 }}>
        <span style={{ color: u.color, display: 'inline-flex' }}>
          <ShipIcon shipClass={threat.attackerClass as ShipIconClass} size={16} />
        </span>
        <span style={{ flex: 1 }}>
          <span style={{ color: '#d8e4ee', fontWeight: 'bold' }}>{threat.attackerName}</span>
          <span style={{ color: '#6b8195' }}> → </span>
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
