// ============================================================
// CaptainAvatar — code-shipped SVG portraits (DESIGN-captains §4).
// 12 generic busts built from a shared frame with per-id variation
// (helmet shape, visor, skin/suit tones). No uploads (cost +
// moderation surface); faction-tintable via `tint`. Placeholder
// quality by design — Lorne is authoring final art; the contract is
// "render avatar id N at size S".
// ============================================================

import React from 'react';

interface Props {
  avatarId?: string | null;
  size?: number;
  /** Faction accent for the suit collar. Defaults to neutral steel. */
  tint?: string;
}

// Per-id palette + geometry knobs. Index = a1..a12.
const VARIANTS: Record<string, { skin: string; suit: string; visor: boolean; hair: string; dome: boolean }> = {
  a1:  { skin: '#d9a066', suit: '#3a4a5a', visor: false, hair: '#2b2b2b', dome: false },
  a2:  { skin: '#8d5524', suit: '#44405e', visor: false, hair: '#101010', dome: false },
  a3:  { skin: '#f1c27d', suit: '#3f5747', visor: false, hair: '#7a4b21', dome: false },
  a4:  { skin: '#c68642', suit: '#5a3a3a', visor: false, hair: '#3a2a18', dome: false },
  a5:  { skin: '#ffdbac', suit: '#37474f', visor: false, hair: '#b0b0b0', dome: false },
  a6:  { skin: '#a1665e', suit: '#4a3a5a', visor: false, hair: '#1a1a2a', dome: false },
  a7:  { skin: '#d9a066', suit: '#2f4550', visor: true,  hair: '#2b2b2b', dome: true  },
  a8:  { skin: '#8d5524', suit: '#4f3a2a', visor: true,  hair: '#101010', dome: true  },
  a9:  { skin: '#f1c27d', suit: '#3a3a3a', visor: true,  hair: '#5a3a1a', dome: true  },
  a10: { skin: '#c68642', suit: '#2a4a4a', visor: true,  hair: '#2a1a0a', dome: true  },
  a11: { skin: '#ffdbac', suit: '#5a4a2a', visor: true,  hair: '#e0e0e0', dome: true  },
  a12: { skin: '#a1665e', suit: '#3a2f45', visor: true,  hair: '#0a0a1a', dome: true  },
};

export const CaptainAvatar: React.FC<Props> = ({ avatarId, size = 24, tint = '#4ecdc4' }) => {
  const v = VARIANTS[avatarId ?? ''] ?? VARIANTS.a1;
  return (
    <svg
      width={size} height={size} viewBox="0 0 32 32" aria-hidden
      style={{ borderRadius: 4, background: '#0d1420', border: '1px solid #22303f', flexShrink: 0 }}
    >
      {/* suit shoulders */}
      <path d="M4 32 Q4 22 16 22 Q28 22 28 32 Z" fill={v.suit} />
      {/* collar accent in faction tint */}
      <path d="M9 32 Q9 25 16 25 Q23 25 23 32 Z" fill="none" stroke={tint} strokeWidth={1.4} />
      {/* head */}
      <circle cx={16} cy={13} r={7} fill={v.skin} />
      {/* hair / helmet dome */}
      {v.dome
        ? <path d="M8 13 a8 8 0 0 1 16 0 l-1.5 0 a6.5 6.5 0 0 0 -13 0 Z" fill={v.suit} />
        : <path d="M9.2 11 a7 7 0 0 1 13.6 0 q-3 -3.4 -6.8 -3.4 q-3.8 0 -6.8 3.4 Z" fill={v.hair} />}
      {/* visor or eyes */}
      {v.visor
        ? <rect x={10.5} y={11} width={11} height={4.4} rx={2.2} fill="#0a0e14" opacity={0.85} />
        : (
          <>
            <circle cx={13.2} cy={13} r={1} fill="#0a0e14" />
            <circle cx={18.8} cy={13} r={1} fill="#0a0e14" />
          </>
        )}
    </svg>
  );
};
