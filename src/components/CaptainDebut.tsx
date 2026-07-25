// ============================================================
// CaptainDebut — the naming moment (DESIGN-captains §5.1).
//
// A small DISMISSIBLE card when one of your ships launches with a
// freshly minted captain: portrait + name + trait, inline rename.
// Offer, never block: ignore it and the auto-generated captain simply
// stands; it self-dismisses after 20s. Fired by the MP provider via
// the 'orbital:captain-debut' window event; mounted in GameUI (MP only).
// ============================================================

import React, { useEffect, useRef, useState } from 'react';
import { useMultiplayerActions } from '../multiplayer/MultiplayerActionsContext';
import { CaptainAvatar } from './CaptainAvatar';
import { traitSummary } from '../game/captains';

interface Debut {
  captainId: string;
  captainName: string;
  captainAvatar: string | null;
  captainTraits: string[];
  shipName: string;
}

export const CaptainDebut: React.FC = () => {
  const mpActions = useMultiplayerActions();
  const [debut, setDebut] = useState<Debut | null>(null);
  const [name, setName] = useState('');
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    const onDebut = (e: Event) => {
      const d = (e as CustomEvent).detail as Debut;
      if (!d?.captainId) return;
      setDebut(d);
      setName(d.captainName);
      if (timerRef.current) window.clearTimeout(timerRef.current);
      // Auto-dismiss: this is a whisper, not a modal.
      timerRef.current = window.setTimeout(() => setDebut(null), 20000);
    };
    window.addEventListener('orbital:captain-debut', onDebut as EventListener);
    return () => {
      window.removeEventListener('orbital:captain-debut', onDebut as EventListener);
      if (timerRef.current) window.clearTimeout(timerRef.current);
    };
  }, []);

  if (!debut || !mpActions) return null;

  const commit = () => {
    const v = name.trim();
    if (v && v !== debut.captainName) {
      mpActions.updateCaptain(debut.captainId, { name: v });
    }
    setDebut(null);
  };

  return (
    <div
      style={{
        position: 'fixed', bottom: 18, right: 18, zIndex: 3000,
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '10px 12px', maxWidth: 340,
        background: 'rgba(10, 14, 20, 0.96)', border: '1px solid #2f6f6a',
        borderRadius: 8, color: '#d8e4ee', fontSize: 11,
        boxShadow: '0 4px 18px rgba(0,0,0,0.5)',
      }}
      role="status"
    >
      <CaptainAvatar avatarId={debut.captainAvatar} size={36} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 9, letterSpacing: '0.1em', color: '#4ecdc4', marginBottom: 3 }}>
          NEW COMMAND · {debut.shipName.toUpperCase()}
        </div>
        <input
          value={name}
          maxLength={32}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') setDebut(null); }}
          style={{
            width: '100%', background: '#14202c', border: '1px solid #2a3d50',
            borderRadius: 3, color: '#d8e4ee', fontFamily: 'inherit',
            fontSize: 11, padding: '3px 6px',
          }}
          title="Rename your captain (Enter to save, Esc to dismiss)"
        />
        <div style={{ fontSize: 9, color: '#8aa0b4', marginTop: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {traitSummary(debut.captainTraits) || 'Reporting for duty.'}
        </div>
      </div>
      <button
        onClick={commit}
        title="Confirm"
        style={{
          background: '#103a3a', color: '#4ecdc4', border: '1px solid #2f6f6a',
          borderRadius: 4, padding: '4px 8px', fontFamily: 'inherit', fontSize: 10, cursor: 'pointer',
        }}
      >✓</button>
      <button
        onClick={() => setDebut(null)}
        aria-label="Dismiss"
        style={{ background: 'transparent', border: 'none', color: '#5f7488', cursor: 'pointer', fontSize: 12 }}
      >✕</button>
    </div>
  );
};
