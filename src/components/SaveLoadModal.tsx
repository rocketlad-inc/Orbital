// ============================================================
// SaveLoadModal — picker for SP saves.
//
// Two modes (set by `mode` prop):
//   'save' — shows existing saves as overwrite targets PLUS a name
//            input for a fresh slot. The action button is "SAVE".
//   'load' — shows existing saves as load targets PLUS an Import-from-file
//            button. The action button is "LOAD" (per row).
//
// Used by SideMenu (in-game save/load) and SinglePlayerSetup (load from
// the setup screen as an alternative to "New Campaign"). Both consumers
// pass `onLoad` / `onSave` handlers that bridge back to the App's
// GameState + phase machinery.
// ============================================================

import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  listSaves, writeSave, readSave, deleteSave, exportSave, importSave,
  formatBytes, formatSavedAt, SaveMeta, AUTOSAVE_ID,
} from '../state/saveGame';
import { GameState } from '../types';

interface SaveLoadModalProps {
  mode: 'save' | 'load';
  onClose: () => void;
  /** In 'save' mode, supplies the current GameState to persist. */
  currentState?: GameState;
  /** In 'load' mode, called with the deserialized GameState after the
   *  player picks a save. Caller is responsible for swapping it into
   *  the active game / phase machine. */
  onLoad?: (state: GameState, meta: SaveMeta) => void;
}

