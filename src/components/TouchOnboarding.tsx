// ============================================================
// TouchOnboarding — one-time overlay shown on first touch
// session teaching the gesture vocabulary. Dismissed by tap;
// won't re-appear after dismissal (localStorage flag).
// ============================================================

import React, { useEffect, useState } from 'react';
import { useIsMobile } from '../hooks/useIsMobile';

const STORAGE_KEY = 'orbital.touch_onboarding_seen.v1';

export const TouchOnboarding: React.FC = () => {
  const isMobile = useIsMobile();
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (!isMobile) return;
    try {
      if (localStorage.getItem(STORAGE_KEY) === '1') return;
    } catch { /* localStorage might be unavailable */ }
    // Small delay so the overlay doesn't fight the initial layout flash.
    const t = setTimeout(() => setShow(true), 400);
    return () => clearTimeout(t);
  }, [isMobile]);

  const dismiss = () => {
    try { localStorage.setItem(STORAGE_KEY, '1'); } catch { /* */ }
    setShow(false);
  };

  if (!show) return null;

  return (
    <div
      onClick={dismiss}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9000,
        background: 'rgba(5, 8, 12, 0.86)',
        backdropFilter: 'blur(6px)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '24px',
        fontFamily: "'JetBrains Mono', monospace",
        color: '#d8e4ee',
        animation: 'fadeIn 0.3s ease',
      }}
    >
      <div style={{
        maxWidth: 360,
        width: '100%',
        background: '#0e1620',
        border: '1px solid #2a3d50',
        borderRadius: 6,
        padding: '22px 20px',
        boxShadow: '0 8px 32px rgba(0, 0, 0, 0.5)',
      }}>
        <div style={{
          fontSize: 16, fontWeight: 700, color: '#ffb84d',
          letterSpacing: '0.12em', marginBottom: 4,
          fontFamily: "'Orbitron', 'JetBrains Mono', monospace",
        }}>
          TOUCH CONTROLS
        </div>
        <div style={{ fontSize: 10, color: '#6b8195', marginBottom: 18, letterSpacing: '0.08em' }}>
          Drag · pinch · tap
        </div>

        <Gesture
          icon="👆"
          title="Tap"
          desc="Select a ship, planet, or settlement."
        />
        <Gesture
          icon="👆👆"
          title="Double-tap"
          desc="Focus the camera on a body and follow it."
        />
        <Gesture
          icon="✋"
          title="Drag (one finger)"
          desc="Pan the map around."
        />
        <Gesture
          icon="🤏"
          title="Pinch (two fingers)"
          desc="Zoom in and out around the gesture center."
        />

        <button
          onClick={dismiss}
          style={{
            marginTop: 20,
            width: '100%',
            padding: '14px',
            background: 'rgba(78, 205, 196, 0.15)',
            border: '1px solid #4ecdc4',
            borderRadius: 4,
            color: '#4ecdc4',
            fontFamily: 'inherit',
            fontSize: 12,
            letterSpacing: '0.15em',
            fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          GOT IT
        </button>
      </div>
    </div>
  );
};

const Gesture: React.FC<{ icon: string; title: string; desc: string }> = ({ icon, title, desc }) => (
  <div style={{
    display: 'flex',
    alignItems: 'center',
    gap: 14,
    padding: '10px 0',
    borderBottom: '1px solid rgba(42, 61, 80, 0.5)',
  }}>
    <div style={{ fontSize: 22, width: 44, textAlign: 'center', flexShrink: 0 }}>
      {icon}
    </div>
    <div style={{ flex: 1, minWidth: 0 }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: '#d8e4ee', marginBottom: 2 }}>
        {title}
      </div>
      <div style={{ fontSize: 10, color: '#8aa0b4', lineHeight: 1.4 }}>
        {desc}
      </div>
    </div>
  </div>
);
