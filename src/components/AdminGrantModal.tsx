// ============================================================
// AdminGrantModal — debug/host tool to grant or drain resources.
//
// Opened from the SideMenu's DEBUG (SP) or HOST ADMIN (MP) section.
// In SP it mutates local gameState immediately via adjustResources.
// In MP it also posts to /api/games/:gameId/admin/grant so the
// server's authoritative pools update; without that, the next /state
// poll would overwrite the local change.
//
// Faction picker:
//   - 'me'  → the caller's faction only (the common "I got drained by
//             a bug, give me back what I lost" path)
//   - 'all' → every faction in the game (handy for rebalancing during
//             a playtest)
//   - <id>  → a specific faction (host wants to nerf/buff someone)
//
// Resource inputs accept signed integers so the same tool drains too.
// ============================================================

import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { useGameContext } from '../state/gameContext';
import { useMultiplayerActions } from '../multiplayer/MultiplayerActionsContext';

interface Props {
  onClose: () => void;
  /** When set, posts the grant to the server in addition to the local
   *  mutation. Pass the active game id; if absent, treated as SP. */
  mpGameId?: string | null;
}

const PRESETS = [
  { label: '+50',   v: 50 },
  { label: '+100',  v: 100 },
  { label: '+500',  v: 500 },
  { label: '+1000', v: 1000 },
];

