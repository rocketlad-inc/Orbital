// ============================================================
// TutorialPromptModal — "first game ever? take the tour?"
//
// Fires once per browser. After the player picks either button
// (Yes or No), the tutorial.completed flag is set so the modal
// never auto-fires again. Players can replay later via the
// "Restart Tutorial" entry in the SideMenu.
//
// Rendered inside GameUI so it only appears once the player is
// actually in a game — landing pages and the auth flow don't
// need to bother them.
// ============================================================

import React from 'react';
import { createPortal } from 'react-dom';
import { useTutorial } from '../state/tutorial';

export const TutorialPromptModal: React.FC = () => {
  const { completed, active, start, skip } = useTutorial();
  // Suppression rules:
  //  - already completed → never show
  //  - tour is active right now → never show (overlay handles UI)
  //  - completed via "no thanks" earlier → completed=true so we skip
  if (completed || active) return null;

  return createPortal(
    <div
      role="dialog"
      aria-label="Take the tutorial?"
      style={{
        position: 'fixed', inset: 0, zIndex: 2900,
        background: 'rgba(5, 8, 14, 0.78)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontFamily: 'var(--font-body)',
      }}
    >
      <div
        style={{
          width: 'min(440px, 92vw)',
          background: 'linear-gradient(180deg, #131c27 0%, #070b13 100%)',
          border: '1px solid #ffb84d',
          borderRadius: 8,
          padding: '20px 22px',
          color: '#d8e4ee',
          boxShadow: '0 16px 40px rgba(0, 0, 0, 0.6)',
        }}
      >
        <div style={{ fontSize: 10, letterSpacing: '0.16em', color: '#b8c8d6', marginBottom: 4 }}>
          WELCOME, COMMANDER
        </div>
        <div style={{ fontSize: 20, fontWeight: 700, color: '#ffb84d', marginBottom: 12 }}>
          New to Orbital?
        </div>
        <div style={{ fontSize: 13, lineHeight: 1.5, color: '#d8e4ee', marginBottom: 18 }}>
          We can walk you through the menus, the map, and the main
          flows — transfers, building, settlements, research.
          Takes about a minute. You can skip any time.
        </div>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button
            onClick={skip}
            style={{
              padding: '8px 16px',
              background: 'transparent', color: '#b8c8d6',
              border: '1px solid #2a3d50', borderRadius: 4, cursor: 'pointer',
              fontFamily: 'inherit', fontSize: 12, letterSpacing: '0.08em',
            }}
          >NO THANKS</button>
          <button
            onClick={start}
            style={{
              padding: '8px 18px',
              background: '#ffb84d', color: '#0a1018',
              border: 'none', borderRadius: 4, cursor: 'pointer',
              fontFamily: 'inherit', fontSize: 12, fontWeight: 700, letterSpacing: '0.08em',
            }}
          >▶ SHOW ME</button>
        </div>
      </div>
    </div>,
    document.body,
  );
};
