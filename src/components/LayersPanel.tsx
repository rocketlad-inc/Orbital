// ============================================================
// LayersPanel — small floating button on the map with a popover
// of toggle switches for each visual overlay.
//
// Sits on the left edge below the Outliner toggle (or top-left
// corner on mobile). Click → popover shows every layer in
// LAYER_META with a checkbox + one-line description. Toggles
// flip the layer immediately via the MapLayersProvider.
//
// State persists to localStorage so a player's preferred overlay
// loadout (e.g. always show ownership + sensors) survives a refresh.
// ============================================================

import React, { useEffect, useRef, useState } from 'react';
import { useMapLayers, LAYER_META } from '../state/mapLayers';

export const LayersPanel: React.FC = () => {
  const { isOn, toggle } = useMapLayers();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // Close on outside click. Esc also closes.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const onCount = LAYER_META.reduce((n, m) => n + (isOn(m.id) ? 1 : 0), 0);

  return (
    <div
      ref={rootRef}
      style={{
        position: 'fixed',
        left: 12,
        top: 80,         // below top bar
        zIndex: 1100,
        fontFamily: "'JetBrains Mono', monospace",
      }}
    >
      <button
        onClick={() => setOpen(v => !v)}
        title={`Map layers (${onCount} on)`}
        aria-label="Toggle map layers"
        data-tutorial-id="layers-button"
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 6,
          padding: '6px 10px',
          background: open ? '#4ecdc4' : 'rgba(7, 11, 19, 0.85)',
          color: open ? '#0a1018' : '#4ecdc4',
          border: '1px solid #4ecdc4',
          borderRadius: 4,
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: '0.08em',
          cursor: 'pointer',
          backdropFilter: 'blur(4px)',
        }}
      >
        <span>▦ LAYERS</span>
        {onCount > 0 && (
          <span
            style={{
              minWidth: 16,
              height: 16,
              padding: '0 4px',
              borderRadius: 8,
              fontSize: 9,
              background: open ? '#0a1018' : '#4ecdc4',
              color: open ? '#4ecdc4' : '#0a1018',
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            }}
          >{onCount}</span>
        )}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Map layers"
          style={{
            position: 'absolute',
            left: 0,
            top: 'calc(100% + 6px)',
            width: 260,
            background: 'linear-gradient(180deg, #131c27 0%, #070b13 100%)',
            border: '1px solid #4ecdc4',
            borderRadius: 6,
            padding: '8px 10px',
            color: '#d8e4ee',
            boxShadow: '0 10px 28px rgba(0, 0, 0, 0.55)',
          }}
        >
          <div
            style={{
              fontSize: 10,
              letterSpacing: '0.12em',
              color: '#4ecdc4',
              marginBottom: 6,
            }}
          >MAP LAYERS</div>

          {LAYER_META.map(m => {
            const on = isOn(m.id);
            return (
              <label
                key={m.id}
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 8,
                  padding: '6px 4px',
                  cursor: 'pointer',
                  borderTop: '1px solid #2a3d50',
                }}
              >
                <input
                  type="checkbox"
                  checked={on}
                  onChange={() => toggle(m.id)}
                  style={{
                    marginTop: 2,
                    width: 14,
                    height: 14,
                    cursor: 'pointer',
                    accentColor: '#4ecdc4',
                  }}
                />
                <span style={{ flex: 1 }}>
                  <span style={{
                    fontSize: 11,
                    fontWeight: 600,
                    color: on ? '#4ecdc4' : '#d8e4ee',
                  }}>
                    {m.label}
                  </span>
                  <span style={{
                    display: 'block',
                    fontSize: 9,
                    color: '#b8c8d6',
                    marginTop: 2,
                    lineHeight: 1.3,
                  }}>{m.description}</span>
                </span>
              </label>
            );
          })}

          <div
            style={{
              fontSize: 9,
              color: '#b8c8d6',
              fontStyle: 'italic',
              marginTop: 6,
              borderTop: '1px solid #2a3d50',
              paddingTop: 6,
            }}
          >
            Preferences saved to this browser.
          </div>
        </div>
      )}
    </div>
  );
};
