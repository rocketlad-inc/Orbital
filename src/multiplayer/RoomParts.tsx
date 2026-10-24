// ============================================================
// RoomParts — the small pieces the room lobby's cards share: icons, the
// flag tile, and the one-line note that opens when tapped.
// ============================================================

import React, { useState } from 'react';
import { FlagChip } from '../components/FactionEmblem';
import { t } from '../i18n/core';
import { useI18n } from '../i18n/react';

type IconProps = { className?: string };
const svgProps = {
  viewBox: '0 0 24 24', 'aria-hidden': true, focusable: false,
} as const;

export const IconBack = ({ className }: IconProps) => (
  <svg {...svgProps} className={className}><path d="M15 5l-7 7 7 7" /></svg>
);
export const IconDots = ({ className }: IconProps) => (
  <svg {...svgProps} className={className}>
    <circle cx="5" cy="12" r="1.3" /><circle cx="12" cy="12" r="1.3" /><circle cx="19" cy="12" r="1.3" />
  </svg>
);
export const IconDotsV = ({ className }: IconProps) => (
  <svg {...svgProps} className={className}>
    <circle cx="12" cy="5" r="1.3" /><circle cx="12" cy="12" r="1.3" /><circle cx="12" cy="19" r="1.3" />
  </svg>
);
export const IconChevron = ({ className }: IconProps) => (
  <svg {...svgProps} className={className}><path d="M9 6l6 6-6 6" /></svg>
);
export const IconLock = ({ className }: IconProps) => (
  <svg {...svgProps} className={className}><rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 018 0v3" /></svg>
);
export const IconCheck = ({ className }: IconProps) => (
  <svg {...svgProps} className={className}><path d="M5 12l5 5 9-10" /></svg>
);
export const IconDash = ({ className }: IconProps) => (
  <svg {...svgProps} className={className}><path d="M6 12h12" /></svg>
);
export const IconAlert = ({ className }: IconProps) => (
  <svg {...svgProps} className={className}><path d="M12 6v7M12 17v.5" /></svg>
);
export const IconSliders = ({ className }: IconProps) => (
  <svg {...svgProps} className={className}>
    <path d="M4 7h10M18 7h2M4 17h2M10 17h10" /><circle cx="16" cy="7" r="2" /><circle cx="8" cy="17" r="2" />
  </svg>
);
export const IconDiscord = ({ className }: IconProps) => (
  <svg {...svgProps} className={className}>
    <path d="M5 6c2-1 4-1.5 7-1.5S17 5 19 6c1.5 3 2 6 1.5 10-1.5 1-3 1.6-4.5 2l-1-2c-1 .3-2 .4-3 .4s-2-.1-3-.4l-1 2c-1.5-.4-3-1-4.5-2C3 12 3.5 9 5 6z" />
    <circle cx="9.5" cy="12" r="1.2" /><circle cx="14.5" cy="12" r="1.2" />
  </svg>
);
export const IconChat = ({ className }: IconProps) => (
  <svg {...svgProps} className={className}><path d="M4 5h16v11H9l-5 4z" /></svg>
);
export const IconPanel = ({ className }: IconProps) => (
  <svg {...svgProps} className={className}><rect x="3.5" y="4.5" width="17" height="15" rx="2.5" /><path d="M14.5 4.5v15" /></svg>
);
export const IconX = ({ className }: IconProps) => (
  <svg {...svgProps} className={className}><path d="M6 6l12 12M18 6L6 18" /></svg>
);

/** Read by screen readers only. */
export const SrOnly = ({ children }: { children: React.ReactNode }) => (
  <span className="rl-sr">{children}</span>
);

/**
 * A player's flag as a tile. Until they have picked a colour there is nothing
 * to draw, and "not chosen yet" is itself useful, so the tile is an empty
 * dashed outline rather than a placeholder grey that looks like a choice.
 */
export function RoomFlag({ color, color2, emblem, fallbackKey, size, className }: {
  color: string | null;
  color2?: string | null;
  emblem?: string | null;
  fallbackKey: string;
  size: number;
  className?: string;
}) {
  if (!color) {
    return <span className={`rl-flag rl-flag--none ${className ?? ''}`} style={{ width: size, height: size }} aria-hidden="true" />;
  }
  return (
    <FlagChip
      className={`rl-flag ${className ?? ''}`}
      color={color} color2={color2} emblem={emblem}
      fallbackKey={fallbackKey} size={size}
      style={{ borderRadius: Math.round(size / 5), overflow: 'hidden' }}
    />
  );
}

/**
 * Player-written text kept to a line (or `lines`) until it is tapped, then
 * shown whole. A real button so it works from the keyboard; the tap target is
 * widened past the text with a pseudo-element so it costs no row height.
 */
export function ClampText({ text, lines = 1, className }: { text: string; lines?: number; className?: string }) {
  useI18n();
  const [open, setOpen] = useState(false);
  return (
    <button
      type="button"
      className={`rl-clamp ${open ? 'is-open' : ''} ${className ?? ''}`}
      style={{ ['--rl-lines' as string]: lines }}
      aria-expanded={open}
      title={open ? t('roomlobby.less') : t('roomlobby.more')}
      onClick={() => setOpen((o) => !o)}
    >
      {text}
    </button>
  );
}