export const AdminGrantModal: React.FC<Props> = ({ onClose, mpGameId }) => {
  const { gameState, adjustResources } = useGameContext();
  const mpActions = useMultiplayerActions();

  const [target, setTarget] = useState<string>('me');
  const [fuel, setFuel] = useState('0');
  const [ore, setOre] = useState('0');
  const [credits, setCredits] = useState('0');
  const [science, setScience] = useState('0');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const factions = gameState.factions ?? [];
  const myFactionId =
    factions.find(f => !f.isAI)?.id ?? 'player';

  const applyPreset = (delta: number) => {
    const n = String(delta);
    setFuel(n); setOre(n); setCredits(n); setScience(n);
  };

  const handleApply = async () => {
    setError(null);
    setStatus(null);
    const delta = {
      fuel: parseInt(fuel || '0', 10) || 0,
      ore: parseInt(ore || '0', 10) || 0,
      credits: parseInt(credits || '0', 10) || 0,
      science: parseInt(science || '0', 10) || 0,
    };
    if (!delta.fuel && !delta.ore && !delta.credits && !delta.science) {
      setError('Enter at least one non-zero amount, or pick a preset.');
      return;
    }
    const factionId = target === 'me' ? myFactionId : target;
    setBusy(true);
    try {
      adjustResources(factionId, delta);
      if (mpGameId && mpActions) {
        const res = await mpActions.adminGrant(factionId === 'all' ? 'all' : factionId, delta);
        if (!res.ok) {
          setError(res.error ?? 'Server rejected the grant. Local state was changed but will reset on next /state poll.');
          setBusy(false);
          return;
        }
      }
      setStatus(`Applied to ${factionId === 'all' ? 'every faction' : factionId}.`);
      setFuel('0'); setOre('0'); setCredits('0'); setScience('0');
    } finally {
      setBusy(false);
    }
  };

  return createPortal(
    <div
      role="dialog"
      aria-label="Admin Resource Grant"
      style={{
        position: 'fixed', inset: 0, zIndex: 2000,
        background: 'rgba(5, 8, 14, 0.78)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontFamily: 'var(--font-body)', color: '#d8e4ee',
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 'min(480px, 92vw)',
          background: 'linear-gradient(180deg, #131c27 0%, #070b13 100%)',
          border: '1px solid #ff5e5e', borderRadius: 8,
          boxShadow: '0 16px 40px rgba(0, 0, 0, 0.6)',
        }}
      >
        <header
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '14px 18px', borderBottom: '1px solid #2a3d50',
          }}
        >
          <div>
            <div style={{ fontSize: 10, letterSpacing: '0.16em', color: '#ff5e5e' }}>DEBUG · ADMIN</div>
            <div style={{ fontSize: 16, fontWeight: 700, color: '#ffb84d', letterSpacing: '0.08em' }}>
              GRANT RESOURCES
            </div>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            style={{
              width: 32, height: 32, border: '1px solid #2a3d50',
              background: 'transparent', color: '#d8e4ee', borderRadius: 4, cursor: 'pointer',
            }}
          >✕</button>
        </header>

        <div style={{ padding: '14px 18px', display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div>
            <label style={{ fontSize: 10, color: '#b8c8d6', letterSpacing: '0.1em', display: 'block', marginBottom: 4 }}>
              TARGET
            </label>
            <select
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              style={{
                width: '100%', padding: '6px 10px',
                background: '#0a1018', border: '1px solid #2a3d50',
                color: '#d8e4ee', fontFamily: 'inherit', fontSize: 12, borderRadius: 4,
              }}
            >
              <option value="me">Me ({myFactionId})</option>
              <option value="all">All factions</option>
              {factions.map(f => (
                <option key={f.id} value={f.id}>
                  {f.name ?? f.id}{f.isAI ? ' [AI]' : ''}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label style={{ fontSize: 10, color: '#b8c8d6', letterSpacing: '0.1em', display: 'block', marginBottom: 4 }}>
              PRESETS (applies to all four fields)
            </label>
            <div style={{ display: 'flex', gap: 6 }}>
              {PRESETS.map(p => (
                <button
                  key={p.label}
                  onClick={() => applyPreset(p.v)}
                  style={{
                    flex: 1, padding: '6px 0',
                    background: 'transparent', color: '#4ecdc4',
                    border: '1px solid #4ecdc4', borderRadius: 3,
                    fontFamily: 'inherit', fontSize: 11, cursor: 'pointer',
                  }}
                >{p.label}</button>
              ))}
              <button
                onClick={() => applyPreset(0)}
                style={{
                  flex: 0.6, padding: '6px 0',
                  background: 'transparent', color: '#b8c8d6',
                  border: '1px solid #2a3d50', borderRadius: 3,
                  fontFamily: 'inherit', fontSize: 11, cursor: 'pointer',
                }}
              >0</button>
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            {([
              ['FUEL',    fuel,    setFuel,    '#7fffa1'],
              ['METAL',   ore,     setOre,     '#ffb84d'],
              ['CREDITS', credits, setCredits, '#4ecdc4'],
              ['SCIENCE', science, setScience, '#bd93f9'],
            ] as Array<[string, string, (s: string) => void, string]>).map(([label, val, setVal, color]) => (
              <div key={label}>
                <label style={{ fontSize: 10, color, letterSpacing: '0.1em', display: 'block', marginBottom: 4 }}>
                  {label}
                </label>
                <input
                  type="number"
                  inputMode="numeric"
                  value={val}
                  onChange={(e) => setVal(e.target.value)}
                  style={{
                    width: '100%', padding: '6px 10px',
                    background: '#0a1018', border: `1px solid ${color}`,
                    color: '#d8e4ee', fontFamily: 'inherit', fontSize: 12,
                    borderRadius: 4,
                  }}
                />
              </div>
            ))}
          </div>

          {error && (
            <div
              style={{
                padding: '8px 10px',
                background: 'rgba(255, 94, 94, 0.1)',
                border: '1px solid #ff5e5e', borderRadius: 4,
                color: '#ff5e5e', fontSize: 11,
              }}
            >{error}</div>
          )}
          {status && !error && (
            <div
              style={{
                padding: '8px 10px',
                background: 'rgba(127, 255, 161, 0.08)',
                border: '1px solid #7fffa1', borderRadius: 4,
                color: '#7fffa1', fontSize: 11,
              }}
            >{status}</div>
          )}

          <div style={{ fontSize: 10, color: '#b8c8d6', fontStyle: 'italic' }}>
            {mpGameId
              ? 'Host-only on the server. Local change applies immediately; server rejects with 403 if you are not the host.'
              : 'Single-player only — values mutate this campaign\'s state.'}
          </div>

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <button
              onClick={onClose}
              disabled={busy}
              style={{
                padding: '6px 14px',
                background: 'transparent', color: '#b8c8d6',
                border: '1px solid #2a3d50', borderRadius: 4, cursor: 'pointer',
                fontFamily: 'inherit', fontSize: 11, letterSpacing: '0.08em',
              }}
            >CANCEL</button>
            <button
              onClick={handleApply}
              disabled={busy}
              style={{
                padding: '6px 14px',
                background: '#ffb84d', color: '#0a1018',
                border: 'none', borderRadius: 4,
                cursor: busy ? 'default' : 'pointer',
                fontFamily: 'inherit', fontSize: 11, fontWeight: 700, letterSpacing: '0.08em',
                opacity: busy ? 0.6 : 1,
              }}
            >▶ APPLY</button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
};