export const SaveLoadModal: React.FC<SaveLoadModalProps> = ({
  mode, onClose, currentState, onLoad,
}) => {
  const [saves, setSaves] = useState<SaveMeta[]>(() => listSaves());
  const [newName, setNewName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Esc closes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const refresh = () => setSaves(listSaves());

  const handleNewSave = () => {
    if (!currentState) return;
    setError(null);
    const name = newName.trim() || `Campaign T+${Math.floor(currentState.currentTick)}`;
    const meta = writeSave(currentState, name);
    if (!meta) {
      setError('Could not save — storage may be full or unavailable.');
      return;
    }
    setNewName('');
    refresh();
  };

  const handleOverwrite = (id: string) => {
    if (!currentState) return;
    setBusyId(id);
    setError(null);
    const existing = saves.find(s => s.id === id);
    const meta = writeSave(currentState, existing?.name ?? `Save`, id);
    setBusyId(null);
    if (!meta) {
      setError('Could not overwrite — storage may be full.');
      return;
    }
    refresh();
  };

  const handleLoad = (id: string) => {
    setBusyId(id);
    setError(null);
    const result = readSave(id);
    setBusyId(null);
    if (!result) {
      setError('Could not load — save is missing or written against an older schema.');
      return;
    }
    onLoad?.(result.state, result.meta);
    onClose();
  };

  const handleDelete = (id: string) => {
    if (!window.confirm('Delete this save? This cannot be undone.')) return;
    deleteSave(id);
    refresh();
  };

  const handleExport = (id: string) => {
    if (!exportSave(id)) setError('Could not export — save is missing.');
  };

  const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // reset so the same file can be re-picked
    if (!file) return;
    setError(null);
    try {
      await importSave(file);
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Import failed.');
    }
  };

  const title = mode === 'save' ? 'Save Game' : 'Load Game';

  // Portal to document.body — the modal is rendered from inside TopBar,
  // and .top-bar carries a backdrop-filter, which promotes it to a
  // containing block for any `position: fixed` descendant. Without the
  // portal the overlay was sized to the top bar's box and clicks fell
  // through to the canvas underneath. Same trick the SideMenu and
  // EventLogPanel use (see TopBar.tsx).
  return createPortal(
    <div
      role="dialog"
      aria-label={title}
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
          width: 'min(560px, 92vw)', maxHeight: '86vh',
          background: 'linear-gradient(180deg, #131c27 0%, #070b13 100%)',
          border: '1px solid #2a3d50', borderRadius: 8,
          display: 'flex', flexDirection: 'column',
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
            <div style={{ fontSize: 10, letterSpacing: '0.16em', color: '#b8c8d6' }}>SINGLE-PLAYER</div>
            <div style={{ fontSize: 16, fontWeight: 700, color: '#ffb84d', letterSpacing: '0.08em' }}>{title.toUpperCase()}</div>
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

        <div style={{ padding: '14px 18px', flex: 1, overflowY: 'auto' }}>
          {mode === 'save' && currentState && (
            <div
              style={{
                display: 'flex', gap: 8, alignItems: 'center',
                padding: '10px 12px', marginBottom: 14,
                background: 'rgba(255, 184, 77, 0.08)',
                border: '1px solid #ffb84d', borderRadius: 6,
              }}
            >
              <input
                type="text"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder={`Campaign T+${Math.floor(currentState.currentTick)}`}
                maxLength={48}
                style={{
                  flex: 1, padding: '6px 10px',
                  background: '#0a1018', border: '1px solid #2a3d50',
                  borderRadius: 4, color: '#d8e4ee', fontFamily: 'inherit', fontSize: 12,
                }}
              />
              <button
                onClick={handleNewSave}
                style={{
                  padding: '6px 14px',
                  background: '#ffb84d', color: '#0a1018',
                  border: 'none', borderRadius: 4, cursor: 'pointer',
                  fontFamily: 'inherit', fontSize: 11, fontWeight: 700, letterSpacing: '0.08em',
                }}
              >+ NEW SAVE</button>
            </div>
          )}

          {mode === 'load' && (
            <div style={{ marginBottom: 14 }}>
              <input
                ref={fileInputRef}
                type="file"
                accept="application/json,.json"
                onChange={handleImport}
                style={{ display: 'none' }}
              />
              <button
                onClick={() => fileInputRef.current?.click()}
                style={{
                  padding: '6px 14px',
                  background: 'transparent', color: '#4ecdc4',
                  border: '1px solid #4ecdc4', borderRadius: 4, cursor: 'pointer',
                  fontFamily: 'inherit', fontSize: 11, fontWeight: 600, letterSpacing: '0.08em',
                }}
              >⤒ IMPORT FROM FILE</button>
            </div>
          )}

          {error && (
            <div
              style={{
                padding: '8px 12px', marginBottom: 12,
                background: 'rgba(255, 94, 94, 0.1)',
                border: '1px solid #ff5e5e', borderRadius: 4,
                color: '#ff5e5e', fontSize: 11,
              }}
            >{error}</div>
          )}

          {saves.length === 0 ? (
            <div
              style={{
                padding: '32px 16px', textAlign: 'center',
                color: '#b8c8d6', fontSize: 12, fontStyle: 'italic',
              }}
            >
              No saves yet. {mode === 'save' && 'Use the field above to create one.'}
            </div>
          ) : (
            <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
              {saves.map(s => (
                <li
                  key={s.id}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 10,
                    padding: '10px 12px',
                    background: s.id === AUTOSAVE_ID ? 'rgba(78, 205, 196, 0.05)' : '#0a1018',
                    border: `1px solid ${s.id === AUTOSAVE_ID ? '#4ecdc4' : '#2a3d50'}`,
                    borderRadius: 6,
                  }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        display: 'flex', alignItems: 'baseline', gap: 8,
                        fontSize: 13, fontWeight: 600, color: '#d8e4ee',
                      }}
                    >
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {s.name}
                      </span>
                      {s.id === AUTOSAVE_ID && (
                        <span
                          style={{
                            fontSize: 9, letterSpacing: '0.1em',
                            padding: '1px 6px', borderRadius: 3,
                            border: '1px solid #4ecdc4', color: '#4ecdc4',
                          }}
                        >AUTO</span>
                      )}
                    </div>
                    <div style={{ fontSize: 10, color: '#b8c8d6', marginTop: 2 }}>
                      T+{s.currentTick} · {s.playerShipCount} ships · {s.playerSettlementCount} settlements · {formatBytes(s.bytes)} · {formatSavedAt(s.savedAt)}
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 4 }}>
                    {mode === 'load' && (
                      <button
                        onClick={() => handleLoad(s.id)}
                        disabled={busyId === s.id}
                        style={{
                          padding: '5px 10px',
                          background: '#4ecdc4', color: '#0a1018',
                          border: 'none', borderRadius: 3, cursor: 'pointer',
                          fontFamily: 'inherit', fontSize: 10, fontWeight: 700, letterSpacing: '0.08em',
                        }}
                      >LOAD</button>
                    )}
                    {mode === 'save' && (
                      <button
                        onClick={() => handleOverwrite(s.id)}
                        disabled={busyId === s.id || !currentState}
                        style={{
                          padding: '5px 10px',
                          background: 'transparent', color: '#ffb84d',
                          border: '1px solid #ffb84d', borderRadius: 3, cursor: 'pointer',
                          fontFamily: 'inherit', fontSize: 10, fontWeight: 600, letterSpacing: '0.08em',
                        }}
                      >OVERWRITE</button>
                    )}
                    <button
                      onClick={() => handleExport(s.id)}
                      title="Download as JSON"
                      aria-label="Export"
                      style={{
                        width: 28, height: 28,
                        background: 'transparent', color: '#b8c8d6',
                        border: '1px solid #2a3d50', borderRadius: 3, cursor: 'pointer',
                      }}
                    >⤓</button>
                    <button
                      onClick={() => handleDelete(s.id)}
                      title="Delete save"
                      aria-label="Delete"
                      style={{
                        width: 28, height: 28,
                        background: 'transparent', color: '#ff5e5e',
                        border: '1px solid #ff5e5e', borderRadius: 3, cursor: 'pointer',
                      }}
                    >✕</button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        <footer
          style={{
            padding: '10px 18px',
            borderTop: '1px solid #2a3d50',
            fontSize: 10, color: '#b8c8d6',
          }}
        >
          Saves are stored in your browser ({saves.length} / ~10 fit). Export to JSON for backup.
        </footer>
      </div>
    </div>,
    document.body,
  );
};
